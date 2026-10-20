import type { AppSettings, LyricsRequest, LyricsProviderInfo, LyricsResult } from "../../shared/types.ts"
import { cacheGet, cacheSet } from "../storage/cache.ts"
import { artistForLyricsSearch, forLyricsSearch, isIsrc } from "./matching.ts"
import { normalizeLyrics } from "./parse.ts"
import {
  DEFAULT_SOURCE_ORDER,
  PROVIDER_BY_ID,
  PROVIDER_INFO,
  type LyricsFetchContext,
  type LyricsIdentity,
  type LyricsProvider,
  type LyricsQuery,
} from "./providers.ts"

const RESULT_TTL_MS = 12 * 60 * 60 * 1000
const IDENTIFY_TIMEOUT_MS = 2500
const OVERALL_TIMEOUT_MS = 12_000
const MAX_DOCUMENT_BYTES = 4_000_000
const USER_AGENT = "Muzeec/0.0.1"

const isrcCache = new Map<string, string>()

export function lyricsProviderInfo(): LyricsProviderInfo[] {
  return PROVIDER_INFO
}

export async function lookupLyrics(request: LyricsRequest, settings: AppSettings): Promise<LyricsResult | null> {
  if (!settings.lyricsEnabled) return null
  const sequence = resolveSequence(settings)
  if (!sequence.length) return null

  const query: LyricsQuery = {
    videoId: request.videoId,
    title: forLyricsSearch(request.title),
    artist: artistForLyricsSearch(request.artist),
    album: request.album ?? null,
    durationMs: Math.max(0, Number(request.durationMs) || 0),
    isrc: isIsrc(request.isrc) ? request.isrc : isrcCache.get(request.videoId) ?? null,
  }
  const key = cacheKey(query, settings, sequence)
  if (!request.retry) {
    const cached = cacheGet<{ result: LyricsResult | null }>(key)
    if (cached) return cached.result
  }

  const controller = new AbortController()
  const overall = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS)
  const documents = new Map<string, Promise<string | null>>()
  const sharedGet = (url: string): Promise<string | null> => {
    let pending = documents.get(url)
    if (!pending) {
      pending = httpGet(url, 8000, controller.signal)
      documents.set(url, pending)
    }
    return pending
  }
  const context: LyricsFetchContext = {
    get: (url, timeoutMs = 6000, headers) => httpGet(url, timeoutMs, controller.signal, headers),
    sharedGet,
    identity: null,
    signal: controller.signal,
  }

  let result: LyricsResult | null = null
  try {
    if (!query.isrc) {
      const identifier = sequence
        .map((id) => PROVIDER_BY_ID.get(id))
        .find((provider): provider is LyricsProvider => Boolean(provider?.identify))
      if (identifier?.identify) {
        const identity = await withTimeout(identifier.identify(query), IDENTIFY_TIMEOUT_MS)
        if (identity) {
          context.identity = identity
          if (identity.isrc) {
            query.isrc = identity.isrc
            rememberIsrc(request.videoId, identity.isrc)
          }
        }
      }
    }

    const jobs = sequence.map((id) => {
      const provider = PROVIDER_BY_ID.get(id)!
      return {
        id,
        provider,
        start: provider.lazy ? null : runProvider(provider, query, context),
      }
    })

    let lineSynced: LyricsResult | null = null
    let plain: LyricsResult | null = null
    for (const job of jobs) {
      if (job.provider.lazy && (lineSynced || plain)) continue
      const found = await (job.start ?? runProvider(job.provider, query, context))
      if (!found) continue
      if (found.wordSynced) {
        result = found
        break
      }
      if (found.synced && !settings.lyricsPreferSyllableTiming) {
        result = found
        break
      }
      if (found.synced) lineSynced ??= found
      else plain ??= found
    }
    result ??= lineSynced ?? plain
  } catch {
    result = null
  } finally {
    clearTimeout(overall)
    controller.abort()
  }

  cacheSet(key, { result }, RESULT_TTL_MS)
  return result
}

async function runProvider(
  provider: LyricsProvider,
  query: LyricsQuery,
  context: LyricsFetchContext,
): Promise<LyricsResult | null> {
  try {
    const lines = await provider.fetch(query, context)
    if (!lines?.some((line) => line.text.trim() || line.words.length)) return null
    return normalizeLyrics(provider.info.id, provider.info.label, lines)
  } catch {
    return null
  }
}

function resolveSequence(settings: AppSettings): string[] {
  const configured = Array.isArray(settings.lyricsSources) ? settings.lyricsSources : DEFAULT_SOURCE_ORDER
  return [...new Set(configured.filter((id) => typeof id === "string" && PROVIDER_BY_ID.has(id)))]
}

function cacheKey(query: LyricsQuery, settings: AppSettings, sequence: string[]): string {
  return [
    "lyrics",
    query.videoId,
    Math.round(query.durationMs),
    query.title,
    query.artist,
    query.album ?? "",
    query.isrc ?? "",
    settings.lyricsPreferSyllableTiming ? "words" : "priority",
    sequence.join(","),
  ].join("|")
}

function rememberIsrc(videoId: string, isrc: string): void {
  if (isrcCache.size >= 100) isrcCache.delete(isrcCache.keys().next().value!)
  isrcCache.set(videoId, isrc)
}

async function withTimeout<T>(promise: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([promise.catch(() => null), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function httpGet(
  url: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<string | null> {
  if (parentSignal?.aborted) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  parentSignal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.8",
        ...extraHeaders,
      },
    })
    if (!response.ok) return null
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > MAX_DOCUMENT_BYTES) return null
    const body = await response.text()
    return body.slice(0, MAX_DOCUMENT_BYTES)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener("abort", abort)
  }
}
