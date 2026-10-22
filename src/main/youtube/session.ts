import { app, session, type Session } from "electron"

export const YT_PARTITION = "persist:youtube"
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
export const VISIONOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"

export const SIGNING_COOKIES = ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"] as const

export function ytSession(): Session {
  return session.fromPartition(YT_PARTITION)
}

const MEDIA_HEADER_BY_CLIENT: Record<string, { origin?: string; referer?: string; ua?: string }> = {
  VISIONOS: { ua: VISIONOS_UA },
  WEB_REMIX: { origin: "https://music.youtube.com", referer: "https://music.youtube.com/" },
  WEB: { origin: "https://www.youtube.com", referer: "https://www.youtube.com/" },
  MWEB: {
    origin: "https://m.youtube.com",
    referer: "https://m.youtube.com/",
    ua: MOBILE_UA,
  },
}

export function mediaHeadersFor(url: string): Record<string, string> {
  const client = new URL(url).searchParams.get("c") ?? "WEB_REMIX"
  const conf = MEDIA_HEADER_BY_CLIENT[client] ?? MEDIA_HEADER_BY_CLIENT.WEB_REMIX
  const headers: Record<string, string> = { "User-Agent": conf.ua ?? CHROME_UA }
  if (conf.origin) headers.Origin = conf.origin
  if (conf.referer) headers.Referer = conf.referer
  return headers
}

export async function cookieHeader(sess = ytSession()): Promise<string> {
  return (await cookieBundle(sess)).header
}

export async function signingCookie(sess = ytSession()): Promise<string | null> {
  return (await cookieBundle(sess)).signing
}

const COOKIE_CACHE_MS = 30_000
type CookieBundle = { at: number; header: string; signing: string | null }
const cookieCaches = new WeakMap<Session, CookieBundle>()

/** One Chromium cookie round-trip per request burst instead of two per InnerTube call. */
async function cookieBundle(sess: Session): Promise<CookieBundle> {
  const cached = cookieCaches.get(sess)
  if (cached && Date.now() - cached.at < COOKIE_CACHE_MS) return cached

  const cookies = await sess.cookies.get({ url: "https://music.youtube.com" })
  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
  let signing: string | null = null
  for (const name of SIGNING_COOKIES) {
    const hit = cookies.find((c) => c.name === name)
    if (hit) {
      signing = hit.value
      break
    }
  }
  const bundle = { at: Date.now(), header, signing }
  cookieCaches.set(sess, bundle)
  return bundle
}

/** Invalidate after sign-in, sign-out, or any cookie mutation. */
export function clearCookieCache(sess = ytSession()): void {
  cookieCaches.delete(sess)
}

export async function hasSession(sess = ytSession()): Promise<boolean> {
  return (await signingCookie(sess)) !== null
}

/** Header rewriters shared by UI, auth and media requests (DOC §6.2, §9.6). */
export function installSessionRewriters(): void {
  const yt = ytSession()
  yt.webRequest.onBeforeSendHeaders(
    { urls: ["*://*.googlevideo.com/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      Object.assign(headers, mediaHeadersFor(details.url))
      if (new URL(details.url).searchParams.get("c") === "VISIONOS") {
        delete headers.Origin
        delete headers.Referer
      }
      callback({ requestHeaders: headers })
    },
  )
  yt.webRequest.onHeadersReceived(
    { urls: ["*://*.googlevideo.com/*"] },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders }
      // MediaElementSource would otherwise silence cross-origin googlevideo audio;
      // the renderer's volume normalizer reads through this header. Replace any
      // upstream value case-insensitively: signed-in WEB_REMIX responses already
      // send `Access-Control-Allow-Origin: https://music.youtube.com`, and adding
      // `*` alongside it makes Chromium reject the response.
      for (const name of Object.keys(responseHeaders)) {
        if (
          name.toLowerCase() === "access-control-allow-origin" ||
          name.toLowerCase() === "access-control-expose-headers"
        ) {
          delete responseHeaders[name]
        }
      }
      responseHeaders["Access-Control-Allow-Origin"] = ["*"]
      responseHeaders["Access-Control-Expose-Headers"] = ["*"]
      callback({ responseHeaders })
    },
  )
  yt.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}
