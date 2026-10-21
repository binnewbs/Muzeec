import type { SpotifyPlaylist, SpotifyTrack } from "../../shared/types.ts"
import { spotifyFetch } from "./http.ts"

type EmbedPlaylist = {
  name: string
  cover: string | null
  tracks: SpotifyTrack[]
  skipped: number
  token: string | null
}

/** Read the Next.js payload from a Spotify embed page. */
export function nextData(html: string): any {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match) throw new Error("Could not read the Spotify playlist page.")
  try {
    return JSON.parse(match[1])
  } catch {
    throw new Error("Could not read the Spotify playlist page.")
  }
}

function bestArtwork(sources: any): string | null {
  if (!Array.isArray(sources) || !sources.length) return null
  const ranked = sources
    .filter((source) => typeof source?.url === "string")
    .sort((a, b) => (Number(b?.width) || 0) - (Number(a?.width) || 0))
  return ranked[0]?.url ?? null
}

function artworkOf(entity: any): string | null {
  return (
    bestArtwork(entity?.coverArt?.sources) ??
    bestArtwork(entity?.images) ??
    bestArtwork(entity?.coverArt?.items?.[0]?.sources) ??
    null
  )
}

/** Parse a public Spotify embed page into the neutral playlist model. */
export function parseEmbedPlaylist(html: string, id: string): EmbedPlaylist {
  const root = nextData(html)
  const props = root?.props?.pageProps
  const entity = props?.state?.data?.entity ?? props?.entity
  if (!entity) throw new Error("This playlist is private, deleted, or not available.")

  const cover = artworkOf(entity)
  const trackList = entity.trackList ?? entity.tracks ?? []
  const tracks: SpotifyTrack[] = []
  let skipped = 0

  for (const item of trackList) {
    const title = item?.title ?? item?.name
    if (!title || typeof title !== "string" || !title.trim()) {
      skipped++
      continue
    }
    if (item.entityType && item.entityType !== "track") {
      skipped++
      continue
    }

    const credit =
      typeof item.subtitle === "string" && item.subtitle.trim()
        ? [item.subtitle.trim()]
        : Array.isArray(item.artists)
          ? item.artists
              .map((artist: any) => (typeof artist?.name === "string" ? artist.name.trim() : ""))
              .filter(Boolean)
          : []
    const duration =
      typeof item.duration === "number"
        ? item.duration
        : typeof item.duration?.totalMilliseconds === "number"
          ? item.duration.totalMilliseconds
          : null

    tracks.push({
      sourceId: typeof item.uri === "string" ? (item.uri.split(":").pop() ?? "") : "",
      title: title.trim(),
      artists: credit,
      album: typeof item.album?.name === "string" ? item.album.name : null,
      durationMs: duration,
      isrc: typeof item.isrc === "string" ? item.isrc : null,
      artworkUrl: cover,
      explicit: typeof item.isExplicit === "boolean" ? item.isExplicit : null,
    })
  }

  const token = props?.state?.settings?.session?.accessToken

  return {
    name: String(entity.name ?? entity.title ?? "Imported Spotify Playlist"),
    cover,
    tracks,
    skipped,
    token: typeof token === "string" && token ? token : null,
  }
}

/** Fetch and parse the public embed page (no sign-in, first 100 entries). */
export async function readEmbedPlaylist(id: string, signal?: AbortSignal): Promise<EmbedPlaylist> {
  const response = await spotifyFetch(`https://open.spotify.com/embed/playlist/${id}`, {}, signal)
  if (response.status === 404 || response.status === 403) {
    throw new Error("This playlist is private, deleted, or not available.")
  }
  if (response.status === 429) {
    throw new Error("Spotify is rate-limiting imports. Try again in a minute.")
  }
  if (!response.ok) throw new Error(`Spotify returned ${response.status}. Try again.`)
  const html = await response.text()
  return parseEmbedPlaylist(html, id)
}

export function embedPlaylist(id: string, embed: EmbedPlaylist): SpotifyPlaylist {
  return {
    id,
    name: embed.name,
    cover: embed.cover,
    tracks: embed.tracks,
    skipped: embed.skipped,
    truncated: embed.tracks.length >= 100,
  }
}
