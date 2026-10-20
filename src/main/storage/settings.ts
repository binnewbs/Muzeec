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
  lyricsRomanize: false,
  lastTrack: null,
  lastPosition: 0,
  searchHistory: [],
  pinnedPlaylists: [],
}

/** Coalesce bursts of updates (position, volume, search history) into one write. */
const WRITE_DELAY_MS = 1000

const file = () => path.join(app.getPath("userData"), "settings.json")

let cache: AppSettings | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false

function load(): AppSettings {
  if (cache) return cache
  let stored: Partial<AppSettings> = {}
  try {
    stored = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<AppSettings>
  } catch {
    stored = {}
  }
  const next: AppSettings = { ...DEFAULTS, ...stored }
  cache = next
  return next
}

function writeNow(): void {
  if (!dirty || !cache) return
  dirty = false
  const target = file()
  const temp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(cache))
    fs.renameSync(temp, target)
  } catch (error) {
    console.error("Failed to persist settings", error)
    dirty = true
  }
}

function scheduleWrite(): void {
  dirty = true
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    writeNow()
  }, WRITE_DELAY_MS)
}

/** Flush pending changes synchronously (app quit, sign-out). */
export function flushSettings(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  writeNow()
}

export function getSettings(): AppSettings {
  return load()
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  cache = { ...load(), ...patch }
  scheduleWrite()
  return cache
}
