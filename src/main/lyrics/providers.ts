import type { LyricLine, LyricsProviderInfo } from "../../shared/types.ts"
import { innertube } from "../youtube/innertube.ts"
import { isIsrc, lrcRedHit, pickCandidate, type Candidate } from "./matching.ts"
import { parseLrc, parseLyricsPayload, parsePlainText, parseTtml } from "./parse.ts"

export type LyricsQuery = {
  videoId: string
  title: string
  artist: string
  album?: string | null
  durationMs: number
  isrc?: string | null
}

export type LyricsIdentity = {
  isrc: string | null
  lyricsUrl: string | null
}

export type LyricsFetchContext = {
  get: (url: string, timeoutMs?: number, headers?: Record<string, string>) => Promise<string | null>
  sharedGet: (url: string) => Promise<string | null>
  identity?: LyricsIdentity | null
  signal: AbortSignal
}

export type LyricsProvider = {
  info: LyricsProviderInfo
  lazy?: boolean
  identify?: (query: LyricsQuery) => Promise<LyricsIdentity | null>
  fetch: (query: LyricsQuery, context: LyricsFetchContext) => Promise<LyricLine[] | null>
}

const API_HEADERS = { Accept: "application/json, text/plain, */*" }

function json(text: string | null): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function seconds(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number * 1000 : 0
}

function biniResult(raw: any): { candidate: Candidate; isrc: string | null; lyricsUrl: string | null } | null {
  const title = raw?.track_name ?? raw?.title
  const artist = raw?.artist_name ?? raw?.artist
  if (typeof title !== "string" || typeof artist !== "string") return null
  const id = raw.isrc ?? raw.id
  const lyricsUrl = raw.lyricsUrl ?? raw.lyrics_url ?? null
  return {
    candidate: { title, artist, durationMs: seconds(raw.duration ?? raw.durationMs) },
    isrc: isIsrc(id) ? id : null,
    lyricsUrl: externalUrl(lyricsUrl, ["lrc.red", "binimum.org"]),
  }
}

function externalUrl(value: unknown, hosts: string[]): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:") return null
    const host = url.hostname.toLowerCase()
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url.toString() : null
  } catch {
    return null
  }
}

async function biniSearch(query: LyricsQuery, context: LyricsFetchContext): Promise<any | null> {
  const url = new URL("https://lyrics-api.binimum.org/")
  if (query.isrc && isIsrc(query.isrc)) {
    url.searchParams.set("isrc", query.isrc)
  } else {
    url.searchParams.set("track", query.title)
    url.searchParams.set("artist", query.artist)
    if (query.album) url.searchParams.set("album", query.album)
    if (query.durationMs > 0) url.searchParams.set("duration", String(Math.round(query.durationMs / 1000)))
  }
  const body = await context.get(url.toString(), 4000, API_HEADERS)
  const data = json(body)
  return Array.isArray(data?.results) ? data : null
}

const lrcRed: LyricsProvider = {
  info: {
    id: "lrc-red",
    label: "lrc.red",
    description: "Apple timings by recording, often syllable by syllable.",
    wordSynced: true,
  },
  async fetch(query, context) {
    let documentUrl = context.identity?.lyricsUrl ?? null
    let isrc = query.isrc && isIsrc(query.isrc) ? query.isrc : context.identity?.isrc ?? null

    if (!documentUrl && !isrc) {
      const searchUrl = `https://lrc.red/search.json?q=${encodeURIComponent(`${query.title} ${query.artist}`)}`
      const data = json(await context.get(searchUrl, 6000, API_HEADERS))
      const hits = Array.isArray(data?.hits) ? data.hits : []
      const match = hits
        .filter((hit: any) => lrcRedHit(query, hit))
        .sort((a: any, b: any) => Math.abs(Number(a.duration ?? 0) * 1000 - query.durationMs) - Math.abs(Number(b.duration ?? 0) * 1000 - query.durationMs))[0]
      if (match && isIsrc(match.isrc)) isrc = match.isrc
    }
    if (!documentUrl && isrc) documentUrl = `https://lrc.red/s/${isrc}.ttml`
    if (!documentUrl) return null
    return parseLyricsPayload(await context.sharedGet(documentUrl))
  },
}

const bini: LyricsProvider = {
  info: {
    id: "bini",
    label: "BiniLyrics",
    description: "Recording-indexed Apple timings; also discovers the ISRC.",
    wordSynced: true,
  },
  async identify(query) {
    // identify() is called by the engine with the bounded prepass context.
    return biniIdentify(query, {
      get: async (url, _timeout, headers) => {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) })
        return response.ok ? response.text() : null
      },
      sharedGet: async () => null,
      signal: AbortSignal.abort(),
    })
  },
  async fetch(query, context) {
    let identity = context.identity ?? null
    if (!identity && query.isrc && isIsrc(query.isrc)) identity = { isrc: query.isrc, lyricsUrl: null }
    if (!identity) identity = await biniIdentify(query, context)
    const url = identity?.lyricsUrl ?? (identity?.isrc ? `https://lrc.red/s/${identity.isrc}.ttml` : null)
    if (!url) return null
    return parseLyricsPayload(await context.sharedGet(url))
  },
}

async function biniIdentify(query: LyricsQuery, context: LyricsFetchContext): Promise<LyricsIdentity | null> {
  const data = await biniSearch(query, context)
  if (!data) return null
  const hits = data.results.map(biniResult).filter(Boolean) as NonNullable<ReturnType<typeof biniResult>>[]
  if (!hits.length) return null
  if (query.isrc && isIsrc(query.isrc)) {
    const exact = hits.find((hit) => hit.isrc === query.isrc)
    if (exact) return { isrc: exact.isrc, lyricsUrl: exact.lyricsUrl }
  }
  const best = pickCandidate(
    query,
    hits.map((hit) => hit.candidate),
    10_000,
  )
  const hit = best ? hits.find((entry) => entry.candidate === best) : null
  if (!hit) return null
  return hit.isrc || hit.lyricsUrl ? { isrc: hit.isrc, lyricsUrl: hit.lyricsUrl } : null
}

const unison: LyricsProvider = {
  info: {
    id: "unison",
    label: "Unison",
    description: "Community-contributed word or line timings.",
    wordSynced: true,
  },
  async fetch(query, context) {
    const url = new URL("https://unison.boidu.dev/lyrics")
    url.searchParams.set("song", query.title)
    url.searchParams.set("artist", query.artist)
    if (query.album) url.searchParams.set("album", query.album)
    if (query.durationMs > 0) url.searchParams.set("duration", String(Math.round(query.durationMs / 1000)))
    const data = json(await context.get(url.toString(), 6000, API_HEADERS))
    if (!data?.success || !data.data?.lyrics) return null
    return parseLyricsPayload(String(data.data.lyrics))
  },
}

const youtubeMusic: LyricsProvider = {
  info: {
    id: "youtube-music",
    label: "YouTube Music",
    description: "The platform's own lyrics tab, keyed to the exact video.",
    wordSynced: false,
  },
  async fetch(query) {
    const next = await innertube("next", { videoId: query.videoId }, { signed: false })
    const browseId = findLyricsBrowseId(next)
    if (!browseId) return null
    const page = await innertube("browse", { browseId }, { signed: false })
    const text = findLyricsDescription(page)
    return text ? parsePlainText(text) : null
  },
}

function findLyricsBrowseId(value: any, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 20) return null
  const browse = value.browseEndpoint
  if (browse?.browseId && browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === "MUSIC_PAGE_TYPE_TRACK_LYRICS") {
    return browse.browseId
  }
  for (const child of Object.values(value)) {
    const found = findLyricsBrowseId(child, depth + 1)
    if (found) return found
  }
  return null
}

function findLyricsDescription(value: any, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 20) return null
  if (value.musicDescriptionShelfRenderer?.description) {
    const description = value.musicDescriptionShelfRenderer.description
    if (typeof description.simpleText === "string") return description.simpleText
    if (Array.isArray(description.runs)) return description.runs.map((run: any) => run?.text ?? "").join("")
  }
  for (const child of Object.values(value)) {
    const found = findLyricsDescription(child, depth + 1)
    if (found) return found
  }
  return null
}

const kugou: LyricsProvider = {
  info: {
    id: "kugou",
    label: "KuGou",
    description: "Chinese catalogue with wide non-English coverage; line timed.",
    wordSynced: false,
  },
  async fetch(query, context) {
    const search = new URL(
      `https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=8&showtype=0&keyword=${encodeURIComponent(`${query.title} ${query.artist}`)}`,
    )
    const songData = json(await context.get(search.toString(), 6000, API_HEADERS))
    const songs = (songData?.data?.info ?? [])
      .map((hit: any) => ({
        title: String(hit.songname ?? ""),
        artist: String(hit.singername ?? ""),
        durationMs: seconds(hit.duration),
        hash: typeof hit.hash === "string" ? hit.hash : null,
      }))
      .filter((hit: any) => hit.title && hit.artist)
    const song = pickCandidate<Candidate & { hash: string | null }>(query, songs, 8000)

    const lyricsUrl = new URL("https://lyrics.kugou.com/search")
    lyricsUrl.searchParams.set("ver", "1")
    lyricsUrl.searchParams.set("man", "yes")
    lyricsUrl.searchParams.set("client", "pc")
    if (song?.hash) lyricsUrl.searchParams.set("hash", song.hash)
    else {
      lyricsUrl.searchParams.set("keyword", `${query.title} ${query.artist}`)
      if (query.durationMs > 0) lyricsUrl.searchParams.set("duration", String(Math.round(query.durationMs)))
    }
    const lyricsHref = lyricsUrl.toString().split("+").join("%20")
    const lyricsData = json(await context.get(lyricsHref, 6000, API_HEADERS))
    const candidates = (lyricsData?.candidates ?? [])
      .map((hit: any) => ({
        title: String(hit.song ?? ""),
        artist: String(hit.singer ?? ""),
        durationMs: Number(hit.duration) || 0,
        id: String(hit.id ?? ""),
        accesskey: String(hit.accesskey ?? ""),
      }))
      .filter((hit: any) => hit.id && hit.accesskey)
    const candidate = pickCandidate<Candidate & { id: string; accesskey: string }>(query, candidates, 8000) ?? (song?.hash ? null : candidates[0])
    if (!candidate) return null

    const download = new URL("https://lyrics.kugou.com/download")
    download.searchParams.set("fmt", "lrc")
    download.searchParams.set("charset", "utf8")
    download.searchParams.set("client", "pc")
    download.searchParams.set("ver", "1")
    download.searchParams.set("id", candidate.id)
    download.searchParams.set("accesskey", candidate.accesskey)
    const downloadData = json(await context.get(download.toString(), 6000, API_HEADERS))
    const encoded = typeof downloadData?.content === "string" ? downloadData.content : ""
    if (!encoded) return null
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8").replace(/^\uFEFF/, "")
      return trimKugouCredits(parseLrc(decoded))
    } catch {
      return null
    }
  },
}

function trimKugouCredits(lines: LyricLine[]): LyricLine[] {
  const credit = /^(作词|作曲|编曲|词|曲|lyrics|songwriter|composer|arranger|producer)\s*[:：]/i
  let start = 0
  let end = lines.length
  while (start < end && credit.test(lines[start].text)) start++
  while (end > start && credit.test(lines[end - 1].text)) end--
  return lines.slice(start, end)
}

type LrclibHit = {
  trackName?: string
  artistName?: string
  duration?: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

const lrclib: LyricsProvider = {
  info: {
    id: "lrclib",
    label: "LRCLIB",
    description: "Community LRC; whole-line timing, very reliable.",
    wordSynced: false,
  },
  async fetch(query, context) {
    const exact = new URL("https://lrclib.net/api/get")
    exact.searchParams.set("track_name", query.title)
    exact.searchParams.set("artist_name", query.artist)
    if (query.durationMs > 0) exact.searchParams.set("duration", String(Math.round(query.durationMs / 1000)))
    const exactHit = json(await context.get(exact.toString(), 6000, API_HEADERS)) as LrclibHit | null
    if (exactHit) {
      const parsed = parseLrclibHit(exactHit)
      if (parsed) return parsed
    }

    const search = new URL("https://lrclib.net/api/search")
    search.searchParams.set("track_name", query.title)
    search.searchParams.set("artist_name", query.artist)
    const results = json(await context.get(search.toString(), 6000, API_HEADERS))
    if (!Array.isArray(results)) return null
    const candidates = results
      .filter((hit): hit is LrclibHit => Boolean(hit?.syncedLyrics || hit?.plainLyrics))
      .map((hit) => ({
        trackName: hit.trackName,
        artistName: hit.artistName,
        duration: hit.duration,
        title: hit.trackName ?? "",
        artist: hit.artistName ?? "",
        durationMs: seconds(hit.duration),
        hit,
      }))
    const best = pickCandidate(query, candidates, 15_000)
    return best ? parseLrclibHit(best.hit) : null
  },
}

function parseLrclibHit(hit: LrclibHit): LyricLine[] | null {
  if (hit.syncedLyrics) {
    const parsed = parseLyricsPayload(hit.syncedLyrics)
    if (parsed) return parsed
  }
  return hit.plainLyrics ? parsePlainText(hit.plainLyrics) : null
}

const genius: LyricsProvider = {
  info: {
    id: "genius",
    label: "Genius",
    description: "Plain-text fallback with a very large catalogue.",
    wordSynced: false,
  },
  lazy: true,
  async fetch(query, context) {
    const searchUrl = `https://genius.com/api/search/multi?q=${encodeURIComponent(`${query.title} ${query.artist}`)}`
    const data = json(await context.get(searchUrl, 8000, API_HEADERS))
    const candidates: Array<Candidate & { url: string }> = []
    for (const section of data?.response?.sections ?? []) {
      for (const entry of section?.hits ?? []) {
        const result = entry?.result
        if (!result?.url || result?.type === "artist") continue
        const artist = result.primary_artist?.name ?? result.artist_names ?? ""
        if (!result.title || !artist) continue
        const url = externalUrl(result.url, ["genius.com"])
        if (!url) continue
        candidates.push({ title: result.title, artist, durationMs: 0, url })
      }
    }
    const best = pickCandidate(query, candidates)
    if (!best) return null
    const page = await context.get(best.url, 8000, { Accept: "text/html" })
    if (!page) return null
    return (
      parsePlainText(geniusContainers(page).join("\n"))
        .map((line) => ({ ...line, text: line.text.replace(/^\d*\s*Contributors.*?Lyrics/i, "").trim() }))
        .filter((line) => line.text)
        .filter((line) => !/^You might also like$/i.test(line.text))
        .filter((line) => !/^Embed$/i.test(line.text)) || null
    )
  },
}

function geniusContainers(html: string): string[] {
  const out: string[] = []
  const opener = /<div\b[^>]*data-lyrics-container="true"[^>]*>/gi
  for (const match of html.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length
    let index = start
    let depth = 1
    while (depth > 0 && index < html.length) {
      const open = html.indexOf("<div", index)
      const close = html.indexOf("</div>", index)
      if (close < 0) break
      if (open >= 0 && open < close) {
        depth++
        index = open + 4
      } else {
        depth--
        index = close + 6
        if (depth === 0) out.push(html.slice(start, close))
      }
    }
  }
  return out
}

export const PROVIDERS: LyricsProvider[] = [lrcRed, bini, unison, youtubeMusic, kugou, lrclib, genius]
export const DEFAULT_SOURCE_ORDER = PROVIDERS.map((provider) => provider.info.id)
export const PROVIDER_INFO = PROVIDERS.map((provider) => provider.info)
export const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.info.id, provider]))
