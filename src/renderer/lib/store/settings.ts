import { create } from "zustand"
import type { AppSettings } from "@shared/types"
import { api, unwrap } from "@/lib/ipc"
import { clearQueryCache } from "@/lib/query"

const DEFAULTS: AppSettings = {
  volume: 0.8,
  quality: "high",
  lowMemory: false,
  historyEnabled: true,
  theme: "system",
  lyricsEnabled: true,
  lyricsSources: ["lrc-red", "bini", "unison", "lrclib", "genius"],
  lyricsPreferSyllableTiming: false,
  lyricsOffsetMs: 0,
  lastTrack: null,
  lastPosition: 0,
  searchHistory: [],
}

type SettingsStore = {
  settings: AppSettings
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
}

export function applyTheme(theme: AppSettings["theme"]): void {
  const dark =
    theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULTS,
  load: async () => {
    const settings = await unwrap(api.getSettings()).catch(() => DEFAULTS)
    set({ settings })
    applyTheme(settings.theme)
  },
  update: async (patch) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    if (patch.theme) applyTheme(patch.theme)
    // Free memory immediately when low-memory mode is switched on.
    if (patch.lowMemory !== undefined) clearQueryCache()
    await unwrap(api.setSettings(patch)).catch(() => undefined)
  },
}))
