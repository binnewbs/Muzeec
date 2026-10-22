import { app, BrowserWindow } from "electron"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type {
  DownloadedTrack,
  DownloadProgress,
  LyricsResult,
  PlayerDecision,
  Track,
} from "../shared/types.ts"
import { authState } from "./youtube/auth.ts"
import { resolveDownload, resolveMusicTrack } from "./youtube/player.ts"
import { mediaHeadersFor, ytSession } from "./youtube/session.ts"
import { lookupLyrics } from "./lyrics/engine.ts"
import { getSettings } from "./storage/settings.ts"

const MANIFEST_VERSION = 1
const MANIFEST = "index.json"
const LYRICS_DIR = "lyrics"

type Manifest = { version: number; items: DownloadedTrack[] }

let cached: DownloadedTrack[] | null = null
let writeChain: Promise<void> = Promise.resolve()
let cleanedParts = false
const active = new Map<string, AbortController>()

export function downloadsDir(): string {
  return path.join(app.getPath("userData"), "downloads")
}

function manifestPath(): string {
  return path.join(downloadsDir(), MANIFEST)
}

function lyricsPath(videoId: string): string {
  return path.join(downloadsDir(), LYRICS_DIR, `${videoId}.json`)
}

function trackPath(file: string): string {
  const root = downloadsDir()
  const target = path.resolve(root, file)
  return target.startsWith(root + path.sep) ? target : ""
}

function isDownloadedEntry(value: unknown): value is DownloadedTrack {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.videoId === "string" &&
    typeof item.title === "string" &&
    typeof item.file === "string" &&
    typeof item.mimeType === "string" &&
    typeof item.duration === "number" &&
    typeof item.size === "number" &&
    typeof item.downloadedAt === "number"
  )
}

function readManifest(): DownloadedTrack[] {
  if (cached) return cached
  if (!cleanedParts) {
    cleanedParts = true
    void cleanupParts()
  }
  let items: DownloadedTrack[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as Partial<Manifest>
    if (Array.isArray(parsed.items)) items = parsed.items.filter(isDownloadedEntry)
  } catch {
    items = []
  }
  // A missing media file means the download was deleted outside the app, or a
  // previous run crashed between the file and manifest writes.
  const valid = items.filter((item) => Boolean(trackPath(item.file)))
  const present: DownloadedTrack[] = []
  for (const item of valid) {
    try {
      if (fs.statSync(trackPath(item.file)).isFile()) present.push(item)
    } catch {
      // Drop entries whose audio file is gone.
    }
  }
  cached = present
  if (present.length !== items.length) void persist()
  return cached
}

function snapshot(): Manifest {
  return { version: MANIFEST_VERSION, items: readManifest() }
}

function persist(): Promise<void> {
  const data = JSON.stringify(snapshot())
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const target = manifestPath()
      const temp = `${target}.tmp`
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(temp, data)
      await fsp.rename(temp, target)
    })
    .catch((error) => {
      console.error("Failed to persist downloads manifest", error)
    })
  return writeChain
}

export function listDownloads(): DownloadedTrack[] {
  return [...readManifest()]
}

export function findDownloaded(videoId: string): DownloadedTrack | null {
  return readManifest().find((item) => item.videoId === videoId || item.sourceVideoId === videoId) ?? null
}

/** The renderer's `yt:player` path checks this before touching the network. */
export function downloadedDecision(videoId: string): PlayerDecision | null {
  const item = findDownloaded(videoId)
  if (!item) return null
  const target = trackPath(item.file)
  if (!target) return null
  try {
    if (!fs.statSync(target).isFile()) return null
  } catch {
    return null
  }
  return {
    videoId,
    url: downloadUrl(item.file),
    mimeType: item.mimeType,
    bitrate: item.bitrate,
    codec: item.mimeType.split(";")[0] ?? "audio",
    client: "local",
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    duration: item.duration,
    loudnessLufs: null,
  }
}

export function downloadUrl(file: string): string {
  return `app://muzeec/__downloads/${encodeURIComponent(file)}`
}

export async function startDownload(track: Track): Promise<DownloadedTrack> {
  const sourceVideoId = track.videoId
  let videoId = sourceVideoId
  if (track.musicVideoType === "MUSIC_VIDEO_TYPE_OMV") {
    videoId = await resolveMusicTrack(sourceVideoId).catch(() => sourceVideoId)
  }

  const existing = findDownloaded(videoId) ?? findDownloaded(sourceVideoId)
  if (existing) throw new Error("Already downloaded")
  if (active.has(videoId) || active.has(sourceVideoId)) throw new Error("Download already in progress")

  const job = new AbortController()
  active.set(videoId, job)
  if (sourceVideoId !== videoId) active.set(sourceVideoId, job)

  const title = track.title
  const progress = (status: DownloadProgress["status"], received = 0, total = 0, error?: string) => {
    emit({
      videoId,
      sourceVideoId: sourceVideoId !== videoId ? sourceVideoId : null,
      title,
      status,
      received,
      total,
      ...(error ? { error } : {}),
    })
  }

  try {
    progress("resolving")
    const signedIn = (await authState()).signedIn
    let decision = await resolveDownload(videoId, signedIn)
    let extension = extensionForMime(decision.mimeType)
    let file = `${safeId(videoId)}.${extension}`
    let target = path.join(downloadsDir(), file)
    let part = `${target}.part`
    await fsp.mkdir(downloadsDir(), { recursive: true })

    let size = 0
    let mimeType = decision.mimeType
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        progress("downloading", 0, 0)
        const transferred = await transfer(decision, part, job.signal, (received, total) => {
          progress("downloading", received, total)
        })
        size = transferred.size
        mimeType = transferred.mimeType
        await fsp.rename(part, target)
        break
      } catch (error) {
        await fsp.unlink(part).catch(() => undefined)
        if (job.signal.aborted) throw new Error("Download cancelled")
        if (attempt > 0 || error instanceof PermanentDownloadError) throw error
        // googlevideo URLs can expire or be throttled mid-transfer. Resolve a
        // fresh decision once; the retry restarts from byte zero.
        decision = await resolveDownload(videoId, signedIn, true)
        extension = extensionForMime(decision.mimeType)
        file = `${safeId(videoId)}.${extension}`
        target = path.join(downloadsDir(), file)
        part = `${target}.part`
      }
    }

    progress("lyrics", size, size)
    const thumbnail = await saveThumbnail(videoId, track.thumbnail)
    const hasLyrics = await saveLyrics(videoId, track)
    const item: DownloadedTrack = {
      videoId,
      sourceVideoId: sourceVideoId !== videoId ? sourceVideoId : null,
      title: track.title,
      subtitle: track.subtitle,
      thumbnail,
      duration: Number(track.duration) || Number(decision.duration) || 0,
      artists: track.artists,
      album: track.album ?? null,
      year: track.year ?? null,
      // The saved file is always the canonical ATV id, even when the user
      // downloaded from an official music video, so it never needs re-matching.
      musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
      file,
      mimeType,
      bitrate: decision.bitrate,
      size,
      downloadedAt: Date.now(),
      hasLyrics,
    }
    readManifest().unshift(item)
    await persist()
    progress("completed", size, size)
    return item
  } catch (error) {
    progress("error", 0, 0, error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    active.delete(videoId)
    active.delete(sourceVideoId)
  }
}

function emit(progress: DownloadProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send("downloads:progress", progress)
  }
}

class PermanentDownloadError extends Error {}

async function transfer(
  decision: PlayerDecision,
  part: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<{ size: number; mimeType: string }> {
  const response = await ytSession().fetch(decision.url, {
    headers: mediaHeadersFor(decision.url),
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    // 403/410 is the normal expired-URL response; re-resolve once before failing.
    throw new Error(`Download failed (${response.status})`)
  }
  const mimeType = (response.headers.get("content-type") ?? decision.mimeType).split(";")[0].trim()
  if (!mimeType.startsWith("audio/")) {
    await response.body?.cancel().catch(() => undefined)
    throw new PermanentDownloadError(`Unexpected download type: ${mimeType || "none"}`)
  }
  if (!response.body) throw new Error("Download returned no data")
  const total = Number(response.headers.get("content-length") ?? 0) || 0
  const source = Readable.fromWeb(response.body as never)
  let received = 0
  let lastEmit = 0
  source.on("data", (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastEmit >= 200) {
      lastEmit = now
      onProgress(received, total)
    }
  })
  await pipeline(source, fs.createWriteStream(part), { signal })
  onProgress(received, total || received)
  return { size: received, mimeType }
}

async function saveThumbnail(videoId: string, url: string | null): Promise<string | null> {
  const fallback = `https://i.ytimg.com/vi/${encodeURIComponent(safeId(videoId))}/hqdefault.jpg`
  const candidates = [...new Set([url, fallback].filter((value): value is string => Boolean(value)))]
  for (const candidate of candidates) {
    try {
      const response = await ytSession().fetch(candidate, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok || !response.body) continue
      const type = (response.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim()
      if (!type.startsWith("image/")) {
        await response.body.cancel().catch(() => undefined)
        continue
      }
      const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"
      const file = `${safeId(videoId)}.${extension}`
      await fsp.mkdir(downloadsDir(), { recursive: true })
      await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(path.join(downloadsDir(), file)))
      return downloadUrl(file)
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

async function saveLyrics(videoId: string, track: Track): Promise<boolean> {
  try {
    const artist =
      track.artists
        ?.map((entry) => entry.name)
        .filter(Boolean)
        .join(", ") || track.subtitle
    const result = await lookupLyrics(
      {
        videoId,
        title: track.title,
        artist,
        album: track.album?.name ?? null,
        durationMs: Math.max(0, Number(track.duration ?? 0) * 1000),
        retry: true,
      },
      getSettings(),
    )
    if (!result) return false
    await writeJsonAtomic(lyricsPath(videoId), {
      version: 1,
      videoId,
      savedAt: Date.now(),
      result,
    })
    return true
  } catch {
    return false
  }
}

export function localLyrics(videoId: string): LyricsResult | null {
  const item = findDownloaded(videoId)
  if (!item) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(lyricsPath(item.videoId), "utf8")) as {
      videoId?: string
      result?: LyricsResult
    }
    if (parsed.videoId !== item.videoId || !parsed.result) return null
    return parsed.result
  } catch {
    return null
  }
}

/** Persist lyrics fetched online for a song that is already downloaded. */
export async function cacheLyricsForDownload(videoId: string, result: LyricsResult): Promise<void> {
  const item = findDownloaded(videoId)
  if (!item) return
  try {
    await writeJsonAtomic(lyricsPath(item.videoId), {
      version: 1,
      videoId: item.videoId,
      savedAt: Date.now(),
      result,
    })
    if (!item.hasLyrics) {
      item.hasLyrics = true
      await persist()
    }
  } catch {
    // Lyrics are best-effort; playback must never depend on this write.
  }
}

export async function removeDownload(videoId: string): Promise<boolean> {
  const item = findDownloaded(videoId)
  if (!item) return false
  active.get(item.videoId)?.abort()
  const files = new Set<string>([item.file])
  if (item.thumbnail) {
    try {
      const parsed = new URL(item.thumbnail)
      const name = decodeURIComponent(parsed.pathname.replace(/^\/__downloads\//, ""))
      if (name && !name.includes("/")) files.add(name)
    } catch {
      // A malformed thumbnail URL only leaves an orphan image behind.
    }
  }
  for (const file of files) {
    if (file.endsWith(".part")) continue
    await fsp.unlink(path.join(downloadsDir(), file)).catch(() => undefined)
  }
  await fsp.unlink(lyricsPath(item.videoId)).catch(() => undefined)
  const items = readManifest()
  const index = items.findIndex((entry) => entry.videoId === item.videoId)
  if (index >= 0) items.splice(index, 1)
  await persist()
  return true
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "")
}

function extensionForMime(mimeType: string): string {
  const type = mimeType.split(";")[0].trim().toLowerCase()
  if (type === "audio/webm") return "webm"
  if (type === "audio/mp4") return "m4a"
  if (type === "audio/ogg") return "ogg"
  if (type === "audio/mpeg") return "mp3"
  if (type === "audio/aac") return "aac"
  return "audio"
}

async function cleanupParts(): Promise<void> {
  try {
    const entries = await fsp.readdir(downloadsDir())
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".part"))
        .map(async (entry) => {
          const target = path.join(downloadsDir(), entry)
          const stat = await fsp.stat(target).catch(() => null)
          // A transfer that started moments ago belongs to this process.
          if (stat && Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
            await fsp.unlink(target).catch(() => undefined)
          }
        }),
    )
  } catch {
    // The directory is created on the first download.
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  await fsp.writeFile(temp, JSON.stringify(value))
  await fsp.rename(temp, target)
}
