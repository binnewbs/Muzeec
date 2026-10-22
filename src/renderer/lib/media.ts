import type { MediaItem, Track } from "@shared/types"

/** Playlist browse IDs carry a `VL` prefix on some pages only. */
export function barePlaylistId(id: string): string {
  return id.startsWith("VL") ? id.slice(2) : id
}

export function toTrack(item: MediaItem): Track {
  return { ...item, kind: "track", videoId: item.id }
}

export function tracksOf(items: MediaItem[]): Track[] {
  return items.filter((item) => item.kind === "track").map(toTrack)
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds) return ""
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Human-readable collection length, e.g. "1 hr 24 min". */
export function formatTotalDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const minutes = Math.max(1, Math.round(seconds / 60))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours && rest) return `${hours} hr ${rest} min`
  if (hours) return `${hours} hr`
  return `${rest} min`
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  return formatDuration(seconds)
}
