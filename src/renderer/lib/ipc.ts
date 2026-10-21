import type {
  AppSettings,
  AuthState,
  BrowseChunk,
  BrowsePage,
  HistoryEvent,
  LyricsProviderInfo,
  LyricsRequest,
  LyricsResult,
  PlayerDecision,
  PlayerState,
  Rating,
  SpotifyImportProgress,
  SpotifyImportResult,
  Track,
} from "@shared/types"

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export type MuzeecApi = {
  authState: () => Promise<Result<AuthState>>
  login: () => Promise<Result<AuthState>>
  logout: () => Promise<Result<AuthState>>
  browse: (input: { browseId: string }) => Promise<Result<BrowsePage>>
  browseMore: (input: { browseId: string; cursor: string }) => Promise<Result<BrowseChunk>>
  search: (input: { query: string }) => Promise<Result<BrowsePage>>
  radio: (input: { videoId: string }) => Promise<Result<Track[]>>
  player: (input: { videoId: string }) => Promise<Result<PlayerDecision>>
  musicTrack: (input: { videoId: string }) => Promise<Result<string>>
  like: (input: { videoId: string; rating: Rating }) => Promise<Result<void>>
  playlistCreate: (input: { title: string; videoId?: string }) => Promise<Result<string>>
  playlistAdd: (input: { playlistId: string; videoId: string }) => Promise<Result<void>>
  playlistDelete: (input: { playlistId: string }) => Promise<Result<void>>
  spotifyImport: (input: { url: string; jobId: string }) => Promise<Result<SpotifyImportResult>>
  spotifyCancel: (input: { jobId: string }) => Promise<Result<boolean>>
  subscribe: (input: { channelId: string; subscribed: boolean; params?: string | null }) => Promise<Result<void>>
  history: (input: HistoryEvent) => Promise<Result<void>>
  lyrics: (input: LyricsRequest) => Promise<Result<LyricsResult | null>>
  lyricsProviders: () => Promise<Result<LyricsProviderInfo[]>>
  lyricsClearCache: () => Promise<Result<boolean>>
  getSettings: () => Promise<Result<AppSettings>>
  setSettings: (patch: Partial<AppSettings>) => Promise<Result<AppSettings>>
  setPlayerState: (state: PlayerState) => Promise<Result<boolean>>
  windowMinimize: () => Promise<Result<void>>
  windowToggleMaximize: () => Promise<Result<void>>
  windowMaximized: () => Promise<Result<boolean>>
  windowQuit: () => Promise<Result<void>>
  onWindowMaximized: (callback: (maximized: boolean) => void) => () => void
  onMediaKey: (callback: (action: "playpause" | "next" | "previous") => void) => () => void
  onSpotifyProgress: (callback: (progress: SpotifyImportProgress) => void) => () => void
}

declare global {
  interface Window {
    muzeec: MuzeecApi
  }
}

export const api: MuzeecApi = window.muzeec

export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const res = await result
  if (!res.ok) throw new Error(res.error)
  return res.data
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
