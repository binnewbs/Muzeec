import type { MediaItem } from "../../shared/types.ts"
import type { MatchCandidate } from "./matcher.ts"

/** Convert a parsed YouTube Music row into the matcher's candidate model. */
export function candidateOf(track: MediaItem): MatchCandidate {
  const subtitleParts = track.subtitle ? track.subtitle.split(/\s*[•·]\s*/).filter(Boolean) : []
  const artists =
    track.artists?.map((artist) => artist.name).filter(Boolean) ??
    (subtitleParts.length ? [subtitleParts[0]] : [])
  const album =
    track.album?.name ??
    (subtitleParts[1] && !/^\d{4}$/.test(subtitleParts[1]) ? subtitleParts[1] : null)

  return {
    videoId: track.id,
    title: track.title,
    artists,
    album,
    durationSec: typeof track.duration === "number" ? track.duration : null,
    explicit: null,
    musicVideoType: track.musicVideoType ?? null,
  }
}
