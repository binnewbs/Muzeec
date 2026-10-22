import type { Track } from "@shared/types"
import { shuffled } from "../lib/shuffle.ts"

/** How many previous tracks stay navigable. */
export const HISTORY_LIMIT = 50

/**
 * Previous-track stack when starting a collection at `index`, oldest first so
 * `pop()` yields the song immediately before the clicked one.
 */
export function initialHistory(tracks: Track[], index: number): Track[] {
  return tracks.slice(0, index).slice(-HISTORY_LIMIT)
}

/** Next pass through an album/playlist/queue when Loop All is active. */
export function nextInCycle(
  cycle: Track[],
  currentId: string | undefined,
  shuffle: boolean,
): { track: Track; upcoming: Track[] } | null {
  if (!cycle.length) return null
  const index = cycle.findIndex((track) => track.videoId === currentId)
  const track = cycle[index >= 0 ? (index + 1) % cycle.length : 0]
  const start = cycle.findIndex((entry) => entry.videoId === track.videoId)
  const upcoming = cycle.length > 1 ? [...cycle.slice(start + 1), ...cycle.slice(0, start)] : []
  return { track, upcoming: shuffle ? shuffled(upcoming) : upcoming }
}
