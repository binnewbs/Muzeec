import { contextBridge, ipcRenderer } from "electron"
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

const api: MuzeecApi = {
  authState: () => call("yt:authState"),
  login: () => call("yt:login"),
  logout: () => call("yt:logout"),
  browse: (input) => call("yt:browse", input),
  search: (input) => call("yt:search", input),
  player: (input) => call("yt:player", input),
  like: (input) => call("yt:like", input),
  playlistCreate: (input) => call("yt:playlistCreate", input),
  playlistAdd: (input) => call("yt:playlistAdd", input),
  playlistDelete: (input) => call("yt:playlistDelete", input),
  subscribe: (input) => call("yt:subscribe", input),
  history: (input) => call("yt:history", input),
  lyrics: (input) => call("lyrics:get", input),
  lyricsProviders: () => call("lyrics:providers"),
  lyricsClearCache: () => call("lyrics:clearCache"),
  getSettings: () => call("sys:settingsGet"),
  setSettings: (patch) => call("sys:settingsSet", patch),
  setPlayerState: (state) => call("sys:playerState", state),
  onMediaKey: (callback) => {
    const listener = (_event: unknown, action: "playpause" | "next" | "previous") => callback(action)
    ipcRenderer.on("sys:mediaKey", listener)
    return () => ipcRenderer.removeListener("sys:mediaKey", listener)
  },
}

contextBridge.exposeInMainWorld("muzeec", api)
