import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron"
import type { AppSettings, PlayerState, Rating, Track } from "../shared/types.ts"
import { authState, logout } from "./youtube/auth.ts"
import { openLogin } from "./window.ts"
import { innertube } from "./youtube/innertube.ts"
import { appendBrowseItems, parseBrowseFeed, parseBrowsePage, parseQueueTracks } from "./youtube/parser.ts"
import { clearPlayerCaches, resolvePlayer, resolveMusicTrack, PlayerFailure } from "./youtube/player.ts"
import { trackHistory, flushHistory } from "./youtube/history.ts"
import { rate, addToPlaylist, createPlaylist, deletePlaylist, subscribe } from "./youtube/sync.ts"
import { getSettings, updateSettings } from "./storage/settings.ts"
import { cacheClear, cacheGet, cacheSet } from "./storage/cache.ts"
import { lyricsProviderInfo, lookupLyrics } from "./lyrics/engine.ts"
import { updateTray } from "./tray.ts"

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

const MAX_CONTINUATIONS = 100

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
    cacheClear()
    return authState()
  })

  ipcMain.handle("yt:browse", async (_event, input) => {
    const { browseId } = record(input)
    const id = text(browseId, "browseId", 200)
    const key = `browse:${id}`
    const cached = cacheGet(key)
    if (cached) return cached
    const json = await innertube("browse", { browseId: id })
    const feed = parseBrowseFeed(json, id)
    const page = feed.page
    if (pagedCollection(id)) {
      const seen = new Set<string>()
      let continuation = feed.continuation
      while (continuation && !seen.has(continuation) && seen.size < MAX_CONTINUATIONS) {
        seen.add(continuation)
        const chunk = parseBrowseFeed(await innertube("browse", { continuation }), id)
        appendBrowseItems(page, chunk.page.shelves.flatMap((shelf) => shelf.items), feed.trackListIndex)
        continuation = chunk.continuation
      }
    }
    if (page.shelves.length === 0) throw new Error("This page returned no playable content")
    return cacheSet(key, page, 2 * 60 * 1000)
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
    return cacheSet(key, page, 5 * 60 * 1000)
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
    return cacheSet(key, tracks, 10 * 60 * 1000)
  })

  ipcMain.handle("yt:musicTrack", async (_event, input) => {
    const { videoId } = record(input)
    const id = text(videoId, "videoId", 32)
    return await resolveMusicTrack(id)
  })

  ipcMain.handle("yt:player", async (_event, input) => {
    const { videoId } = record(input)
    const id = text(videoId, "videoId", 32)
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

  ipcMain.handle("yt:like", async (_event, input) => {
    const { videoId, rating } = record(input)
    const id = text(videoId, "videoId", 32)
    if (rating !== "like" && rating !== "dislike" && rating !== "none") throw new Error("Invalid rating")
    await rate(id, rating as Rating)
    cacheClear("browse:")
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
    return lookupLyrics(
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
    if (input.quality === "high" || input.quality === "normal") next.quality = input.quality
    if (typeof input.lowMemory === "boolean") next.lowMemory = input.lowMemory
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
    if (typeof input.lastPosition === "number" && Number.isFinite(input.lastPosition)) {
      next.lastPosition = Math.max(0, input.lastPosition)
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
