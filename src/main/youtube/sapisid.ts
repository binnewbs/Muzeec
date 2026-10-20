import { createHash } from "node:crypto"

export function sapisidHash(secret: string, origin: string, now = Date.now()): string {
  const timestamp = Math.floor(now / 1000)
  const digest = createHash("sha1").update(`${timestamp} ${secret} ${origin}`).digest("hex")
  return `SAPISIDHASH ${timestamp}_${digest}`
}
