export type AuthUser = {
  loggedIn: boolean
  authUser: number
  dataSyncId: string | null
  pageId: string | null
  visitorData: string | null
  clientVersion: string | null
  name: string | null
  avatar: string | null
}

export type Thumbnail = { url: string; width: number; height: number }

export type ArtistRef = { name: string; id: string | null }

export type MediaKind = "track" | "album" | "artist" | "playlist"

export type MediaItem = {
  kind: MediaKind
  id: string
  title: string
  subtitle: string
  thumbnail: string | null
  duration?: number
  artists?: ArtistRef[]
  album?: { name: string; id: string | null } | null
  year?: string | null
  musicVideoType?: string | null
  /** Per-playlist entry key; required for reordering or removing a playlist item. */
  setVideoId?: string | null
}

export type Shelf = {
  title: string
  items: MediaItem[]
}

export type PageHeader = {
  title: string
  subtitle: string
  thumbnail: string | null
  description: string
  channelId: string | null
  subscribed: boolean
  subscriptionParams: string | null
  artists: ArtistRef[]
}

export type BrowsePage = {
  title: string
  shelves: Shelf[]
  header?: PageHeader | null
  /** Opaque token for the next chunk when the page is a paged collection. */
  continuation?: string | null
  /** Index of the main track shelf that continuation chunks belong to. */
  trackListIndex?: number | null
}

export type BrowseChunk = {
  items: MediaItem[]
  continuation: string | null
}

export type Track = MediaItem & { kind: "track"; videoId: string }

export type PlayerDecision = {
  videoId: string
  url: string
  mimeType: string
  bitrate: number
  codec: string
  client: string
  expiresAt: number
  duration: number
  /** Integrated loudness in LKFS/LUFS (ITU-R BS.1770); null when unavailable. */
  loudnessLufs: number | null
}

export type PlayerError = {
  videoId: string
  reason: string
  permanent: boolean
}

export type HistoryEvent = {
  videoId: string
  event: "start" | "progress" | "end"
  position: number
  duration: number
}

export type LyricsProviderInfo = {
  id: string
  label: string
  description: string
  wordSynced: boolean
}

export type LyricSyllable = {
  startMs: number
  endMs: number
  startChar: number
  endChar: number
}

export type LyricWord = {
  startMs: number
  endMs: number
  text: string
  syllables: LyricSyllable[]
}

export type LyricLine = {
  timeMs: number
  text: string
  words: LyricWord[]
  sungUntilMs?: number | null
  background?: LyricLine | null
  alignment: "start" | "end"
  timingSource?: LyricLine | null
  voice?: string | null
}

export type LyricsResult = {
  source: string
  label: string
  wordSynced: boolean
  synced: boolean
  lines: LyricLine[]
}

export type LyricsRequest = {
  videoId: string
  title: string
  artist: string
  album?: string | null
  durationMs?: number
  isrc?: string | null
  retry?: boolean
}

/**
 * A song saved under `userData/downloads`. The manifest is self-contained so
 * the Downloaded Music page can render offline without a network round-trip.
 */
export type DownloadedTrack = {
  videoId: string
  /** Original id when the download came from an official music video. */
  sourceVideoId?: string | null
  title: string
  subtitle: string
  thumbnail: string | null
  duration: number
  artists?: ArtistRef[]
  album?: { name: string; id: string | null } | null
  year?: string | null
  musicVideoType?: string | null
  /** File name relative to the downloads directory. */
  file: string
  mimeType: string
  bitrate: number
  size: number
  downloadedAt: number
  hasLyrics: boolean
}

export type DownloadStatus = "resolving" | "downloading" | "lyrics" | "completed" | "error"

export type DownloadProgress = {
  videoId: string
  sourceVideoId?: string | null
  title: string
  status: DownloadStatus
  received: number
  total: number
  error?: string
}

/** Playlist pinned to the sidebar; metadata is cached so the sidebar needs no network at startup. */
export type PinnedPlaylist = {
  id: string
  title: string
  thumbnail: string | null
}

export type AppSettings = {
  volume: number
  volumeNormalization: boolean
  quality: "high" | "normal"
  lowMemory: boolean
  crossfadeEnabled: boolean
  crossfadeSeconds: number
  gaplessEnabled: boolean
  historyEnabled: boolean
  theme: "dark" | "light" | "system"
  lyricsEnabled: boolean
  lyricsSources: string[]
  lyricsPreferSyllableTiming: boolean
  lyricsOffsetMs: number
  lyricsRomanize: boolean
  discordPresence: boolean
  lastTrack: Track | null
  lastPosition: number
  searchHistory: string[]
  pinnedPlaylists: PinnedPlaylist[]
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Neutral track model shared by Spotify readers and the catalogue matcher. */
export type SpotifyTrack = {
  sourceId: string
  title: string
  artists: string[]
  album: string | null
  durationMs: number | null
  isrc: string | null
  artworkUrl: string | null
  explicit: boolean | null
}

export type SpotifyPlaylist = {
  id: string
  name: string
  cover: string | null
  tracks: SpotifyTrack[]
  /** Podcast episodes, local files and other non-track rows. */
  skipped: number
  /** True when Spotify's page limited the import to the first 100 entries. */
  truncated: boolean
}

export type SpotifyImportPhase = "reading" | "matching" | "creating" | "adding"

export type SpotifyImportProgress = {
  jobId: string
  phase: SpotifyImportPhase
  done: number
  total: number
}

export type SpotifyUnmatchedTrack = {
  title: string
  artists: string[]
  reason: string
}

export type SpotifyImportResult = {
  playlistId: string
  title: string
  total: number
  matched: number
  added: number
  skipped: number
  truncated: boolean
  unmatched: SpotifyUnmatchedTrack[]
  warning: string | null
}

export type Rating = "like" | "dislike" | "none"

export type AuthState = {
  signedIn: boolean
  user: AuthUser | null
}

export type PlayerState = {
  playing: boolean
  videoId: string | null
  title: string
  artist: string
  album?: string | null
  thumbnail?: string | null
  /** Track length in seconds. */
  duration?: number
  /** Current playhead in seconds. */
  position?: number
}
