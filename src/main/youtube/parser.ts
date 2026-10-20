import type { ArtistRef, BrowsePage, MediaItem, MediaKind, PageHeader, Shelf, Track } from "../../shared/types.ts"

const ITEM_RENDERERS = new Set([
  "musicResponsiveListItemRenderer",
  "musicTwoRowItemRenderer",
  "musicCardShelfRenderer",
  "musicMultiRowListItemRenderer",
])

const SHELF_RENDERERS = new Set([
  "musicCarouselShelfRenderer",
  "musicShelfRenderer",
  "gridRenderer",
  "musicPlaylistShelfRenderer",
])

/** Tolerant InnerTube walker: recursive renderer search, missing fields absent (DOC §8.4). */
export function parseBrowsePage(json: any, fallbackTitle: string): BrowsePage {
  const shelves: Shelf[] = []
  const seen = new Set<string>()

  walk(json, (node) => {
    for (const key of SHELF_RENDERERS) {
      const renderer = node[key]
      if (!renderer) continue
      const items = collectItems(renderer).filter((item) => {
        if (seen.has(item.kind + item.id)) return false
        seen.add(item.kind + item.id)
        return true
      })
      if (!items.length) continue
      shelves.push({ title: shelfTitle(renderer) ?? fallbackTitle, items })
    }
  })

  const header = pageHeader(json)
  const parsed = pruneEmpty(shelves)
  // Artist banners are not album art, so only reuse collection headers as covers.
  if (header && !findKey(json, "musicImmersiveHeaderRenderer")) fillFromHeader(parsed, header)
  return { title: pageTitle(json) ?? fallbackTitle, shelves: parsed, header }
}

/** Radio/autoplay queue from the `next` endpoint (`RDAMVM<videoId>`). */
export function parseQueueTracks(json: any): Track[] {
  const contents: any[] = findKey(json, "playlistPanelRenderer")?.contents ?? []
  const tracks: Track[] = []
  for (const entry of contents) {
    const item = toItem(entry.playlistPanelVideoRenderer)
    if (item?.kind === "track" && item.musicVideoType !== "MUSIC_VIDEO_TYPE_OMV") {
      tracks.push({ ...item, kind: "track", videoId: item.id })
    }
  }
  return tracks
}

function fillFromHeader(shelves: Shelf[], header: PageHeader): void {
  const names = header.artists.map((artist) => artist.name).join(", ")
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      if (!item.thumbnail && header.thumbnail) item.thumbnail = header.thumbnail
      if (item.kind !== "track" || item.artists?.length || !header.artists.length) continue
      item.artists = header.artists
      item.subtitle = [names, item.subtitle].filter(Boolean).join(" • ")
    }
  }
}

function pageHeader(json: any): PageHeader | null {
  const immersive = findKey(json, "musicImmersiveHeaderRenderer")
  if (immersive) {
    const subscribe = immersive.subscriptionButton?.subscribeButtonRenderer
    const service = subscribe?.serviceEndpoints?.find((entry: any) => entry.subscribeEndpoint)?.subscribeEndpoint
    const title = textOf(immersive.title) ?? ""
    if (!title) return null
    return {
      title,
      subtitle: textOf(immersive.monthlyListenerCount) ?? textOf(subscribe?.longSubscriberCountText) ?? "",
      thumbnail: thumbnailOf(immersive),
      description: textOf(immersive.description) ?? "",
      channelId: subscribe?.channelId ?? service?.channelIds?.[0] ?? null,
      subscribed: Boolean(subscribe?.subscribed),
      subscriptionParams: service?.params ?? null,
      artists: [],
    }
  }

  for (const key of [
    "musicResponsiveHeaderRenderer",
    "musicDetailHeaderRenderer",
    "musicEditablePlaylistDetailHeaderRenderer",
    "musicVisualHeaderRenderer",
  ]) {
    const renderer = findKey(json, key)
    const title = textOf(renderer?.title) ?? ""
    if (!title) continue
    const subscribe = renderer.subscriptionButton?.subscribeButtonRenderer
    return {
      title,
      subtitle: [textOf(renderer.subtitle), textOf(renderer.secondSubtitle)].filter(Boolean).join(" • "),
      thumbnail: thumbnailOf(renderer),
      description: textOf(renderer.description) ?? "",
      channelId: subscribe?.channelId ?? null,
      subscribed: Boolean(subscribe?.subscribed),
      subscriptionParams: null,
      artists: refsFromRuns([...(renderer.straplineTextOne?.runs ?? []), ...(renderer.subtitle?.runs ?? [])]).artists,
    }
  }
  return null
}

function thumbnailOf(renderer: any): string | null {
  return (
    renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ??
    renderer.thumbnail?.thumbnails?.at(-1)?.url ??
    null
  )
}

function pruneEmpty(shelves: Shelf[]): Shelf[] {
  // Search returns artist/album shelves with valid items; drop nothing except empties.
  return shelves.filter((shelf) => shelf.items.length > 0)
}

function pageTitle(json: any): string | null {
  for (const key of [
    "musicImmersiveHeaderRenderer",
    "musicDetailHeaderRenderer",
    "musicEditablePlaylistDetailHeaderRenderer",
    "musicVisualHeaderRenderer",
    "musicResponsiveHeaderRenderer",
  ]) {
    const title = textOf(findKey(json, key)?.title)
    if (title) return title
  }
  return null
}

function shelfTitle(renderer: any): string | null {
  return (
    textOf(renderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title) ??
    textOf(renderer?.header?.musicShelfBasicHeaderRenderer?.title) ??
    textOf(renderer?.header?.musicHeaderRenderer?.title) ??
    textOf(renderer?.title) ??
    null
  )
}

function collectItems(renderer: any): MediaItem[] {
  const items: MediaItem[] = []
  walk(renderer, (node) => {
    for (const key of ITEM_RENDERERS) {
      if (node[key]) {
        const item = toItem(node[key])
        if (item) items.push(item)
      }
    }
  })
  return items
}

function toItem(renderer: any): MediaItem | null {
  const videoId =
    renderer.videoId ??
    renderer.playlistItemData?.videoId ??
    renderer.navigationEndpoint?.watchEndpoint?.videoId ??
    findKey(renderer, "watchEndpoint")?.videoId ??
    null
  const browseId =
    renderer.navigationEndpoint?.browseEndpoint?.browseId ??
    findKey(renderer, "browseEndpoint")?.browseId ??
    null
  const title =
    textOf(renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text) ??
    textOf(renderer.title) ??
    textOf(renderer.headline) ??
    null
  if (!title) return null

  const subtitleText =
    textOf(renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text) ??
    textOf(renderer.subtitle) ??
    textOf(renderer.subtitle2) ??
    textOf(renderer.longBylineText) ??
    textOf(renderer.shortBylineText) ??
    ""
  const subtitleParts = subtitleText.split(/\s*[•·]\s*/).filter(Boolean)

  const durationText =
    textOf(renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text) ??
    textOf(renderer.fixedColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text) ??
    textOf(renderer.lengthText) ??
    null
  const duration = parseDuration(durationText)
  const thumbnail =
    renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ??
    renderer.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ??
    renderer.thumbnail?.thumbnails?.at(-1)?.url ??
    null
  const watchEndpoint =
    renderer.navigationEndpoint?.watchEndpoint ??
    findKey(renderer, "watchEndpoint")
  const musicVideoType =
    watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType ??
    findKey(renderer, "watchEndpointMusicConfig")?.musicVideoType ??
    null

  let kind: MediaKind = "track"
  let id = videoId
  if (!videoId && browseId) {
    id = browseId
    kind = browseId.startsWith("VL") ? "playlist" : browseId.startsWith("MPRE") ? "album" : "artist"
  }
  if (!id) return null

  const subtitle = subtitleParts.join(" • ")
  const refs = navRefs(renderer)
  return {
    kind,
    id,
    title,
    subtitle,
    thumbnail,
    duration,
    artists: refs.artists.length
      ? refs.artists
      : kind === "track" && subtitleParts.length
        ? subtitleParts.slice(0, 1).map((name) => ({ name, id: null }))
        : [],
    album: refs.album,
    year: subtitleParts.find((part) => /^\d{4}$/.test(part)) ?? null,
    musicVideoType,
  }
}

/** Pull artist and album browse IDs out of the subtitle runs. */
function navRefs(renderer: any): { artists: ArtistRef[]; album: { name: string; id: string } | null } {
  return refsFromRuns([
    ...(renderer.flexColumns ?? []).flatMap(
      (column: any) => column.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [],
    ),
    ...(renderer.subtitle?.runs ?? []),
    ...(renderer.subtitle2?.runs ?? []),
    ...(renderer.longBylineText?.runs ?? []),
    ...(renderer.shortBylineText?.runs ?? []),
  ])
}

function refsFromRuns(runs: any[]): { artists: ArtistRef[]; album: { name: string; id: string } | null } {
  const artists: ArtistRef[] = []
  let album: { name: string; id: string } | null = null
  const seen = new Set<string>()
  for (const run of runs) {
    const browse = run.navigationEndpoint?.browseEndpoint
    const id = browse?.browseId
    const name = typeof run.text === "string" ? run.text.trim() : ""
    if (!id || !name || seen.has(id)) continue
    const pageType = browse.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
    if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || id.startsWith("UC")) {
      seen.add(id)
      artists.push({ name, id })
    } else if (!album && (pageType === "MUSIC_PAGE_TYPE_ALBUM" || id.startsWith("MPRE"))) {
      album = { name, id }
    }
  }
  return { artists, album }
}

export function parseDuration(text: string | null | undefined): number | undefined {
  if (!text) return undefined
  const parts = text.trim().split(":").map(Number)
  if (parts.some(Number.isNaN)) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

export function textOf(node: any): string | null {
  if (!node) return null
  if (typeof node.simpleText === "string") return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((run: any) => run.text ?? "").join("")
  return null
}

export function findKey(node: any, key: string): any {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findKey(child, key)
      if (hit) return hit
    }
    return null
  }
  if (key in node) return node[key]
  for (const child of Object.values(node)) {
    const hit = findKey(child, key)
    if (hit) return hit
  }
  return null
}

export function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of Object.values(node)) walk(child, visit)
}
