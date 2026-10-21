/**
 * BotGuard response parsing (DOC §9.5).
 *
 * The Create endpoint answers either with the challenge array itself or with a
 * scrambled Base64 string; both shapes are decoded here so the browser page only
 * ever receives plain fields.
 */

export type BotGuardChallenge = {
  interpreterJavascript: string
  interpreterHash: string
  program: string
  globalName: string
  clientExperimentsStateBlob: string
}

const BASE64URL = /[-_.]/g

function base64UrlToBytes(value: string): Buffer {
  const map: Record<string, string> = { "-": "+", _: "/", ".": "=" }
  const normalized = value.replace(BASE64URL, (char) => map[char] ?? char)
  return Buffer.from(normalized, "base64")
}

/** Scrambled challenges add 97 to every byte before Base64url encoding. */
function descramble(value: string): string {
  const bytes = base64UrlToBytes(value)
  for (let index = 0; index < bytes.length; index++) bytes[index] = (bytes[index] + 97) & 0xff
  return bytes.toString("utf8")
}

export function parseChallenge(raw: unknown): BotGuardChallenge | null {
  if (!Array.isArray(raw) || !raw.length) return null

  let data: unknown
  if (raw.length > 1 && typeof raw[1] === "string") {
    try {
      data = JSON.parse(descramble(raw[1]))
    } catch {
      return null
    }
  } else if (Array.isArray(raw[0])) {
    data = raw[0]
  } else {
    return null
  }
  if (!Array.isArray(data)) return null

  const interpreterWrappers = data[1]
  const interpreterHash = text(data[3])
  const program = text(data[4])
  const globalName = text(data[5])
  const clientExperimentsStateBlob = text(data[7]) ?? ""
  const interpreterJavascript = Array.isArray(interpreterWrappers)
    ? interpreterWrappers.find((value) => typeof value === "string" && value.length > 0)
    : undefined

  if (!interpreterJavascript || !program || !globalName) return null

  return {
    interpreterJavascript,
    interpreterHash: interpreterHash ?? "",
    program,
    globalName,
    clientExperimentsStateBlob,
  }
}

export type IntegrityToken = { token: Uint8Array; ttlSeconds: number }

/** GenerateIT answers `[base64urlToken, lifetimeSeconds]`. */
export function parseIntegrityToken(raw: unknown): IntegrityToken | null {
  if (!Array.isArray(raw) || typeof raw[0] !== "string" || !raw[0]) return null
  const token = base64UrlToBytes(raw[0])
  if (!token.length) return null
  const seconds = Number(raw[1])
  // GenerateIT has been seen without a lifetime; a conservative hour keeps the
  // session usable without ever minting tokens from a stale integrity token.
  const ttlSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600
  return { token, ttlSeconds }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
