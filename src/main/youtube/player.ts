import type { PlayerDecision } from "../../shared/types.ts"
import { getSettings } from "../storage/settings.ts"
import { cacheGet, cacheSet } from "../storage/cache.ts"
import { VISIONOS_UA, mediaHeadersFor } from "./session.ts"
import { innertube } from "./innertube.ts"
import { getClientInfo } from "./auth.ts"
import { decipher } from "./decipher.ts"

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
const exclusions = new Map<string, number>()
const inflight = new Map<string, Promise<PlayerDecision>>()
export const verdicts = new Map<string, { reason: string; expires: number }>()

export function clearPlayerCaches(): void {
  exclusions.clear()
  verdicts.clear()
  inflight.clear()
}

export async function resolvePlayer(videoId: string, signedIn: boolean): Promise<PlayerDecision> {
  const cached = verdicts.get(videoId)
  if (cached && cached.expires > Date.now()) throw new PlayerFailure(cached.reason, true)

  const existing = inflight.get(videoId)
  if (existing) return existing

  const promise = resolveWalk(videoId, signedIn).finally(() => inflight.delete(videoId))
  inflight.set(videoId, promise)
  return promise
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
          verdicts.set(videoId, { reason, expires: Date.now() + VERDICT_MS })
          throw new PlayerFailure(reason, true)
        }
        exclusions.set(key, Date.now() + EXCLUDE_MS)
        continue
      }

      const formats: any[] = response?.streamingData?.adaptiveFormats ?? []
      const audio = formats
        .filter((f) => String(f.mimeType ?? "").startsWith("audio/"))
        .sort((a, b) => score(b) - score(a))
      if (!audio.length) {
        reasons.push(`${client.label}: no audio formats`)
        exclusions.set(key, Date.now() + EXCLUDE_MS)
        continue
      }

      const tracking = response?.playbackTracking
      if (tracking) {
        cacheSet(`tracking:${videoId}`, tracking, 30 * 60 * 1000)
      }

      for (const format of audio.slice(0, 2)) {
        const candidate = await toCandidate(format, client.label, info.signatureTimestamp)
        if (!candidate) continue
        const probeResult = await probe(candidate.url)
        if (!probeResult.ok) {
          reasons.push(`${client.label}: ${probeResult.reason}`)
          exclusions.set(key, Date.now() + EXCLUDE_MS)
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

function score(format: any): number {
  const itag = Number(format.itag)
  const preferredItag = getSettings().quality === "normal" ? 140 : 251
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
