import type { PlayerDecision } from "../../shared/types.ts"
import { getSettings } from "../storage/settings.ts"
import { cacheGet, cacheSet } from "../storage/cache.ts"
import { VISIONOS_UA, mediaHeadersFor } from "./session.ts"
import { innertube } from "./innertube.ts"
import { getClientInfo } from "./auth.ts"
import { decipher } from "./decipher.ts"
import { parseBrowsePage } from "./parser.ts"

type Client = {
  name: string
  id: number
  version?: string
  ua?: string
  context?: Record<string, unknown>
  label: string
}

const CLIENTS: Client[] = [
  { name: "WEB_REMIX", id: 67, label: "WEB_REMIX" },
  { name: "WEB", id: 1, label: "WEB" },
  { name: "MWEB", id: 2, label: "MWEB" },
  // VISIONOS returns direct audio URLs; media fetch must omit Origin/Referer (DOC §9.6).
  {
    name: "VISIONOS",
    id: 101,
    version: "1.02",
    ua: VISIONOS_UA,
    context: {
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471",
    },
    label: "VISIONOS",
  },
]

const EXCLUDE_MS = 10 * 60 * 1000
const VERDICT_MS = 10 * 60 * 1000
const DECISION_MS = 20 * 60 * 1000
const MAX_VERDICTS = 200
const MAX_EXCLUSIONS = 400
const MAX_DECISIONS = 40
const exclusions = new Map<string, number>()
const inflight = new Map<string, Promise<PlayerDecision>>()
const decisions = new Map<string, { decision: PlayerDecision; expires: number }>()
const trackingInflight = new Map<string, Promise<any | null>>()
export const verdicts = new Map<string, { reason: string; expires: number }>()

function trackingKey(videoId: string): string {
  return `tracking:web:${videoId}`
}

/**
 * WEB_REMIX playback tracking is what YouTube Music accepts for account history.
 * Streams may resolve through VISIONOS, so request web tracking separately.
 */
export function getWebTracking(videoId: string): Promise<any | null> {
  const cached = cacheGet<any>(trackingKey(videoId))
  if (cached) return Promise.resolve(cached)
  return ensureWebTracking(videoId)
}

function ensureWebTracking(videoId: string): Promise<any | null> {
  const existing = trackingInflight.get(videoId)
  if (existing) return existing
  const promise = fetchWebTracking(videoId)
    .then((tracking) => {
      if (tracking) cacheSet(trackingKey(videoId), tracking, 30 * 60 * 1000)
      return tracking
    })
    .catch(() => null)
    .finally(() => trackingInflight.delete(videoId))
  trackingInflight.set(videoId, promise)
  return promise
}

async function fetchWebTracking(videoId: string): Promise<any | null> {
  const info = await getClientInfo()
  const response: any = await innertube(
    "player",
    {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: { signatureTimestamp: info.signatureTimestamp },
      },
    },
    { client: CLIENTS[0], retries: 0 },
  )
  if (response?.playabilityStatus?.status !== "OK") return null
  return response?.playbackTracking ?? null
}

export function clearPlayerCaches(): void {
  exclusions.clear()
  verdicts.clear()
  decisions.clear()
  inflight.clear()
}

export async function resolvePlayer(videoId: string, signedIn: boolean): Promise<PlayerDecision> {
  const cachedVerdict = verdicts.get(videoId)
  if (cachedVerdict && cachedVerdict.expires > Date.now()) throw new PlayerFailure(cachedVerdict.reason, true)

  const key = decisionKey(videoId, signedIn)
  const resolved = decisions.get(key)
  if (resolved && resolved.expires > Date.now() && resolved.decision.expiresAt > Date.now() + 60_000) {
    return resolved.decision
  }

  const existing = inflight.get(key)
  if (existing) return existing

  const promise = resolveWalk(videoId, signedIn)
    .then((decision) => {
      rememberDecision(key, decision)
      return decision
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

function decisionKey(videoId: string, signedIn: boolean): string {
  return `${videoId}:${signedIn ? 1 : 0}:${getSettings().quality}`
}

function rememberDecision(key: string, decision: PlayerDecision): void {
  if (decisions.size >= MAX_DECISIONS) pruneDecisions()
  decisions.set(key, {
    decision,
    expires: Math.max(Date.now() + 60_000, Math.min(Date.now() + DECISION_MS, decision.expiresAt - 60_000)),
  })
}

function pruneDecisions(): void {
  const now = Date.now()
  for (const [key, entry] of decisions) {
    if (entry.expires <= now || entry.decision.expiresAt <= now + 60_000) decisions.delete(key)
  }
  while (decisions.size >= MAX_DECISIONS) decisions.delete(decisions.keys().next().value!)
}

function rememberVerdict(videoId: string, reason: string): void {
  if (verdicts.size >= MAX_VERDICTS) {
    const now = Date.now()
    for (const [key, entry] of verdicts) if (entry.expires <= now) verdicts.delete(key)
    while (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
  }
  verdicts.set(videoId, { reason, expires: Date.now() + VERDICT_MS })
}

function excludeClient(key: string): void {
  if (exclusions.size >= MAX_EXCLUSIONS) {
    const now = Date.now()
    for (const [entry, until] of exclusions) if (until <= now) exclusions.delete(entry)
    while (exclusions.size >= MAX_EXCLUSIONS) exclusions.delete(exclusions.keys().next().value!)
  }
  exclusions.set(key, Date.now() + EXCLUDE_MS)
}

type Candidate = { url: string; mimeType: string; bitrate: number; codec: string; client: string }

async function resolveWalk(videoId: string, signedIn: boolean): Promise<PlayerDecision> {
  const info = await getClientInfo()
  // VISIONOS returns direct audio URLs; web clients fall back to ciphered/SABR bodies.
  const order = [CLIENTS[3], CLIENTS[0], CLIENTS[1], CLIENTS[2]]
  const reasons: string[] = []

  for (const client of order) {
    const key = `${videoId}:${client.name}`
    const excludedUntil = exclusions.get(key)
    if (excludedUntil && excludedUntil > Date.now()) continue

    try {
      const response: any = await innertube(
        "player",
        {
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: {
            contentPlaybackContext: { signatureTimestamp: info.signatureTimestamp },
          },
        },
        { signed: signedIn && client.name === "WEB_REMIX", client, retries: 1 },
      )
      const status = response?.playabilityStatus
      if (status?.status !== "OK") {
        const reason = readableReason(status?.reason ?? status?.status ?? "Refused")
        reasons.push(`${client.label}: ${reason}`)
        if (isPermanent(reason)) {
          rememberVerdict(videoId, reason)
          throw new PlayerFailure(reason, true)
        }
        excludeClient(key)
        continue
      }

      const formats: any[] = response?.streamingData?.adaptiveFormats ?? []
      const preferredItag = getSettings().quality === "normal" ? 140 : 251
      const audio = formats
        .filter((f) => String(f.mimeType ?? "").startsWith("audio/"))
        .sort((a, b) => score(b, preferredItag) - score(a, preferredItag))
      if (!audio.length) {
        reasons.push(`${client.label}: no audio formats`)
        excludeClient(key)
        continue
      }

      const tracking = response?.playbackTracking
      if (tracking) {
        if (client.name === "WEB_REMIX") cacheSet(trackingKey(videoId), tracking, 30 * 60 * 1000)
        else if (signedIn) void ensureWebTracking(videoId)
      }

      for (const format of audio.slice(0, 2)) {
        const candidate = await toCandidate(format, client.label, info.signatureTimestamp)
        if (!candidate) continue
        const probeResult = await probe(candidate.url)
        if (!probeResult.ok) {
          reasons.push(`${client.label}: ${probeResult.reason}`)
          excludeClient(key)
          continue
        }
        return {
          videoId,
          url: candidate.url,
          mimeType: candidate.mimeType,
          bitrate: candidate.bitrate,
          codec: candidate.codec,
          client: candidate.client,
          expiresAt: Date.now() + 5 * 60 * 60 * 1000,
          duration: Number(response?.videoDetails?.lengthSeconds ?? 0),
        }
      }
    } catch (error) {
      if (error instanceof PlayerFailure) throw error
      reasons.push(`${client.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reason = reasons.at(-1) ?? "No playable audio stream"
  throw new PlayerFailure(reason, false)
}

function score(format: any, preferredItag: number): number {
  const itag = Number(format.itag)
  const preferred = itag === preferredItag ? 300_000 : 0
  return preferred + Number(format.bitrate ?? 0)
}

async function toCandidate(format: any, client: string, signatureTimestamp: number): Promise<Candidate | null> {
  const raw = format.url ?? format.signatureCipher ?? format.cipher
  if (!raw) return null
  const url = format.url ? format.url : await decipher(raw, signatureTimestamp)
  if (!url) return null
  return {
    url,
    mimeType: String(format.mimeType ?? "audio/mp4"),
    bitrate: Number(format.bitrate ?? 0),
    codec: String(format.mimeType ?? "").split(";")[0] ?? "audio",
    client,
  }
}

export type ProbeResult = { ok: true } | { ok: false; reason: string }

/** Probe past 1 MiB with the exact media headers before handing a URL to the player (DOC §9.7). */
export async function probe(url: string): Promise<ProbeResult> {
  const headers = mediaHeadersFor(url)
  headers.Range = "bytes=1048576-1064960"
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      await res.body?.cancel()
      return { ok: false, reason: `media refused (${res.status})` }
    }
    if (!res.ok && res.status !== 206) {
      await res.body?.cancel()
      return { ok: false, reason: `media probe failed (${res.status})` }
    }
    const type = res.headers.get("content-type") ?? ""
    if (!type.startsWith("audio/")) {
      await res.body?.cancel()
      return { ok: false, reason: `unexpected content type: ${type || "none"}` }
    }
    let received = 0
    if (res.body) {
      const reader = res.body.getReader()
      while (received < 16384) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
      }
      await reader.cancel().catch(() => undefined)
    }
    if (received < 16384) return { ok: false, reason: `short media probe (${received} bytes)` }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `probe error: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const SONGS_PARAM = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"

/** Resolve an official music video to its audio-track counterpart when possible. */
export async function resolveMusicTrack(videoId: string): Promise<string> {
  const cached = cacheGet<string>(`musicTrack:${videoId}`)
  if (cached) return cached

  let response: any
  try {
    const info = await getClientInfo()
    response = await innertube(
      "player",
      {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: { signatureTimestamp: info.signatureTimestamp },
        },
      },
      { signed: false, client: CLIENTS[0], retries: 1 },
    )
  } catch (webError) {
    try {
      const info = await getClientInfo()
      response = await innertube(
        "player",
        {
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: {
            contentPlaybackContext: { signatureTimestamp: info.signatureTimestamp },
          },
        },
        { signed: false, client: CLIENTS[3], retries: 1 },
      )
    } catch {
      console.log("[resolveMusicTrack] player failed", webError instanceof Error ? webError.message : String(webError))
      cacheSet(`musicTrack:${videoId}`, videoId, 60 * 60 * 1000)
      return videoId
    }
  }

  const details = response?.videoDetails ?? {}
  const type = details.musicVideoType
  if (type !== "MUSIC_VIDEO_TYPE_OMV") {
    cacheSet(`musicTrack:${videoId}`, videoId, 24 * 60 * 60 * 1000)
    return videoId
  }

  const title = typeof details.title === "string" ? details.title : ""
  const author = typeof details.author === "string" ? details.author.replace(/\s*-\s*Topic$/i, "") : ""
  const query = `${title} ${author}`.trim()
  if (!query) {
    cacheSet(`musicTrack:${videoId}`, videoId, 60 * 60 * 1000)
    return videoId
  }

  try {
    const searchJson = await innertube("search", { query, params: SONGS_PARAM }, { signed: false })
    const page = parseBrowsePage(searchJson, query)
    const candidates = page.shelves.flatMap((shelf) => shelf.items).filter((item) => item.kind === "track")
    const audioTrack = candidates.find(
      (item) => item.musicVideoType === "MUSIC_VIDEO_TYPE_ATV" && item.id !== videoId,
    )
    const resolved = audioTrack?.id ?? videoId
    cacheSet(`musicTrack:${videoId}`, resolved, 24 * 60 * 60 * 1000)
    return resolved
  } catch {
    cacheSet(`musicTrack:${videoId}`, videoId, 60 * 60 * 1000)
    return videoId
  }
}

export class PlayerFailure extends Error {
  permanent: boolean
  constructor(reason: string, permanent: boolean) {
    super(reason)
    this.permanent = permanent
  }
}

function isPermanent(reason: string): boolean {
  return /\b(age|region|country|private|terminated|premium|paid|removed)\b|age-restricted|age restricted/i.test(reason)
}

function readableReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim()
}
