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

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  return formatDuration(seconds)
}
