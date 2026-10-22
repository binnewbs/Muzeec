import type { DownloadedTrack, DownloadProgress, Track } from "@shared/types"

export function downloadedToTrack(item: DownloadedTrack): Track {
  return {
    kind: "track",
    id: item.videoId,
    videoId: item.videoId,
    title: item.title,
    subtitle: item.subtitle,
    thumbnail: item.thumbnail,
    duration: item.duration,
    artists: item.artists,
    album: item.album ?? null,
    year: item.year ?? null,
    musicVideoType: item.musicVideoType ?? "MUSIC_VIDEO_TYPE_ATV",
  }
}

export function downloadMatches(item: DownloadedTrack, videoId: string): boolean {
  return item.videoId === videoId || item.sourceVideoId === videoId
}

export function downloadFor(items: DownloadedTrack[], videoId: string): DownloadedTrack | null {
  return items.find((item) => downloadMatches(item, videoId)) ?? null
}

export function downloadPercent(progress: DownloadProgress): number {
  if (!progress.total) return 0
  return Math.min(100, Math.max(0, Math.round((progress.received / progress.total) * 100)))
}

export function downloadLabel(progress: DownloadProgress): string {
  if (progress.status === "resolving") return "Preparing…"
  if (progress.status === "lyrics") return "Saving lyrics…"
  if (progress.status === "error") return "Download failed"
  if (progress.status === "completed") return "Downloaded"
  return progress.total ? `Downloading ${downloadPercent(progress)}%` : "Downloading…"
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB"
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}
