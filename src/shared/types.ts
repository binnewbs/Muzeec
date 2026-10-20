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
}

export type PlayerError = {
  videoId: string
  reason: string
  permanent: boolean
}

export type PlaybackTracking = {
  playbackUrl: string | null
  atrUrl: string | null
  watchtimeUrl: string | null
  cpn: string
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

export type AppSettings = {
  volume: number
  quality: "high" | "normal"
  lowMemory: boolean
  historyEnabled: boolean
  theme: "dark" | "light" | "system"
  lyricsEnabled: boolean
  lyricsSources: string[]
  lyricsPreferSyllableTiming: boolean
  lyricsOffsetMs: number
  lastTrack: Track | null
  lastPosition: number
  searchHistory: string[]
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

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
}
