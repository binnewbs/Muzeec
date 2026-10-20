import { cacheGet } from "../storage/cache.ts"
import { CHROME_UA, cookieHeader, signingCookie } from "./session.ts"
import { getClientInfo, getScope } from "./auth.ts"
import { sapisidHash } from "./sapisid.ts"
import type { HistoryEvent } from "../../shared/types.ts"
import { getSettings } from "../storage/settings.ts"

type Play = { cpn: string; started: number; lastWatchtime: number; urlBase: string }

const plays = new Map<string, Play>()
const ORIGIN = "https://music.youtube.com"

/** 3-ping play tracking: playback → atr → watchtime (+final). Best effort only (DOC §11.2). */
export async function trackHistory({ videoId, event, position, duration }: HistoryEvent): Promise<void> {
  if (!getSettings().historyEnabled) return
  if (!getScope()) return
  const tracking = cacheGet<any>(`tracking:${videoId}`)
  if (!tracking) return

  if (event === "start") {
    const cpn = randomCpn()
    plays.set(videoId, { cpn, started: Date.now(), lastWatchtime: 0, urlBase: tracking.watchtimeUrl ?? "" })
    await ping(tracking.playbackUrl, cpn)
    if (tracking.atrUrl) {
      setTimeout(() => void ping(tracking.atrUrl, cpn), 3000).unref?.()
    }
    return
  }

  const play = plays.get(videoId)
  if (!play) return
  if (event === "progress") {
    if (Date.now() - play.lastWatchtime < 30_000) return
    play.lastWatchtime = Date.now()
    await watchtime(play, position, duration, false)
    return
  }
  plays.delete(videoId)
  await watchtime(play, position, duration, true)
}

function randomCpn(): string {
  return Array.from({ length: 16 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"[
    Math.floor(Math.random() * 64)
  ]).join("")
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

async function ping(template: string | null, cpn: string): Promise<void> {
  if (!template) return
  try {
    const headers = await signedHeaders()
    if (!headers) return
    const url = new URL(template)
    url.searchParams.set("cpn", cpn)
    await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  } catch {
    // History is never on the playback critical path.
  }
}

async function watchtime(play: Play, position: number, duration: number, final: boolean): Promise<void> {
  if (!play.urlBase) return
  try {
    const headers = await signedHeaders()
    if (!headers) return
    const info = await getClientInfo()
    const url = new URL(play.urlBase)
    url.searchParams.set("cpn", play.cpn)
    url.searchParams.set("st", String(Math.floor(play.started / 1000)))
    url.searchParams.set("et", String(Math.floor(position)))
    url.searchParams.set("el", "detailpage")
    url.searchParams.set("ver", "2")
    url.searchParams.set("c", "WEB_REMIX")
    url.searchParams.set("cver", info.clientVersion)
    url.searchParams.set("cplayer", "UNIPLAYER")
    url.searchParams.set("cbr", "Chrome")
    url.searchParams.set("cos", "Windows")
    url.searchParams.set("final", final ? "1" : "0")
    if (duration) url.searchParams.set("len", String(Math.floor(duration)))
    await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  } catch {
    // Ignore.
  }
}

export function flushHistory(): void {
  plays.clear()
}
