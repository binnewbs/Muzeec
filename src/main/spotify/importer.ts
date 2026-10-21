import type {
  SpotifyImportProgress,
  SpotifyImportResult,
  SpotifyPlaylist,
  SpotifyTrack,
  SpotifyUnmatchedTrack,
} from "../../shared/types.ts"
import { extractPlaylistId, isSpotifyShortLink } from "../../shared/spotify.ts"
import { cacheClear, cacheGet, cacheSet } from "../storage/cache.ts"
import { getScope } from "../youtube/auth.ts"
import { innertube } from "../youtube/innertube.ts"
import { parseBrowsePage } from "../youtube/parser.ts"
import { addToPlaylistBatch, createPlaylist } from "../youtube/sync.ts"
import { candidateOf } from "./candidate.ts"
import { readEmbedPlaylist } from "./embed.ts"
import { ImportCancelled, isAborted } from "./http.ts"
import { matchTrack, normalizeKey, type MatchCandidate, type SpotifyMatch } from "./matcher.ts"
import { readFullPlaylist } from "./pathfinder.ts"

const SONG_FILTER = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"
const SEARCH_TTL_MS = 10 * 60 * 1000
const SEARCH_CONCURRENCY = 6
const ADD_BATCH_SIZE = 50

type ImportOptions = {
  signal?: AbortSignal
  onProgress: (progress: Omit<SpotifyImportProgress, "jobId">) => void
}

const searchInflight = new Map<string, Promise<MatchCandidate[]>>()

/** Search the songs-only filter anonymously; results are cached per query. */
async function searchSongs(query: string, signal?: AbortSignal): Promise<MatchCandidate[]> {
  if (isAborted(signal)) throw new ImportCancelled()
  const key = `spotifySearch:${query.toLowerCase()}`
  const cached = cacheGet<MatchCandidate[]>(key)
  if (cached) return cached

  const existing = searchInflight.get(key)
  if (existing) return existing

  const promise = (async () => {
    const json = await innertube("search", { query, params: SONG_FILTER }, { signed: false })
    if (isAborted(signal)) throw new ImportCancelled()
    const page = parseBrowsePage(json, "Songs")
    const seen = new Set<string>()
    const candidates: MatchCandidate[] = []
    for (const item of page.shelves.flatMap((shelf) => shelf.items)) {
      if (item.kind !== "track") continue
      if (!item.id || seen.has(item.id)) continue
      seen.add(item.id)
      candidates.push(candidateOf(item))
    }
    return cacheSet(key, candidates, SEARCH_TTL_MS, Math.max(1, candidates.length))
  })().finally(() => searchInflight.delete(key))

  searchInflight.set(key, promise)
  return promise
}

function importKey(track: SpotifyTrack): string {
  return track.sourceId || `text:${normalizeKey(track.title)}:${normalizeKey(track.artists.join(" "))}`
}

type MatchOutcome = { match: SpotifyMatch | null; error: string | null }

/** Match unique tracks with bounded concurrency, reporting progress per completion. */
async function matchTracks(
  tracks: SpotifyTrack[],
  signal: AbortSignal | undefined,
  onProgress: ImportOptions["onProgress"],
): Promise<{ results: MatchOutcome[]; firstError: string | null }> {
  const unique = new Map<string, SpotifyTrack>()
  for (const track of tracks) {
    const key = importKey(track)
    if (!unique.has(key)) unique.set(key, track)
  }
  const entries = [...unique.entries()]
  const outcomes = new Map<string, MatchOutcome>()
  let next = 0
  let done = 0
  let firstError: string | null = null
  let stopped = false

  const worker = async () => {
    while (!stopped) {
      if (isAborted(signal)) throw new ImportCancelled()
      const index = next++
      if (index >= entries.length) return
      const [key, track] = entries[index]
      let outcome: MatchOutcome
      try {
        outcome = { match: await matchTrack(track, (query) => searchSongs(query, signal)), error: null }
      } catch (error) {
        if (error instanceof ImportCancelled || isAborted(signal)) throw new ImportCancelled()
        const message = error instanceof Error ? error.message : String(error)
        if (!firstError) firstError = message
        outcome = { match: null, error: message }
      }
      outcomes.set(key, outcome)
      done++
      onProgress({ phase: "matching", done, total: entries.length })
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(SEARCH_CONCURRENCY, entries.length) }, () => worker()),
    )
  } catch (error) {
    stopped = true
    if (error instanceof ImportCancelled || isAborted(signal)) throw new ImportCancelled()
    throw error
  }

  return {
    results: tracks.map((track) => outcomes.get(importKey(track)) ?? { match: null, error: "not matched" }),
    firstError,
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

/** Full import: public Spotify URL -> matched, private YouTube Music playlist. */
export async function importSpotifyPlaylist(
  rawUrl: string,
  { signal, onProgress }: ImportOptions,
): Promise<SpotifyImportResult> {
  if (!getScope()) throw new Error("Sign in to YouTube Music to import a playlist.")

  const id = extractPlaylistId(rawUrl)
  if (!id) {
    throw new Error(
      isSpotifyShortLink(rawUrl)
        ? "That's a Spotify short link. Use “Copy link to playlist” instead."
        : "That isn't a Spotify playlist link.",
    )
  }

  onProgress({ phase: "reading", done: 0, total: 0 })
  const embed = await readEmbedPlaylist(id, signal)
  if (isAborted(signal)) throw new ImportCancelled()

  let playlist: SpotifyPlaylist = {
    id,
    name: embed.name,
    cover: embed.cover,
    tracks: embed.tracks,
    skipped: embed.skipped,
    truncated: embed.tracks.length >= 100,
  }

  // The embed page stops at 100 entries. With its anonymous token we can walk
  // the rest of the playlist; if that fails we keep the first 100 and flag it.
  if (embed.token && embed.tracks.length >= 100) {
    try {
      const full = await readFullPlaylist(id, embed.token, signal)
      if (full.tracks.length) {
        playlist = {
          ...playlist,
          name: full.name ?? playlist.name,
          cover: full.cover ?? playlist.cover,
          tracks: full.tracks,
          skipped: full.skipped,
          truncated: full.truncated,
        }
      }
    } catch (error) {
      if (error instanceof ImportCancelled || isAborted(signal)) throw new ImportCancelled()
      // Partial success beats a failed import: keep the embed's first 100.
      playlist.truncated = true
    }
  }

  if (!playlist.tracks.length) throw new Error("No songs in this playlist.")

  const { results, firstError } = await matchTracks(playlist.tracks, signal, onProgress)
  if (isAborted(signal)) throw new ImportCancelled()

  const unmatched: SpotifyUnmatchedTrack[] = []
  const matched: SpotifyMatch[] = []
  for (let index = 0; index < playlist.tracks.length; index++) {
    const track = playlist.tracks[index]
    const outcome = results[index]
    if (outcome?.match) {
      matched.push(outcome.match)
    } else {
      unmatched.push({
        title: track.title,
        artists: track.artists,
        reason: outcome?.error ? `search failed: ${outcome.error}` : "no confident match",
      })
    }
  }

  if (!matched.length) {
    throw new Error(firstError ?? "None of those songs were found on YouTube Music.")
  }

  onProgress({ phase: "creating", done: 0, total: 0 })
  const title = (playlist.name.trim() || "Imported Spotify Playlist").slice(0, 150)
  const playlistId = await createPlaylist(title)
  cacheClear("browse:")

  const videoIds = matched.map((match) => match.candidate.videoId)
  let added = 0
  let warning: string | null = null
  onProgress({ phase: "adding", done: 0, total: videoIds.length })

  for (const batch of chunks(videoIds, ADD_BATCH_SIZE)) {
    if (isAborted(signal)) {
      warning = `The playlist was created, but only ${added} of ${videoIds.length} songs were added.`
      break
    }
    try {
      await addToPlaylistBatch(playlistId, batch)
      added += batch.length
      onProgress({ phase: "adding", done: added, total: videoIds.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warning = `The playlist was created, but only ${added} of ${videoIds.length} songs were added. ${message}`
      break
    }
  }

  return {
    playlistId,
    title,
    total: playlist.tracks.length,
    matched: matched.length,
    added,
    skipped: playlist.skipped,
    truncated: playlist.truncated,
    unmatched,
    warning,
  }
}
