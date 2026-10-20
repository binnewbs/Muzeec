import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import type { AppSettings } from "../../shared/types.ts"

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

const file = () => path.join(app.getPath("userData"), "settings.json")

export function getSettings(): AppSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), "utf8")) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}
