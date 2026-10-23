import type { PlayerState } from "../../shared/types.ts"

const MAX_TEXT = 128
const MAX_BUTTON_LABEL = 32
const WATCH_URL = "https://music.youtube.com/watch?v="

/**
 * The subset of Discord's activity object this app uses. `type: 2` is
 * "Listening"; Discord only accepts Playing, Listening, Watching and Competing
 * for Rich Presence updates.
 */
export type PresenceActivity = {
  type: 2
  details: string
  state: string
  details_url?: string
  timestamps?: { start: number; end: number }
  assets: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
  buttons?: Array<{ label: string; url: string }>
  instance: boolean
}

export type ActivityOptions = {
  projectUrl?: string
  /** Overridable for tests. */
  now?: number
}

export function truncate(value: string, max: number): string {
  const text = value.trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Builds the card. Returns null when there is nothing to show, which clears the
 * presence instead of leaving a stale track behind.
 */
export function presenceActivity(
  state: PlayerState,
  options: ActivityOptions = {},
): PresenceActivity | null {
  const videoId = typeof state.videoId === "string" ? state.videoId.trim() : ""
  const title = typeof state.title === "string" ? state.title.trim() : ""
  if (!videoId || !title) return null

  const now = options.now ?? Date.now()
  const duration = Math.max(0, Number(state.duration) || 0)
  const rawPosition = Math.max(0, Number(state.position) || 0)
  const position = duration > 0 ? Math.min(rawPosition, duration) : rawPosition
  const watchUrl = `${WATCH_URL}${encodeURIComponent(videoId)}`

  const activity: PresenceActivity = {
    type: 2,
    details: truncate(title, MAX_TEXT),
    state: truncate(state.artist?.trim() || "YouTube Music", MAX_TEXT),
    details_url: watchUrl,
    assets: {
      large_image:
        typeof state.thumbnail === "string" && state.thumbnail.startsWith("https://")
          ? state.thumbnail
          : "muzeec",
      large_text: truncate(
        typeof state.album === "string" && state.album.trim() ? state.album : title,
        MAX_TEXT,
      ),
      small_image: state.playing ? "playing" : "paused",
      small_text: state.playing ? "Playing" : "Paused",
    },
    instance: false,
  }

  // Discord draws the progress bar from these timestamps, so the app never has
  // to send a position every second. Pausing drops them so the bar freezes.
  if (state.playing && duration > position) {
    activity.timestamps = {
      start: Math.round((now - position * 1000) / 1000),
      end: Math.round((now + (duration - position) * 1000) / 1000),
    }
  }

  const buttons: Array<{ label: string; url: string }> = [
    { label: truncate("Listen on YouTube Music", MAX_BUTTON_LABEL), url: watchUrl },
  ]
  const projectUrl = options.projectUrl?.trim()
  if (projectUrl && /^https:\/\//.test(projectUrl)) {
    buttons.push({ label: truncate("Get Muzeec", MAX_BUTTON_LABEL), url: projectUrl })
  }
  activity.buttons = buttons

  return activity
}
