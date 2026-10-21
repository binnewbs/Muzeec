import type { SpotifyTrack } from "../../shared/types.ts"
import { ImportCancelled, isAborted, spotifyFetch } from "./http.ts"

const HASH_TTL_MS = 6 * 60 * 60 * 1000
const PAGE_LIMIT = 100
const MAX_PAGES = 50

type HashCache = { hash: string; at: number }
let hashCache: HashCache | null = null

export type PathfinderPage = {
  name: string | null
  cover: string | null
  totalCount: number
  /** Raw entries in this response, before filtering episodes/local files. */
  rawCount: number
  tracks: SpotifyTrack[]
  skipped: number
}

export type PlaylistPages = {
  name: string | null
  cover: string | null
  totalCount: number
  tracks: SpotifyTrack[]
  skipped: number
  truncated: boolean
}

export type PageFetcher = (offset: number) => Promise<PathfinderPage>

function bestArtwork(sources: any): string | null {
  if (!Array.isArray(sources) || !sources.length) return null
  const ranked = sources
    .filter((source) => typeof source?.url === "string")
    .sort(
      (a, b) =>
        (Number(b?.width) || Number(b?.height) || 0) -
        (Number(a?.width) || Number(a?.height) || 0),
    )
  return ranked[0]?.url ?? null
}

function playlistArtwork(playlist: any): string | null {
  const images = playlist?.images?.items ?? playlist?.images ?? []
  if (Array.isArray(images)) {
    for (const image of images) {
      const url =
        bestArtwork(image?.sources) ??
        (typeof image?.url === "string" ? image.url : null)
      if (url) return url
    }
  }
  return bestArtwork(playlist?.coverArt?.sources) ?? bestArtwork(playlist?.coverArt?.items?.[0]?.sources)
}

/** Parse one `fetchPlaylist` response. Unknown/extra shapes are skipped, not thrown. */
export function parsePlaylistPage(json: any): PathfinderPage {
  const playlist = json?.data?.playlistV2
  if (!playlist) {
    const message = json?.errors?.[0]?.message
    throw new Error(message ? `Spotify: ${message}` : "Could not read the Spotify playlist.")
  }

  const content = playlist.content ?? {}
  const rawItems: any[] = Array.isArray(content.items) ? content.items : []
  const tracks: SpotifyTrack[] = []
  let skipped = 0

  for (const entry of rawItems) {
    const track = entry?.itemV2?.data
    if (!track || track.__typename !== "Track") {
      skipped++
      continue
    }
    const title = track.name
    if (!title || typeof title !== "string" || !title.trim()) {
      skipped++
      continue
    }

    const artists = Array.isArray(track.artists?.items)
      ? track.artists.items
          .map((artist: any) => (typeof artist?.profile?.name === "string" ? artist.profile.name.trim() : ""))
          .filter(Boolean)
      : []
    const album = track.albumOfTrack
    const duration =
      typeof track.trackDuration?.totalMilliseconds === "number"
        ? track.trackDuration.totalMilliseconds
        : null
    const rating = track.contentRating?.label
    const explicit = rating === "EXPLICIT" ? true : rating === "NONE" ? false : null

    tracks.push({
      sourceId: typeof track.uri === "string" ? (track.uri.split(":").pop() ?? "") : "",
      title: title.trim(),
      artists,
      album: typeof album?.name === "string" ? album.name : null,
      durationMs: duration,
      isrc: null,
      artworkUrl: bestArtwork(album?.coverArt?.sources),
      explicit,
    })
  }

  return {
    name: typeof playlist.name === "string" ? playlist.name : null,
    cover: playlistArtwork(playlist),
    totalCount: Number.isFinite(content.totalCount) ? Number(content.totalCount) : rawItems.length,
    rawCount: rawItems.length,
    tracks,
    skipped,
  }
}

/** Pull the current `fetchPlaylist` persisted-query hash out of the web player bundle. */
export function extractPlaylistHash(source: string): string | null {
  const match = source.match(/["']fetchPlaylist["']\s*,\s*["']query["']\s*,\s*["']([a-f0-9]{64})["']/)
  return match?.[1] ?? null
}

function scriptUrls(html: string): string[] {
  const urls = new Set<string>()
  for (const match of html.matchAll(/https:\/\/[^\s"'<>]+?\.js/g)) {
    try {
      const url = new URL(match[0])
      if (url.protocol !== "https:") continue
      if (url.hostname !== "open.spotifycdn.com" && !url.hostname.endsWith(".spotifycdn.com")) continue
      if (!url.pathname.includes("web-player")) continue
      urls.add(url.toString())
    } catch {
      // Ignore malformed bundle URLs in the HTML.
    }
  }
  return [...urls]
}

async function discoverHash(signal?: AbortSignal): Promise<string> {
  if (hashCache && Date.now() - hashCache.at < HASH_TTL_MS) return hashCache.hash

  const home = await spotifyFetch("https://open.spotify.com/", {}, signal)
  if (!home.ok) throw new Error("Could not read Spotify's web player.")
  const html = await home.text()

  for (const url of scriptUrls(html).slice(0, 8)) {
    if (isAborted(signal)) throw new ImportCancelled()
    const response = await spotifyFetch(url, {}, signal)
    if (!response.ok) continue
    const hash = extractPlaylistHash(await response.text())
    if (hash) {
      hashCache = { hash, at: Date.now() }
      return hash
    }
  }
  throw new Error("Could not read Spotify's import token.")
}

async function requestPage(
  id: string,
  offset: number,
  token: string,
  hash: string,
  signal?: AbortSignal,
): Promise<Response> {
  const variables = JSON.stringify({
    uri: `spotify:playlist:${id}`,
    offset,
    limit: PAGE_LIMIT,
    enableWatchFeedEntrypoint: false,
  })
  const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } })
  const query = new URLSearchParams({ operationName: "fetchPlaylist", variables, extensions })
  return spotifyFetch(
    `https://api-partner.spotify.com/pathfinder/v1/query?${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "App-platform": "WebPlayer",
        Accept: "application/json",
      },
    },
    signal,
  )
}

/** Read one Pathfinder page, refreshing the persisted-query hash once if it rotated. */
export async function fetchPlaylistPage(
  id: string,
  offset: number,
  token: string,
  signal?: AbortSignal,
): Promise<PathfinderPage> {
  let hash = await discoverHash(signal)
  let response = await requestPage(id, offset, token, hash, signal)

  if (response.status === 400) {
    const body = await response.text()
    if (/PersistedQueryNotFound/i.test(body)) {
      hashCache = null
      hash = await discoverHash(signal)
      response = await requestPage(id, offset, token, hash, signal)
    } else {
      throw new Error("Spotify rejected the playlist request.")
    }
  }

  if (response.status === 401) throw new Error("Spotify's import session expired. Try again.")
  if (response.status === 429) throw new Error("Spotify is rate-limiting imports. Try again in a minute.")
  if (!response.ok) throw new Error(`Spotify returned ${response.status}. Try again.`)

  const json = await response.json()
  return parsePlaylistPage(json)
}

/** Walk every page. Later-page failures keep the pages already read. */
export async function readPlaylistPages(
  id: string,
  token: string,
  fetchPage: PageFetcher,
): Promise<PlaylistPages> {
  let offset = 0
  let totalCount = 0
  let name: string | null = null
  let cover: string | null = null
  let pages = 0
  let truncated = false
  const tracks: SpotifyTrack[] = []
  let skipped = 0

  while (pages < MAX_PAGES) {
    let page: PathfinderPage
    try {
      page = await fetchPage(offset)
    } catch (error) {
      if (pages === 0) throw error
      truncated = true
      break
    }
    pages++
    if (page.name) name = page.name
    if (page.cover) cover = page.cover
    if (page.totalCount) totalCount = page.totalCount
    if (!page.rawCount) break

    tracks.push(...page.tracks)
    skipped += page.skipped
    offset += page.rawCount
    if (offset >= totalCount) break
    if (pages >= MAX_PAGES) truncated = true
  }

  if (!totalCount) totalCount = tracks.length + skipped
  if (offset < totalCount) truncated = true

  return { name, cover, totalCount, tracks, skipped, truncated }
}

/** Fill in missing metadata from Pathfinder while preserving the embed fallback. */
export async function readFullPlaylist(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ tracks: SpotifyTrack[]; skipped: number; name: string | null; cover: string | null; truncated: boolean }> {
  const pages = await readPlaylistPages(id, token, (offset) => fetchPlaylistPage(id, offset, token, signal))
  return {
    tracks: pages.tracks,
    skipped: pages.skipped,
    name: pages.name,
    cover: pages.cover,
    truncated: pages.truncated,
  }
}

