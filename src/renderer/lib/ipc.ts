import type {
  AppSettings,
  AuthState,
  BrowsePage,
  HistoryEvent,
  LyricsProviderInfo,
  LyricsRequest,
  LyricsResult,
  PlayerDecision,
  PlayerState,
  Rating,
} from "@shared/types"

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export type MuzeecApi = {
  authState: () => Promise<Result<AuthState>>
  login: () => Promise<Result<AuthState>>
  logout: () => Promise<Result<AuthState>>
  browse: (input: { browseId: string }) => Promise<Result<BrowsePage>>
  search: (input: { query: string }) => Promise<Result<BrowsePage>>
  player: (input: { videoId: string }) => Promise<Result<PlayerDecision>>
  like: (input: { videoId: string; rating: Rating }) => Promise<Result<void>>
  playlistCreate: (input: { title: string; videoId?: string }) => Promise<Result<string>>
  playlistAdd: (input: { playlistId: string; videoId: string }) => Promise<Result<void>>
  playlistDelete: (input: { playlistId: string }) => Promise<Result<void>>
  subscribe: (input: { channelId: string; subscribed: boolean; params?: string | null }) => Promise<Result<void>>
  history: (input: HistoryEvent) => Promise<Result<void>>
  lyrics: (input: LyricsRequest) => Promise<Result<LyricsResult | null>>
  lyricsProviders: () => Promise<Result<LyricsProviderInfo[]>>
  lyricsClearCache: () => Promise<Result<boolean>>
  getSettings: () => Promise<Result<AppSettings>>
  setSettings: (patch: Partial<AppSettings>) => Promise<Result<AppSettings>>
  setPlayerState: (state: PlayerState) => Promise<Result<boolean>>
  onMediaKey: (callback: (action: "playpause" | "next" | "previous") => void) => () => void
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
