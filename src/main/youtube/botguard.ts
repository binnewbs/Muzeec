import { BrowserWindow } from "electron"
import https from "node:https"
import { CHROME_UA } from "./session.ts"
import { getClientInfo, getScope } from "./auth.ts"
import { parseChallenge, parseIntegrityToken } from "./botguard-challenge.ts"
import pageHtml from "./botguard-page.html?raw"

/**
 * BotGuard PoTokens for YouTube's web clients (DOC §9.5).
 *
 * YouTube gates signed-in web playback on a visitor-bound token in
 * `serviceIntegrityDimensions.poToken` and a video-bound `pot` on the media
 * URL. Both are minted in a hidden sandboxed BrowserWindow: the interpreter
 * needs a real browser realm, and the integrity token is bound to YouTube's
 * Origin, so GenerateIT is sent from the main process with that header rather
 * than from the app:// page.
 */

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo"
const GOOGLE_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw"
const CREATE_URL = "https://www.youtube.com/api/jnn/v1/Create"
const GENERATE_URL = "https://www.youtube.com/api/jnn/v1/GenerateIT"
const YOUTUBE_ORIGIN = "https://www.youtube.com"

const REQUEST_TIMEOUT_MS = 12_000
const PAGE_TIMEOUT_MS = 10_000
const INIT_TIMEOUT_MS = 20_000
const MINT_TIMEOUT_MS = 10_000
/** BitChord waits 8 s for a token; a cold page gets a little longer here. */
const TOKEN_WAIT_MS = 15_000
/** Integrity tokens are reused until ten minutes before they lapse. */
const TTL_MARGIN_MS = 10 * 60_000
const MIN_SESSION_MS = 60_000
const FAILURE_BACKOFF_MS = 30_000
const MAX_TOKENS = 500

const DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`

type Session = {
  window: BrowserWindow
  visitorData: string
  expiresAt: number
  tokens: Map<string, string>
  dead: boolean
}

let current: Session | null = null
let queue: Promise<unknown> = Promise.resolve()
let retryAt = 0

class TimeoutError extends Error {}

/**
 * A visitor-bound token for the player request's `serviceIntegrityDimensions`.
 * Safe to call on every player request; an already-minted token is reused.
 */
export async function visitorToken(visitorData: string): Promise<string | null> {
  return mintToken(`visitor:${visitorData}`, visitorData, visitorData)
}

/** A video-bound token for the media URL's `pot` parameter. */
export async function videoToken(videoId: string, visitorData: string): Promise<string | null> {
  return mintToken(`video:${videoId}`, videoId, visitorData)
}

/** Load BotGuard ahead of the first track; failures only make that track slower. */
export function warmBotGuard(): void {
  void (async () => {
    try {
      const info = await getClientInfo()
      await visitorToken(getScope()?.visitorData ?? info.visitorData)
    } catch {
      // Playback mints its own token; warm-up is best-effort only.
    }
  })()
}

export function destroyBotGuard(): void {
  resetBotGuard()
}

/** Drop the current BotGuard page so the next mint starts from a new challenge. */
export function resetBotGuard(): void {
  destroySession()
}

async function mintToken(key: string, identifier: string, visitorData: string): Promise<string | null> {
  if (!visitorData || Date.now() < retryAt) return null

  const operation = exclusive(async () => {
    let session: Session
    try {
      session = await ensureSession(visitorData)
    } catch (error) {
      retryAt = Date.now() + FAILURE_BACKOFF_MS
      throw error
    }

    const cached = session.tokens.get(key)
    if (cached) return cached

    const started = Date.now()
    const token = await withTimeout(
      session.window.webContents.executeJavaScript(`window.__muzeecBotGuard.mint(${jsLiteral(identifier)})`),
      MINT_TIMEOUT_MS,
      "PoToken mint",
    )
    if (typeof token !== "string" || !token) throw new Error("BotGuard returned an empty token")
    session.tokens.set(key, token)
    // Video tokens are the unbounded half of the cache; keep the session's
    // visitor token and only evict the oldest video entries.
    if (session.tokens.size > MAX_TOKENS) {
      for (const cachedKey of session.tokens.keys()) {
        if (cachedKey.startsWith("video:")) {
          session.tokens.delete(cachedKey)
          break
        }
      }
    }
    console.log(
      `[botguard] minted ${key.split(":")[0]} token (${token.length} chars, ${Date.now() - started}ms)`,
    )
    return token
  })

  operation.catch((error) => {
    if (error instanceof TimeoutError) destroySession()
    console.log(`[botguard] ${key.split(":")[0]} token failed: ${messageOf(error)}`)
  })

  return settleWithin(operation, TOKEN_WAIT_MS)
}

async function ensureSession(visitorData: string): Promise<Session> {
  if (
    current &&
    !current.dead &&
    !current.window.isDestroyed() &&
    current.visitorData === visitorData &&
    Date.now() < current.expiresAt
  ) {
    return current
  }
  destroySession()
  current = await createSession(visitorData)
  return current
}

async function createSession(visitorData: string): Promise<Session> {
  const started = Date.now()
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    webPreferences: {
      // In-memory partition: BotGuard needs no cookies and must never touch the
      // signed-in YouTube session.
      partition: "botguard",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: false,
    },
  })
  window.webContents.setUserAgent(CHROME_UA)
  window.webContents.setAudioMuted(true)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event) => event.preventDefault())

  const session: Session = { window, visitorData, expiresAt: 0, tokens: new Map(), dead: false }
  window.on("closed", () => {
    session.dead = true
    if (current === session) current = null
  })
  window.webContents.on("render-process-gone", () => {
    session.dead = true
  })

  try {
    await withTimeout(window.loadURL(DATA_URL), PAGE_TIMEOUT_MS, "BotGuard page")

    const challenge = parseChallenge(await postJnn(CREATE_URL, [REQUEST_KEY], false))
    if (!challenge) throw new Error("BotGuard returned no challenge")

    const response = await withTimeout(
      window.webContents.executeJavaScript(`window.__muzeecBotGuard.run(${jsLiteral(challenge)})`),
      INIT_TIMEOUT_MS,
      "BotGuard challenge",
    )
    if (typeof response !== "string" || !response) throw new Error("BotGuard returned no snapshot")

    const integrity = parseIntegrityToken(await postJnn(GENERATE_URL, [REQUEST_KEY, response], true))
    if (!integrity) throw new Error("BotGuard returned no integrity token")

    await withTimeout(
      window.webContents.executeJavaScript(
        `window.__muzeecBotGuard.createMinter(${jsLiteral(Array.from(integrity.token))})`,
      ),
      INIT_TIMEOUT_MS,
      "BotGuard minter",
    )

    session.expiresAt = Date.now() + Math.max(integrity.ttlSeconds * 1000 - TTL_MARGIN_MS, MIN_SESSION_MS)
    console.log(
      `[botguard] ready in ${Date.now() - started}ms (${Math.round((session.expiresAt - Date.now()) / 60_000)} min)`,
    )
    return session
  } catch (error) {
    destroyWindow(window)
    throw error
  }
}

function destroySession(): void {
  const session = current
  current = null
  if (!session) return
  session.dead = true
  destroyWindow(session.window)
}

function destroyWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy()
}

/** POST a JNN endpoint. GenerateIT must carry YouTube's own Origin. */
function postJnn(url: string, body: unknown[], withOrigin: boolean): Promise<unknown> {
  const payload = JSON.stringify(body)
  const headers: Record<string, string | number> = {
    Accept: "application/json",
    "Content-Type": "application/json+protobuf",
    "X-Goog-Api-Key": GOOGLE_API_KEY,
    "X-User-Agent": "grpc-web-javascript/0.1",
    "User-Agent": CHROME_UA,
    "Content-Length": Buffer.byteLength(payload),
  }
  if (withOrigin) {
    headers.Origin = YOUTUBE_ORIGIN
    headers.Referer = `${YOUTUBE_ORIGIN}/`
  }

  const name = new URL(url).pathname.split("/").at(-1)
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", headers, timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("error", reject)
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${name} answered ${response.statusCode}`))
          return
        }
        const text = Buffer.concat(chunks).toString("utf8")
        if (!text) {
          reject(new Error(`${name} answered an empty body`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`${name} answered invalid JSON`))
        }
      })
    })
    request.on("timeout", () => request.destroy(new TimeoutError(`${name} timed out`)))
    request.on("error", reject)
    request.end(payload)
  })
}

/** One BotGuard page serves one request at a time. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Stop waiting without cancelling: a slow first mint still finishes in the background. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 300)
}
