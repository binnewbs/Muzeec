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
  "musicCarouselShelfContinuation",
  "musicShelfContinuation",
  "gridContinuation",
  "musicPlaylistShelfContinuation",
  // Playlist/album chunks arrive as an append action, not as a shelf renderer.
  "appendContinuationItemsAction",
  "reloadContinuationItemsCommand",
])

const TRACK_LIST_ORDER = [
  "musicPlaylistShelfRenderer",
  "musicPlaylistShelfContinuation",
  "musicShelfRenderer",
  "musicShelfContinuation",
  "gridRenderer",
  "gridContinuation",
  "musicCarouselShelfRenderer",
  "musicCarouselShelfContinuation",
  "appendContinuationItemsAction",
  "reloadContinuationItemsCommand",
]

type ShelfHit = { shelf: Shelf; renderer: string; token: string | null }

/** Decoded-image cost matters more than bytes: list rows are 40 px, cards 160 px. */
const ITEM_THUMBNAIL_SIZE = 320
const HEADER_THUMBNAIL_SIZE = 544

export function sizedThumbnail(url: string | null | undefined, size: number): string | null {
  if (!url) return null
  const sized = url.replace(/=(?:w\d+-h\d+|w\d+|h\d+)/i, `=w${size}-h${size}`)
  if (sized !== url) return sized
  return url.replace(/=s\d+(-[a-z0-9-]+)?$/i, (_match, suffix = "") => `=s${size}${suffix}`)
}

export type BrowseFeed = {
  page: BrowsePage
  continuation: string | null
  /** Main track list within `page.shelves`, or null when the page has none. */
  trackListIndex: number | null
}

/** Tolerant InnerTube walker: recursive renderer search, missing fields absent (DOC §8.4). */
export function parseBrowsePage(json: any, fallbackTitle: string): BrowsePage {
  return parseBrowseFeed(json, fallbackTitle).page
}

/** One browse response plus the token for the next chunk of a paged list. */
export function parseBrowseFeed(json: any, fallbackTitle: string): BrowseFeed {
  const { shelves, continuation, trackListIndex } = parseShelves(json, fallbackTitle)
  const header = pageHeader(json)
  const parsed = pruneEmpty(shelves)
  // Artist banners are not album art, so only reuse collection headers as covers.
  if (header && !findKey(json, "musicImmersiveHeaderRenderer")) fillFromHeader(parsed, header)
  const resolvedTitle = pageTitle(json) ?? (isBrowseId(fallbackTitle) ? "" : fallbackTitle)
  return { page: { title: resolvedTitle, shelves: parsed, header }, continuation, trackListIndex }
}

/** Append a continuation chunk to the page's main track list, skipping overlap at page edges. */
export function appendBrowseItems(page: BrowsePage, items: MediaItem[], targetIndex?: number | null): void {
  if (!items.length) return
  const seen = new Set(page.shelves.flatMap((shelf) => shelf.items.map((item) => item.kind + item.id)))
  const indexed = targetIndex === null || targetIndex === undefined ? undefined : page.shelves[targetIndex]
  let target =
    indexed ??
    page.shelves.find(
      (shelf) => shelf.items.length > 0 && shelf.items.every((item) => item.kind === "track"),
    ) ??
    page.shelves.at(-1)
  if (!target) {
    target = { title: "", items: [] }
    page.shelves.push(target)
  }
  for (const item of items) {
    const key = item.kind + item.id
    if (seen.has(key)) continue
    seen.add(key)
    target.items.push(item)
  }
}

function parseShelves(
  json: any,
  fallbackTitle: string,
): { shelves: Shelf[]; continuation: string | null; trackListIndex: number | null } {
  const hits: ShelfHit[] = []
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
      const shelf = { title: shelfTitle(renderer) ?? (isBrowseId(fallbackTitle) ? "" : fallbackTitle), items }
      hits.push({ shelf, renderer: key, token: continuationOf(renderer) })
    }
  })

  const trackListIndex = pickTrackList(hits)
  const continuation = trackListIndex === null ? null : hits[trackListIndex].token
  return { shelves: hits.map((hit) => hit.shelf), continuation, trackListIndex }
}

/** Only the main track list pages; carousel tokens would append albums to a track page. */
function pickTrackList(hits: ShelfHit[]): number | null {
  for (const renderer of TRACK_LIST_ORDER) {
    const index = hits.findIndex(
      (hit) => hit.renderer === renderer && hit.shelf.items.every((item) => item.kind === "track"),
    )
    if (index >= 0) return index
  }
  return null
}

function continuationOf(renderer: any): string | null {
  return findContinuationToken(renderer)
}

/** Single early-exit traversal instead of three full-subtree `findKey` walks per shelf. */
function findContinuationToken(node: any): string | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const token = findContinuationToken(child)
      if (token) return token
    }
    return null
  }
  const token = node.continuationCommand?.token ?? node.nextContinuationData?.continuation
  if (typeof token === "string") return token
  for (const child of Object.values(node)) {
    const found = findContinuationToken(child)
    if (found) return found
  }
  return null
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
      const parts = item.subtitle ? item.subtitle.split(/\s*[•·]\s*/).filter(Boolean) : []
      const alreadyHasArtist = parts.some((part) =>
        header.artists.every((artist) => part.toLowerCase().includes(artist.name.toLowerCase())),
      )
      if (!alreadyHasArtist) {
        item.subtitle = [names, item.subtitle].filter(Boolean).join(" • ")
      }
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
  return sizedThumbnail(
    renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ??
      renderer.thumbnail?.thumbnails?.at(-1)?.url ??
      null,
    HEADER_THUMBNAIL_SIZE,
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
  const thumbnail = sizedThumbnail(
    renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ??
      renderer.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ??
      renderer.thumbnail?.thumbnails?.at(-1)?.url ??
      null,
    ITEM_THUMBNAIL_SIZE,
  )
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

/** Detect browse IDs that should never be shown as human-readable titles. */
function isBrowseId(value: string | null | undefined): boolean {
  return /^(VL|MPRE|UC|RDCLAK|FEmusic_)/.test(value ?? "")
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
