/**
 * Classification and reporting for player fallback walks.
 *
 * Every client that refuses a track produces a reason. Reporting only the last
 * one hides the real cause behind whichever client happens to be the final
 * fallback, so the walk collects typed reasons and picks the most useful one.
 */

export type FailureKind = "bot" | "playability" | "probe" | "formats" | "request"

export type PlayerFailureReason = {
  label: string
  reason: string
  kind: FailureKind
}

/** Shown when YouTube wants proof the caller is a person; the gate follows the network, not the video. */
export const BOT_CHECK_MESSAGE = "YouTube asked for a bot check on this network — sign in or switch networks"

/**
 * YouTube answers web clients with LOGIN_REQUIRED/UNPLAYABLE and a bot-check
 * reason when it distrusts the requesting IP. The reason text uses a curly
 * apostrophe, so match the shape rather than the exact quote.
 */
export function isBotCheck(status: string | undefined, reason: string): boolean {
  if (status !== "LOGIN_REQUIRED" && status !== "UNPLAYABLE") return false
  return /confirm you.{0,3}re not a bot|unusual traffic|automated (queries|requests)/i.test(reason)
}

export function isPermanent(reason: string): boolean {
  return /\b(age|region|country|private|terminated|premium|paid|removed)\b|age-restricted|age restricted/i.test(reason)
}

export function readableReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim()
}

/** Most actionable first: a refusal reason beats an HTTP/decode failure. */
const PRIORITY: FailureKind[] = ["playability", "probe", "formats", "request"]

/**
 * Pick the message to surface to the user. A bot check wins because it is the
 * only failure the user can act on without changing the track.
 */
export function pickFailureMessage(reasons: PlayerFailureReason[]): string | null {
  if (reasons.some((failure) => failure.kind === "bot")) return BOT_CHECK_MESSAGE
  for (const kind of PRIORITY) {
    const hit = reasons.find((failure) => failure.kind === kind)
    if (hit) return `${hit.label}: ${hit.reason}`
  }
  return null
}
