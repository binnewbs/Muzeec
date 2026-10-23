/**
 * Discord Rich Presence configuration.
 *
 * Create an application at https://discord.com/developers/applications and
 * paste its Application ID below. Rich Presence stays disabled while this is
 * empty. For local development, `MUZEEC_DISCORD_CLIENT_ID` overrides it.
 *
 * Optional art assets, uploaded under Rich Presence → Art Assets:
 *   - `muzeec`  fallback when a track has no artwork
 *   - `playing` small badge while playing
 *   - `paused`  small badge while paused
 */
const APPLICATION_ID = "1563181670914465802"

export const DISCORD_CLIENT_ID =
  process.env.MUZEEC_DISCORD_CLIENT_ID?.trim() || APPLICATION_ID.trim()

/** Optional second button; leave empty to show only the YouTube Music link. */
export const PROJECT_URL = ""

/** Discord rate-limits SET_ACTIVITY to one update per 15 seconds. */
export const UPDATE_INTERVAL_MS = 15_000

/** Discord allows a handful of connections per minute; keep retries slow. */
export const RECONNECT_INTERVAL_MS = 30_000
