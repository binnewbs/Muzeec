import type { PlayerDecision } from "../../shared/types.ts"
import { getSettings } from "../storage/settings.ts"
import { cacheGet, cacheSet } from "../storage/cache.ts"
import { VISIONOS_UA, mediaHeadersFor } from "./session.ts"
import { innertube } from "./innertube.ts"
import { getClientInfo, getScope } from "./auth.ts"
import { resetBotGuard, videoToken } from "./botguard.ts"
import { decipher } from "./decipher.ts"
import { parseBrowsePage } from "./parser.ts"
import {
  isBotCheck,
  isPermanent,
  pickFailureMessage,
  readableReason,
  type PlayerFailureReason,
} from "./player-failures.ts"

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
    { client: CLIENTS[0], retries: 0, integrity: false },
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
  const visitorData = getScope()?.visitorData ?? info.visitorData
  // Signed web clients carry the account's PoToken and return the full stream;
  // VISIONOS remains the fallback. Unsigned playback tries VISIONOS' direct
  // URLs first, then the web clients.
  const order = signedIn
    ? [CLIENTS[0], CLIENTS[1], CLIENTS[3], CLIENTS[2]]
    : [CLIENTS[3], CLIENTS[0], CLIENTS[1], CLIENTS[2]]
  const reasons: PlayerFailureReason[] = []

  for (const client of order) {
    const key = `${videoId}:${client.name}`
    const excludedUntil = exclusions.get(key)
    if (excludedUntil && excludedUntil > Date.now()) continue

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await attemptClient(client, videoId, signedIn, info.signatureTimestamp, visitorData)
      if (result.kind === "decision") return result.decision
      if (result.kind === "permanent") throw result.failure
      reasons.push(result.reason)
      if (!result.retry || attempt > 0) break
      // A refusal that follows the page, not the track, is usually a bad BotGuard
      // session: drop it and mint fresh visitor/video tokens for one retry.
      resetBotGuard()
      console.log(`[player] ${videoId}: retrying ${client.label} with a fresh BotGuard page`)
    }
  }

  const detail = [...new Set(reasons.map((r) => `${r.label} — ${r.reason}`))].join(" | ")
  console.log(`[player] ${videoId}: ${detail || "no clients left"}`)
  const message = pickFailureMessage(reasons)
  throw new PlayerFailure(message ?? "No playable audio stream", false)
}

type ClientAttempt =
  | { kind: "decision"; decision: PlayerDecision }
  | { kind: "reason"; reason: PlayerFailureReason; retry: boolean }
  | { kind: "permanent"; failure: PlayerFailure }

/** One player request plus its media probes for a single client. */
async function attemptClient(
  client: Client,
  videoId: string,
  signedIn: boolean,
  signatureTimestamp: number,
  visitorData: string,
): Promise<ClientAttempt> {
  const key = `${videoId}:${client.name}`
  try {
    const response: any = await innertube(
      "player",
      {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: { signatureTimestamp },
        },
      },
      { signed: signedIn && client.name === "WEB_REMIX", client, retries: 1 },
    )
    const status = response?.playabilityStatus
    if (status?.status !== "OK") {
      const reason = readableReason(status?.reason ?? status?.status ?? "Refused")
      if (isBotCheck(status?.status, reason)) {
        // The gate follows the requester's network, not the track, so retrying
        // after a VPN change should not wait out the per-track exclusion.
        return { kind: "reason", reason: { label: client.label, reason, kind: "bot" }, retry: false }
      }
      if (isPermanent(reason)) {
        rememberVerdict(videoId, reason)
        return { kind: "permanent", failure: new PlayerFailure(reason, true) }
      }
      excludeClient(key)
      return { kind: "reason", reason: { label: client.label, reason, kind: "playability" }, retry: false }
    }

    const formats: any[] = response?.streamingData?.adaptiveFormats ?? []
    const preferredItag = getSettings().quality === "normal" ? 140 : 251
    const audio = formats
      .filter((f) => String(f.mimeType ?? "").startsWith("audio/"))
      .sort((a, b) => score(b, preferredItag) - score(a, preferredItag))
    if (!audio.length) {
      excludeClient(key)
      return {
        kind: "reason",
        reason: { label: client.label, reason: "no audio formats", kind: "formats" },
        retry: false,
      }
    }

    const tracking = response?.playbackTracking
    if (tracking) {
      if (client.name === "WEB_REMIX") cacheSet(trackingKey(videoId), tracking, 30 * 60 * 1000)
      else if (signedIn) void ensureWebTracking(videoId)
    }

    let candidates = 0
    let refused: ProbeResult | null = null
    // Signed web URLs need the video-bound `pot` even when the visitor token
    // already unlocked the player response.
    const pot =
      client.name !== "VISIONOS" && audio.some((format) => format.url || format.signatureCipher || format.cipher)
        ? await videoToken(videoId, visitorData)
        : null
    for (const format of audio.slice(0, 2)) {
      const candidate = await toCandidate(format, client.label, signatureTimestamp, pot)
      if (!candidate) continue
      candidates += 1
      const probeResult = await probe(candidate.url)
      if (!probeResult.ok) {
        // Media refusals track the network, not the client: a retry after a
        // VPN change should resolve fresh URLs instead of waiting out an exclusion.
        refused = probeResult
        continue
      }
      return {
        kind: "decision",
        decision: {
          videoId,
          url: candidate.url,
          mimeType: candidate.mimeType,
          bitrate: candidate.bitrate,
          codec: candidate.codec,
          client: candidate.client,
          expiresAt: Date.now() + 5 * 60 * 60 * 1000,
          duration: Number(response?.videoDetails?.lengthSeconds ?? 0),
        },
      }
    }
    if (refused) {
      return {
        kind: "reason",
        reason: { label: client.label, reason: refused.reason, kind: "probe" },
        retry: client.name !== "VISIONOS",
      }
    }
    if (!candidates) {
      // WEB clients answer with SABR bodies and no direct URL; there is nothing to probe.
      excludeClient(key)
      return {
        kind: "reason",
        reason: { label: client.label, reason: "no direct audio URL (SABR only)", kind: "formats" },
        retry: false,
      }
    }
    return {
      kind: "reason",
      reason: { label: client.label, reason: "no playable audio format", kind: "formats" },
      retry: false,
    }
  } catch (error) {
    if (error instanceof PlayerFailure) return { kind: "permanent", failure: error }
    return {
      kind: "reason",
      reason: {
        label: client.label,
        reason: error instanceof Error ? error.message : String(error),
        kind: "request",
      },
      retry: false,
    }
  }
}

function score(format: any, preferredItag: number): number {
  const itag = Number(format.itag)
  const preferred = itag === preferredItag ? 300_000 : 0
  return preferred + Number(format.bitrate ?? 0)
}

async function toCandidate(
  format: any,
  client: string,
  signatureTimestamp: number,
  pot: string | null,
): Promise<Candidate | null> {
  const raw = format.url ?? format.signatureCipher ?? format.cipher
  if (!raw) return null
  const url = format.url ? format.url : await decipher(raw, signatureTimestamp)
  if (!url) return null
  return {
    url: pot ? withPot(url, pot) : url,
    mimeType: String(format.mimeType ?? "audio/mp4"),
    bitrate: Number(format.bitrate ?? 0),
    codec: String(format.mimeType ?? "").split(";")[0] ?? "audio",
    client,
  }
}

/** googlevideo refuses a web-client URL without the video-bound PoToken. */
function withPot(url: string, pot: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set("pot", pot)
    return parsed.toString()
  } catch {
    return url
  }
}

export type ProbeResult = { ok: true } | { ok: false; reason: string }

/**
 * Probe a media URL with the exact headers and ranges the player will use
 * (DOC §9.7). The media element opens with `Range: bytes=0-`; googlevideo
 * refuses that range for web-client URLs that lack a PoToken even though a
 * bounded range still answers 206, so the first check must mirror playback.
 */
export async function probe(url: string): Promise<ProbeResult> {
  const headers = mediaHeadersFor(url)
  const start = await probeRange(url, headers, "bytes=0-")
  if (!start.ok) return start
  // A start-only check would miss throttled or truncated mid-file responses.
  // Ask for a whole MiB past the first MiB (BitChord's probe) and accept the
  // first 16 KiB: unbounded reads are throttled, so the range stays finite.
  return probeRange(url, headers, "bytes=1048576-2097152")
}

const PROBE_BYTES = 16_384

async function probeRange(
  url: string,
  baseHeaders: Record<string, string>,
  range: string,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      headers: { ...baseHeaders, Range: range },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      const parsed = new URL(url)
      const body = await res.text().catch(() => "")
      console.log(
        `[probe] ${res.status} c=${parsed.searchParams.get("c")} itag=${parsed.searchParams.get("itag")} ` +
          `pot=${(parsed.searchParams.get("pot") ?? "").length} body=${body.slice(0, 120).replace(/\s+/g, " ")}`,
      )
      return { ok: false, reason: `media refused (${res.status})` }
    }
    if (!res.ok && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined)
      return { ok: false, reason: `media probe failed (${res.status})` }
    }
    const type = res.headers.get("content-type") ?? ""
    if (!type.startsWith("audio/")) {
      await res.body?.cancel().catch(() => undefined)
      return { ok: false, reason: `unexpected content type: ${type || "none"}` }
    }
    let received = 0
    if (res.body) {
      const reader = res.body.getReader()
      while (received < PROBE_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
      }
      await reader.cancel().catch(() => undefined)
    }
    if (received < PROBE_BYTES) return { ok: false, reason: `short media probe (${received} bytes)` }
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
      { signed: false, client: CLIENTS[0], retries: 1, integrity: false },
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
        { signed: false, client: CLIENTS[3], retries: 1, integrity: false },
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
