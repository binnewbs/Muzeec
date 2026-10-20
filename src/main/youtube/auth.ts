import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import type { AuthState, AuthUser } from "../../shared/types.ts"
import { CHROME_UA, clearCookieCache, cookieHeader, hasSession, signingCookie, ytSession } from "./session.ts"
import { sapisidHash } from "./sapisid.ts"

const file = () => path.join(app.getPath("userData"), "auth.json")
const clientFile = () => path.join(app.getPath("userData"), "client-info.json")
const SHELL_CACHE_MS = 6 * 60 * 60 * 1000
const PROFILE_ORIGIN = "https://music.youtube.com"

let scope: AuthUser | null = null
let loaded = false
let profileTried = false
let clientInfo: { clientVersion: string; visitorData: string; signatureTimestamp: number } | null = null
let shellFetchedAt = 0

function load(): void {
  if (loaded) return
  loaded = true
  try {
    scope = JSON.parse(fs.readFileSync(file(), "utf8"))
  } catch {
    scope = null
  }
}

export function getScope(): AuthUser | null {
  load()
  return scope
}

export function saveScope(next: AuthUser): void {
  scope = next
  loaded = true
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2))
}

export function clearScope(): void {
  scope = null
  loaded = true
  profileTried = false
  fs.rmSync(file(), { force: true })
  fs.rmSync(clientFile(), { force: true })
  clientInfo = null
  shellFetchedAt = 0
  clearCookieCache()
}

export async function authState(): Promise<AuthState> {
  const hasCookies = await hasSession()
  if (!hasCookies && getScope()) clearScope()
  const signedIn = hasCookies && Boolean(getScope()?.loggedIn)
  if (signedIn) await refreshProfile()
  return { signedIn, user: signedIn ? getScope() : null }
}

/** Fill name/avatar left null by an older sign-in or a failed profile request. One attempt per session. */
async function refreshProfile(): Promise<void> {
  const current = getScope()
  if (!current || (current.name && current.avatar) || profileTried) return
  profileTried = true
  try {
    const info = await getClientInfo()
    const profile = await fetchProfile(await cookieHeader(), current, info)
    if (profile.name || profile.avatar) saveScope({ ...current, ...profile })
  } catch {
    // Keep the fallback label; a fresh sign-in retries.
  }
}

/** Live WEB_REMIX client version, visitor data and signature timestamp (DOC §8.2, §16). */
export async function getClientInfo(): Promise<{
  clientVersion: string
  visitorData: string
  signatureTimestamp: number
}> {
  const persisted = loadPersistedClientInfo()
  if (persisted) return persisted
  const cookie = await cookieHeader()
  const res = await fetch("https://music.youtube.com/", {
    headers: {
      "User-Agent": CHROME_UA,
      "Accept-Language": "en-US,en;q=0.9",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  })
  const html = await res.text()
  const clientVersion = /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const shellVisitor = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const playerJs = /"(?:jsUrl|PLAYER_JS_URL)"\s*:\s*"([^"]+base\.js[^"]*)"/.exec(html)?.[1]
  let sts = /"STS"\s*:\s*(\d+)/.exec(html)?.[1] ?? /"signatureTimestamp"\s*:\s*(\d+)/.exec(html)?.[1]
  if (!sts && playerJs) {
    try {
      const js = await fetch(new URL(playerJs, "https://www.youtube.com").toString(), {
        headers: { "User-Agent": CHROME_UA },
      }).then((r) => r.text())
      sts = /signatureTimestamp\s*[:=]\s*(\d+)/.exec(js)?.[1]
    } catch {
      // Fall through to the default; a stale STS is retried on the next player request.
    }
  }
  const visitorData = shellVisitor ?? getScope()?.visitorData ?? (await anonymousVisitorData())
  if (!clientVersion) throw new Error("Could not read live YouTube Music client version")
  clientInfo = { clientVersion, visitorData, signatureTimestamp: sts ? Number(sts) : 20000 }
  shellFetchedAt = Date.now()
  persistClientInfo(clientInfo, shellFetchedAt)
  return clientInfo
}

/** Reuse the last known shell config across launches; avoids a homepage fetch at startup. */
function loadPersistedClientInfo(): typeof clientInfo {
  if (clientInfo && Date.now() - shellFetchedAt < SHELL_CACHE_MS) return clientInfo
  try {
    const saved = JSON.parse(fs.readFileSync(clientFile(), "utf8")) as Record<string, unknown>
    const fetchedAt = Number(saved.fetchedAt)
    const signatureTimestamp = Number(saved.signatureTimestamp)
    if (
      typeof saved.clientVersion === "string" &&
      typeof saved.visitorData === "string" &&
      Number.isFinite(signatureTimestamp) &&
      Number.isFinite(fetchedAt) &&
      Date.now() - fetchedAt < SHELL_CACHE_MS
    ) {
      clientInfo = {
        clientVersion: saved.clientVersion,
        // A signed-in session must keep using its own visitor id, not the cached anonymous one.
        visitorData: getScope()?.visitorData ?? saved.visitorData,
        signatureTimestamp,
      }
      shellFetchedAt = fetchedAt
      return clientInfo
    }
  } catch {
    // No usable persisted shell config.
  }
  return null
}

function persistClientInfo(
  info: { clientVersion: string; visitorData: string; signatureTimestamp: number },
  fetchedAt: number,
): void {
  try {
    fs.mkdirSync(path.dirname(clientFile()), { recursive: true })
    fs.writeFileSync(clientFile(), JSON.stringify({ ...info, fetchedAt }))
  } catch {
    // A missing cache only costs one extra homepage fetch on the next launch.
  }
}

async function anonymousVisitorData(): Promise<string> {
  const data = await fetch("https://www.youtube.com/sw.js_data", { headers: { "User-Agent": CHROME_UA } }).then((r) =>
    r.text(),
  )
  const match = /Cg[A-Za-z0-9_%-]{40,}/.exec(data)
  if (!match) throw new Error("Could not obtain visitor data")
  return match[0]
}

export type CapturedConfig = {
  authUser: string | null
  pageId: string | null
  dataSyncId: string | null
  visitorData: string | null
  clientVersion: string | null
}

export async function captureSession(config: CapturedConfig): Promise<AuthUser> {
  if (!(await signingCookie())) throw new Error("Sign-in incomplete: no signing cookie")
  if (!config.authUser) throw new Error("Sign-in incomplete: no account index")
  const info = await getClientInfo()
  const cookie = await cookieHeader()
  const profile = await fetchProfile(cookie, config, info)
  const user: AuthUser = {
    loggedIn: true,
    authUser: Number(config.authUser),
    dataSyncId: config.dataSyncId,
    pageId: config.pageId,
    visitorData: config.visitorData ?? info.visitorData,
    clientVersion: config.clientVersion ?? info.clientVersion,
    name: profile.name,
    avatar: profile.avatar,
  }
  saveScope(user)
  clearCookieCache()
  return user
}

type ProfileContext = {
  authUser: string | number | null
  pageId: string | null
  visitorData: string | null
}

/** Best-effort profile label for the account menu. Never blocks sign-in. */
async function fetchProfile(
  cookie: string,
  context: ProfileContext,
  info: { clientVersion: string; visitorData: string },
): Promise<{ name: string | null; avatar: string | null }> {
  try {
    const signing = await signingCookie()
    const visitorData = context.visitorData ?? info.visitorData
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": CHROME_UA,
      Cookie: cookie,
      "X-Origin": PROFILE_ORIGIN,
      Origin: PROFILE_ORIGIN,
      Referer: `${PROFILE_ORIGIN}/`,
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": info.clientVersion,
      "X-Goog-Visitor-Id": visitorData,
      "X-Goog-AuthUser": String(context.authUser),
    }
    if (signing) headers.Authorization = sapisidHash(signing, PROFILE_ORIGIN)
    if (context.pageId) headers["X-Goog-PageId"] = context.pageId
    const res = await fetch(`${PROFILE_ORIGIN}/youtubei/v1/account/account_menu?prettyPrint=false`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: info.clientVersion,
            hl: "en",
            gl: "US",
            visitorData,
          },
          user: {
            lockedSafetyMode: false,
            ...(context.pageId ? { onBehalfOfUser: context.pageId } : {}),
          },
        },
      }),
    })
    if (!res.ok) return { name: null, avatar: null }
    const json: any = await res.json()
    const header = findKey(json, "activeAccountHeaderRenderer")
    return {
      name: textOf(header?.accountName),
      avatar: header?.accountPhoto?.thumbnails?.at(-1)?.url ?? null,
    }
  } catch {
    return { name: null, avatar: null }
  }
}

function findKey(node: any, key: string): any {
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

function textOf(node: any): string | null {
  if (!node) return null
  if (typeof node.simpleText === "string") return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => r.text ?? "").join("")
  return null
}

export async function logout(): Promise<void> {
  const yt = ytSession()
  clearCookieCache(yt)
  await yt.clearStorageData({
    storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
  })
  const cookies = await yt.cookies.get({})
  await Promise.all(
    cookies
      .filter((c) => /google|youtube/i.test(c.domain ?? ""))
      .map((c) =>
        yt.cookies.remove(`https://${c.domain?.replace(/^\./, "")}${c.path ?? "/"}`, c.name).catch(() => undefined),
      ),
  )
  clearScope()
}
