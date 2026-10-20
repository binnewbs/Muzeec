import { CHROME_UA, cookieHeader, signingCookie } from "./session.ts"
import { getClientInfo, getScope } from "./auth.ts"
import { sapisidHash } from "./sapisid.ts"

const ORIGIN = "https://music.youtube.com"

export type InnertubeOptions = {
  signed?: boolean
  retries?: number
  client?: {
    name: string
    id: number
    version?: string
    ua?: string
    context?: Record<string, unknown>
  }
}

/** POST an InnerTube endpoint. Auth, origin and retries live here, never in the renderer. */
export async function innertube<T = any>(
  endpoint: string,
  body: Record<string, unknown> = {},
  { signed = true, retries = 2, client }: InnertubeOptions = {},
): Promise<T> {
  const info = await getClientInfo()
  const scope = signed ? getScope() : null
  const cookie = scope ? await cookieHeader() : ""
  const signing = scope ? await signingCookie() : null
  const clientName = client?.name ?? "WEB_REMIX"
  const clientVersion = client?.version ?? info.clientVersion
  const visitorData = scope?.visitorData ?? info.visitorData
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": client?.ua ?? CHROME_UA,
    "X-YouTube-Client-Name": String(client?.id ?? 67),
    "X-YouTube-Client-Version": clientVersion,
    "X-Goog-Visitor-Id": visitorData,
    "Accept-Language": "en-US,en;q=0.9",
  }
  // VISIONOS refuses a web Origin/Referer (DOC §9.6).
  if (clientName !== "VISIONOS") {
    headers["X-Origin"] = ORIGIN
    headers.Origin = ORIGIN
    headers.Referer = `${ORIGIN}/`
  }
  if (cookie) headers.Cookie = cookie
  if (signing) headers.Authorization = sapisidHash(signing, ORIGIN)
  if (scope) {
    headers["X-Goog-AuthUser"] = String(scope.authUser)
    if (scope.pageId) headers["X-Goog-PageId"] = scope.pageId
  }

  const payload = {
    ...body,
    context: {
      client: {
        clientName,
        clientVersion,
        hl: "en",
        gl: "US",
        visitorData,
        ...client?.context,
      },
      user: {
        lockedSafetyMode: false,
        ...(scope?.pageId ? { onBehalfOfUser: scope.pageId } : {}),
      },
      request: { useSsl: true },
    },
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 350 * 2 ** attempt))
    try {
      const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      // Retry transient server/rate-limit failures; fail fast on auth or bad requests.
      if (res.status >= 500 || res.status === 429) throw new RetryableError(`InnerTube ${endpoint} ${res.status}`)
      if (!res.ok) throw new Error(`InnerTube ${endpoint} ${res.status}`)
      const json = (await res.json()) as T & { error?: { message?: string } }
      if (json && json.error?.message) throw new Error(json.error.message)
      return json
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

class RetryableError extends Error {}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true
  // fetch() network failures and timeout aborts are worth one more attempt.
  return error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
}
