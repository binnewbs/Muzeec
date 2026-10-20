import { CHROME_UA, cookieHeader, signingCookie } from "./session.ts"
import { getClientInfo, getScope } from "./auth.ts"
import { getWebTracking } from "./player.ts"
import { sapisidHash } from "./sapisid.ts"
import type { HistoryEvent } from "../../shared/types.ts"
import { getSettings } from "../storage/settings.ts"

type TrackingUrl = string | { baseUrl?: string } | null | undefined

type Play = {
  cpn: string
  startedAt: number
  lastWatchtime: number
  lastPosition: number
  playbackUrl: string | null
  watchtimeUrl: string | null
  duration: number
}

const plays = new Map<string, Play>()
const ORIGIN = "https://music.youtube.com"
const WATCHTIME_INTERVAL_MS = 30_000

/** 3-ping play tracking: playback → watchtime (+final). Best effort only (DOC §11.2). */
export async function trackHistory({ videoId, event, position, duration }: HistoryEvent): Promise<void> {
  if (!getSettings().historyEnabled) return
  if (!getScope()) return
  const tracking = await getWebTracking(videoId)
  if (!tracking) return

  if (event === "start") {
    const play: Play = {
      cpn: randomCpn(),
      startedAt: Date.now(),
      lastWatchtime: Date.now(),
      lastPosition: Math.max(0, position),
      playbackUrl: baseUrl(tracking.videostatsPlaybackUrl),
      watchtimeUrl: baseUrl(tracking.videostatsWatchtimeUrl),
      duration: duration > 0 ? duration : 0,
    }
    plays.set(videoId, play)
    await send(playbackPing(play))
    return
  }

  const play = plays.get(videoId)
  if (!play) return
  if (event === "progress") {
    if (Date.now() - play.lastWatchtime < WATCHTIME_INTERVAL_MS) return
    play.lastWatchtime = Date.now()
    await send(watchtimePing(play, position, false))
    play.lastPosition = Math.max(0, position)
    return
  }
  plays.delete(videoId)
  await send(watchtimePing(play, position, true))
}

function baseUrl(node: TrackingUrl): string | null {
  if (!node) return null
  if (typeof node === "string") return node
  return typeof node.baseUrl === "string" ? node.baseUrl : null
}

function randomCpn(): string {
  return Array.from({ length: 16 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"[
    Math.floor(Math.random() * 64)
  ]).join("")
}

function playbackPing(play: Play): URL | null {
  if (!play.playbackUrl) return null
  const url = new URL(play.playbackUrl)
  url.searchParams.set("ver", "2")
  url.searchParams.set("c", "WEB_REMIX")
  url.searchParams.set("cpn", play.cpn)
  return url
}

function watchtimePing(play: Play, position: number, final: boolean): URL | null {
  if (!play.watchtimeUrl) return null
  const url = new URL(play.watchtimeUrl)
  const end = Math.max(0, position)
  url.searchParams.set("ver", "2")
  url.searchParams.set("c", "WEB_REMIX")
  url.searchParams.set("cpn", play.cpn)
  url.searchParams.set("cmt", end.toFixed(3))
  url.searchParams.set("st", play.lastPosition.toFixed(3))
  url.searchParams.set("et", end.toFixed(3))
  url.searchParams.set("state", final ? "ended" : "playing")
  url.searchParams.set("rt", elapsed(play).toFixed(3))
  url.searchParams.set("final", final ? "1" : "0")
  if (play.duration > 0) url.searchParams.set("len", play.duration.toFixed(3))
  return url
}

function elapsed(play: Play): number {
  return Math.max(0, (Date.now() - play.startedAt) / 1000)
}

async function signedHeaders(): Promise<Record<string, string> | null> {
  const signing = await signingCookie()
  const cookie = await cookieHeader()
  if (!signing) return null
  const info = await getClientInfo()
  const scope = getScope()
  return {
    "User-Agent": CHROME_UA,
    Cookie: cookie,
    Authorization: sapisidHash(signing, ORIGIN),
    "X-Goog-AuthUser": String(scope?.authUser ?? 0),
    ...(scope?.pageId ? { "X-Goog-PageId": scope.pageId } : {}),
    "X-Goog-Visitor-Id": info.visitorData,
    "X-Origin": ORIGIN,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
  }
}

async function send(url: URL | null): Promise<void> {
  if (!url) return
  try {
    const headers = await signedHeaders()
    if (!headers) return
    await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  } catch {
    // History is never on the playback critical path.
  }
}

export function flushHistory(): void {
  plays.clear()
}
