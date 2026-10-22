import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron"
import type {
  AppSettings,
  BrowseChunk,
  BrowsePage,
  PinnedPlaylist,
  PlayerState,
  Rating,
  Track,
} from "../shared/types.ts"
import { normalizeSearchHistory } from "../shared/search-history.ts"
import { authState, getScope, logout } from "./youtube/auth.ts"
import { openLogin } from "./window.ts"
import { innertube } from "./youtube/innertube.ts"
import { parseBrowseFeed, parseBrowsePage, parseQueueTracks } from "./youtube/parser.ts"
import { clearPlayerCaches, resolvePlayer, resolveMusicTrack, PlayerFailure } from "./youtube/player.ts"
import { trackHistory, flushHistory } from "./youtube/history.ts"
import { rate, getRating, addToPlaylist, createPlaylist, deletePlaylist, movePlaylistItem, renamePlaylist, subscribe } from "./youtube/sync.ts"
import { flushSettings, getSettings, updateSettings } from "./storage/settings.ts"
import { cacheClear, cacheGet, cacheSet, cacheTrim } from "./storage/cache.ts"
import { lyricsProviderInfo, lookupLyrics } from "./lyrics/engine.ts"
import {
  cacheLyricsForDownload,
  downloadedDecision,
  listDownloads,
  localLyrics,
  removeDownload,
  startDownload,
} from "./downloads.ts"
import { updateTray } from "./tray.ts"
import { importSpotifyPlaylist } from "./spotify/importer.ts"

function text(value: unknown, name: string, max = 2048): string {
  if (typeof value !== "string" || !value.length || value.length > max) throw new Error(`Invalid ${name}`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payload")
  return value as Record<string, unknown>
}

/** Album and playlist browse IDs return track lists in ~100-item chunks. */
function pagedCollection(browseId: string): boolean {
  return browseId.startsWith("VL") || browseId.startsWith("MPRE")
}

function pageCost(page: BrowsePage): number {
  return page.shelves.reduce((total, shelf) => total + shelf.items.length, 0)
}

const COLLECTION_TTL_MS = 20 * 60 * 1000
const BROWSE_TTL_MS = 2 * 60 * 1000
const CHUNK_TTL_MS = 10 * 60 * 1000

const browseInflight = new Map<string, Promise<BrowsePage>>()
const chunkInflight = new Map<string, Promise<BrowseChunk>>()
const spotifyJobs = new Map<string, AbortController>()

async function loadBrowsePage(id: string): Promise<BrowsePage> {
  const json = await innertube("browse", { browseId: id })
  const feed = parseBrowseFeed(json, id)
  const paged = pagedCollection(id)
  const page: BrowsePage = {
    ...feed.page,
    continuation: paged ? feed.continuation : null,
    trackListIndex: feed.trackListIndex,
  }
  // Playlists and albums can legitimately be empty (and YouTube may not return
  // a header for a brand-new playlist yet). Keep the page so the renderer can
  // show an empty state with "Add songs" instead of an error.
  if (page.shelves.length === 0 && !paged) {
    throw new Error("This page returned no playable content")
  }
  const ttl = page.shelves.length === 0 ? BROWSE_TTL_MS : paged ? COLLECTION_TTL_MS : BROWSE_TTL_MS
  return cacheSet(`browse:${id}`, page, ttl, pageCost(page))
}

/** Next slice of a paged album/playlist. The renderer appends these as the user scrolls. */
async function loadBrowseChunk(id: string, token: string): Promise<BrowseChunk> {
  const key = `browseMore:${token}`
  const cached = cacheGet<BrowseChunk>(key)
  if (cached) return cached

  const existing = chunkInflight.get(key)
  if (existing) return existing

  const promise = (async () => {
    const json = await innertube("browse", { continuation: token })
    const feed = parseBrowseFeed(json, id)
    const items = feed.page.shelves.flatMap((shelf) => shelf.items)
    if (!items.length && !feed.continuation) throw new Error("No more songs")
    const chunk: BrowseChunk = { items, continuation: feed.continuation }
    return cacheSet(key, chunk, CHUNK_TTL_MS, items.length)
  })().finally(() => chunkInflight.delete(key))

  chunkInflight.set(key, promise)
  return promise
}

export function registerIpc(): void {
  ipcMain.handle("sys:windowMinimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle("sys:windowToggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle("sys:windowMaximized", (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
  ipcMain.handle("sys:windowQuit", () => app.quit())

  ipcMain.handle("yt:authState", () => authState())

  ipcMain.handle("yt:login", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) throw new Error("No window")
    return openLogin(parent)
  })

  ipcMain.handle("yt:logout", async () => {
    await logout()
    clearPlayerCaches()
    flushHistory()
    flushSettings()
    cacheClear()
    return authState()
  })

  ipcMain.handle("yt:browse", async (_event, input) => {
    const { browseId } = record(input)
    const id = text(browseId, "browseId", 200)
    const key = `browse:${id}`
    const cached = cacheGet<BrowsePage>(key)
    if (cached) return cached

    const existing = browseInflight.get(key)
    if (existing) return existing

    const promise = loadBrowsePage(id).finally(() => browseInflight.delete(key))
    browseInflight.set(key, promise)
    return promise
  })

  ipcMain.handle("yt:browseMore", async (_event, input) => {
    const { browseId, cursor } = record(input)
    const id = text(browseId, "browseId", 200)
    const token = text(cursor, "cursor", 16_384)
    return loadBrowseChunk(id, token)
  })

  ipcMain.handle("yt:search", async (_event, input) => {
    const { query } = record(input)
    const q = text(query, "query", 200).trim()
    if (!q) throw new Error("Empty search")
    const key = `search:${q.toLowerCase()}`
    const cached = cacheGet(key)
    if (cached) return cached
    // Search stays anonymous: no query history on the account (DOC §8.3).
    const filters = [
      { label: "Artists", params: "EgWKAQIgAWoKEAkQBRAKEAMQBA%3D%3D" },
      { label: "Songs", params: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D" },
      { label: "Albums", params: "EgWKAQIYAWoKEAkQBRAKEAMQBA%3D%3D" },
      { label: "Playlists", params: "EgWKAQIoAWoKEAkQBRAKEAMQBA%3D%3D" },
    ]
    const pages = await Promise.all(
      filters.map(async (filter) => {
        const json = await innertube("search", { query: q, params: filter.params }, { signed: false })
        return parseBrowsePage(json, filter.label)
      }),
    )
    const page = {
      title: `Results for “${q}”`,
      shelves: pages.flatMap((result) => result.shelves),
    }
    return cacheSet(key, page, 5 * 60 * 1000, pageCost(page))
  })

  ipcMain.handle("yt:radio", async (_event, input) => {
    const { videoId } = record(input)
    const id = text(videoId, "videoId", 32)
    const musicId = await resolveMusicTrack(id)
    const key = `radio:${musicId}`
    const cached = cacheGet(key)
    if (cached) return cached
    const json = await innertube("next", { videoId: musicId, playlistId: `RDAMVM${musicId}` })
    const tracks = parseQueueTracks(json)
    if (!tracks.length) throw new Error("No autoplay songs found")
    return cacheSet(key, tracks, 10 * 60 * 1000, tracks.length)
  })

  ipcMain.handle("yt:musicTrack", async (_event, input) => {
    const { videoId } = record(input)
    const id = text(videoId, "videoId", 32)
    return await resolveMusicTrack(id)
  })

  ipcMain.handle("downloads:list", () => listDownloads())

  ipcMain.handle("downloads:start", async (_event, input) => {
    const { track } = record(input)
    const value = record(track)
    const videoId = text(value.videoId, "videoId", 32)
    const title = text(value.title, "title", 300)
    const subtitle = typeof value.subtitle === "string" ? value.subtitle.slice(0, 500) : ""
    const duration = Number(value.duration)
    const thumbnail =
      typeof value.thumbnail === "string" && value.thumbnail.startsWith("https://") ? value.thumbnail : null
    const artists = Array.isArray(value.artists)
      ? value.artists
          .filter(
            (entry): entry is { name: string; id: string | null } =>
              Boolean(entry) &&
              typeof entry === "object" &&
              typeof (entry as Record<string, unknown>).name === "string",
          )
          .slice(0, 20)
          .map((entry) => ({
            name: entry.name.slice(0, 300),
            id: typeof entry.id === "string" ? entry.id.slice(0, 64) : null,
          }))
      : []
    const albumValue = value.album
    const album =
      albumValue && typeof albumValue === "object"
        ? {
            name:
              typeof (albumValue as Record<string, unknown>).name === "string"
                ? ((albumValue as Record<string, unknown>).name as string).slice(0, 300)
                : "",
            id:
              typeof (albumValue as Record<string, unknown>).id === "string"
                ? ((albumValue as Record<string, unknown>).id as string).slice(0, 64)
                : null,
          }
        : null
    const trackInput: Track = {
      kind: "track",
      id: videoId,
      videoId,
      title,
      subtitle,
      thumbnail,
      duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
      artists,
      album: album?.name ? album : null,
      year: typeof value.year === "string" ? value.year.slice(0, 20) : null,
      musicVideoType: typeof value.musicVideoType === "string" ? value.musicVideoType.slice(0, 80) : null,
    }
    return startDownload(trackInput)
  })

  ipcMain.handle("downloads:remove", async (_event, input) => {
    const { videoId } = record(input)
    return removeDownload(text(videoId, "videoId", 32))
  })

  ipcMain.handle("yt:player", async (_event, input) => {
    const { videoId } = record(input)
    const id = text(videoId, "videoId", 32)
    const local = downloadedDecision(id)
    if (local) return local
    try {
      return await resolvePlayer(id, (await authState()).signedIn)
    } catch (error) {
      if (error instanceof PlayerFailure) {
        const suffix = error.permanent ? "" : " (temporary — try again)"
        throw new Error(`${error.message}${suffix}`)
      }
      throw error
    }
  })

  ipcMain.handle("yt:likeStatus", async (_event, input) => {
    const { videoId } = record(input)
    return getRating(text(videoId, "videoId", 32))
  })

  ipcMain.handle("yt:like", async (_event, input) => {
    const { videoId, rating } = record(input)
    const id = text(videoId, "videoId", 32)
    if (rating !== "like" && rating !== "dislike" && rating !== "none") throw new Error("Invalid rating")
    await rate(id, rating as Rating)
    // Only the library and Liked Music page change. Wiping every paginated
    // playlist cache here would force a full re-walk on the next visit.
    cacheClear("browse:FEmusic_library")
    cacheClear("browse:VLLM")
    cacheClear("browse:LM")
  })

  ipcMain.handle("yt:playlistCreate", async (_event, input) => {
    const { title, videoId } = record(input)
    const name = text(title, "title", 150).trim()
    if (!name) throw new Error("Empty playlist title")
    const id = await createPlaylist(name, videoId === undefined ? undefined : text(videoId, "videoId", 32))
    cacheClear("browse:")
    return id
  })

  ipcMain.handle("yt:playlistAdd", async (_event, input) => {
    const { playlistId, videoId } = record(input)
    await addToPlaylist(text(playlistId, "playlistId", 200), text(videoId, "videoId", 32))
    cacheClear("browse:")
  })

  ipcMain.handle("yt:playlistDelete", async (_event, input) => {
    const { playlistId } = record(input)
    await deletePlaylist(text(playlistId, "playlistId", 200))
    cacheClear("browse:")
  })

  ipcMain.handle("yt:playlistRename", async (_event, input) => {
    const { playlistId, title } = record(input)
    const name = text(title, "title", 150).trim()
    if (!name) throw new Error("Empty playlist title")
    await renamePlaylist(text(playlistId, "playlistId", 200), name)
    cacheClear("browse:")
  })

  ipcMain.handle("yt:playlistMove", async (_event, input) => {
    const { playlistId, setVideoId, predecessorSetVideoId, successorSetVideoId } = record(input)
    const predecessor =
      predecessorSetVideoId === undefined || predecessorSetVideoId === null
        ? null
        : text(predecessorSetVideoId, "predecessorSetVideoId", 200)
    const successor =
      successorSetVideoId === undefined || successorSetVideoId === null
        ? null
        : text(successorSetVideoId, "successorSetVideoId", 200)
    if (!predecessor && !successor) throw new Error("Invalid playlist position")
    await movePlaylistItem(
      text(playlistId, "playlistId", 200),
      text(setVideoId, "setVideoId", 200),
      predecessor,
      successor,
    )
    cacheClear("browse:")
  })

  ipcMain.handle("spotify:import", async (event, input) => {
    const { url, jobId } = record(input)
    const playlistUrl = text(url, "url", 2048)
    const job = text(jobId, "jobId", 100)
    if (!getScope()) throw new Error("Sign in to YouTube Music to import a playlist.")
    if (spotifyJobs.has(job)) throw new Error("An import is already running.")

    const controller = new AbortController()
    spotifyJobs.set(job, controller)
    try {
      return await importSpotifyPlaylist(playlistUrl, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("spotify:progress", { ...progress, jobId: job })
          }
        },
      })
    } finally {
      spotifyJobs.delete(job)
    }
  })

  ipcMain.handle("spotify:cancel", (_event, input) => {
    const { jobId } = record(input)
    spotifyJobs.get(text(jobId, "jobId", 100))?.abort()
    return true
  })

  ipcMain.handle("yt:subscribe", async (_event, input) => {
    const { channelId, subscribed, params } = record(input)
    if (typeof subscribed !== "boolean") throw new Error("Invalid subscription state")
    await subscribe(
      text(channelId, "channelId", 64),
      subscribed,
      params === undefined || params === null ? null : text(params, "params", 512),
    )
    cacheClear("browse:")
  })

  ipcMain.handle("yt:history", async (_event, input) => {
    const event = record(input)
    if (event.event !== "start" && event.event !== "progress" && event.event !== "end") return
    const videoId = text(event.videoId, "videoId", 32)
    const position = Number(event.position)
    const duration = Number(event.duration)
    void trackHistory({
      videoId,
      event: event.event,
      position: Number.isFinite(position) ? Math.max(0, position) : 0,
      duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    })
  })

  ipcMain.handle("lyrics:providers", () => lyricsProviderInfo())

  ipcMain.handle("lyrics:get", async (_event, input) => {
    const payload = record(input)
    const videoId = text(payload.videoId, "videoId", 32)
    const title = text(payload.title, "title", 300).trim()
    const artist = text(payload.artist, "artist", 300).trim()
    const album =
      typeof payload.album === "string" && payload.album.length <= 300 ? payload.album.trim() : null
    const duration = Number(payload.durationMs)
    const durationMs = Number.isFinite(duration) ? Math.max(0, duration) : 0
    const isrc = typeof payload.isrc === "string" && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(payload.isrc) ? payload.isrc : null
    // Downloaded songs carry their own lyrics file, so the panel works offline
    // and does not depend on the in-memory provider cache.
    const offline = localLyrics(videoId)
    if (offline) return offline
    const result = await lookupLyrics(
      {
        videoId,
        title,
        artist,
        album,
        durationMs,
        isrc,
        retry: payload.retry === true,
      },
      getSettings(),
    )
    if (result) await cacheLyricsForDownload(videoId, result)
    return result
  })

  ipcMain.handle("lyrics:clearCache", () => {
    cacheClear("lyrics")
    return true
  })

  ipcMain.handle("sys:settingsGet", () => getSettings())

  ipcMain.handle("sys:settingsSet", (_event, patch) => {
    const input = record(patch) as Partial<AppSettings>
    const next: Partial<AppSettings> = {}
    let lyricsChanged = false
    if (typeof input.volume === "number") next.volume = Math.min(1, Math.max(0, input.volume))
    if (typeof input.volumeNormalization === "boolean") next.volumeNormalization = input.volumeNormalization
    if (input.quality === "high" || input.quality === "normal") next.quality = input.quality
    if (typeof input.lowMemory === "boolean") next.lowMemory = input.lowMemory
    if (typeof input.crossfadeEnabled === "boolean") next.crossfadeEnabled = input.crossfadeEnabled
    if (typeof input.crossfadeSeconds === "number" && Number.isFinite(input.crossfadeSeconds)) {
      next.crossfadeSeconds = Math.max(1, Math.min(10, Math.round(input.crossfadeSeconds)))
    }
    if (typeof input.gaplessEnabled === "boolean") next.gaplessEnabled = input.gaplessEnabled
    if (typeof input.historyEnabled === "boolean") next.historyEnabled = input.historyEnabled
    if (input.theme === "dark" || input.theme === "light" || input.theme === "system") next.theme = input.theme
    if (typeof input.lyricsEnabled === "boolean") {
      next.lyricsEnabled = input.lyricsEnabled
      lyricsChanged = true
    }
    if (Array.isArray(input.lyricsSources)) {
      next.lyricsSources = [
        ...new Set(
          input.lyricsSources.filter(
            (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80,
          ),
        ),
      ].slice(0, 32)
      lyricsChanged = true
    }
    if (typeof input.lyricsPreferSyllableTiming === "boolean") {
      next.lyricsPreferSyllableTiming = input.lyricsPreferSyllableTiming
      lyricsChanged = true
    }
    if (typeof input.lyricsOffsetMs === "number" && Number.isFinite(input.lyricsOffsetMs)) {
      next.lyricsOffsetMs = Math.max(-5000, Math.min(5000, Math.round(input.lyricsOffsetMs)))
      lyricsChanged = true
    }
    if (typeof input.lyricsRomanize === "boolean") next.lyricsRomanize = input.lyricsRomanize
    if (typeof input.lastPosition === "number" && Number.isFinite(input.lastPosition)) {
      next.lastPosition = Math.max(0, input.lastPosition)
    }
    if (Array.isArray(input.searchHistory)) {
      next.searchHistory = normalizeSearchHistory(input.searchHistory)
    }
    if (Array.isArray(input.pinnedPlaylists)) {
      const seen = new Set<string>()
      const pinned: PinnedPlaylist[] = []
      for (const entry of input.pinnedPlaylists) {
        if (pinned.length >= 50) break
        if (!entry || typeof entry !== "object") continue
        const { id, title, thumbnail } = entry as Record<string, unknown>
        if (typeof id !== "string" || !id.length || id.length > 200) continue
        if (typeof title !== "string" || !title.length || title.length > 300) continue
        if (thumbnail !== null && thumbnail !== undefined) {
          if (typeof thumbnail !== "string" || thumbnail.length > 1000 || !thumbnail.startsWith("https://")) continue
        }
        if (seen.has(id)) continue
        seen.add(id)
        pinned.push({ id, title, thumbnail: typeof thumbnail === "string" ? thumbnail : null })
      }
      next.pinnedPlaylists = pinned
    }
    if (input.lastTrack === null) {
      next.lastTrack = null
    } else if (
      input.lastTrack &&
      typeof input.lastTrack === "object" &&
      input.lastTrack.kind === "track" &&
      typeof input.lastTrack.id === "string" &&
      typeof input.lastTrack.title === "string" &&
      typeof input.lastTrack.videoId === "string"
    ) {
      next.lastTrack = input.lastTrack as Track
    }
    if (lyricsChanged) cacheClear("lyrics")
    if (next.lowMemory) cacheTrim()
    return updateSettings(next)
  })

  let blockerId: number | null = null
  ipcMain.handle("sys:playerState", (_event, input) => {
    const state = record(input) as unknown as PlayerState
    updateTray(state)
    if (state.playing && blockerId === null) {
      blockerId = powerSaveBlocker.start("prevent-app-suspension")
    } else if (!state.playing && blockerId !== null) {
      powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
    return true
  })
}
