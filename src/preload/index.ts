import { contextBridge, ipcRenderer } from "electron"
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
} from "../shared/types.ts"

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function call<T>(channel: string, payload?: unknown): Promise<Result<T>> {
  try {
    return { ok: true, data: (await ipcRenderer.invoke(channel, payload)) as T }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

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

const api: MuzeecApi = {
  authState: () => call("yt:authState"),
  login: () => call("yt:login"),
  logout: () => call("yt:logout"),
  browse: (input) => call("yt:browse", input),
  browseMore: (input) => call("yt:browseMore", input),
  search: (input) => call("yt:search", input),
  radio: (input) => call("yt:radio", input),
  player: (input) => call("yt:player", input),
  musicTrack: (input) => call("yt:musicTrack", input),
  like: (input) => call("yt:like", input),
  playlistCreate: (input) => call("yt:playlistCreate", input),
  playlistAdd: (input) => call("yt:playlistAdd", input),
  playlistDelete: (input) => call("yt:playlistDelete", input),
  spotifyImport: (input) => call("spotify:import", input),
  spotifyCancel: (input) => call("spotify:cancel", input),
  subscribe: (input) => call("yt:subscribe", input),
  history: (input) => call("yt:history", input),
  lyrics: (input) => call("lyrics:get", input),
  lyricsProviders: () => call("lyrics:providers"),
  lyricsClearCache: () => call("lyrics:clearCache"),
  getSettings: () => call("sys:settingsGet"),
  setSettings: (patch) => call("sys:settingsSet", patch),
  setPlayerState: (state) => call("sys:playerState", state),
  windowMinimize: () => call("sys:windowMinimize"),
  windowToggleMaximize: () => call("sys:windowToggleMaximize"),
  windowMaximized: () => call("sys:windowMaximized"),
  windowQuit: () => call("sys:windowQuit"),
  onWindowMaximized: (callback) => {
    const listener = (_event: unknown, maximized: boolean) => callback(maximized)
    ipcRenderer.on("sys:windowMaximized", listener)
    return () => ipcRenderer.removeListener("sys:windowMaximized", listener)
  },
  onMediaKey: (callback) => {
    const listener = (_event: unknown, action: "playpause" | "next" | "previous") => callback(action)
    ipcRenderer.on("sys:mediaKey", listener)
    return () => ipcRenderer.removeListener("sys:mediaKey", listener)
  },
  onSpotifyProgress: (callback) => {
    const listener = (_event: unknown, progress: SpotifyImportProgress) => callback(progress)
    ipcRenderer.on("spotify:progress", listener)
    return () => ipcRenderer.removeListener("spotify:progress", listener)
  },
}

contextBridge.exposeInMainWorld("muzeec", api)
