import type { PlayerDecision, Track } from "@shared/types"

type Listener = () => void

/** One audio element, no React updates per frame (PLAN §9). */
class AudioEngine {
  readonly audio = new Audio()
  private listeners = new Set<Listener>()
  private ticker: number | null = null
  private position = 0

  constructor() {
    this.audio.preload = "auto"
    this.audio.addEventListener("timeupdate", () => {
      this.position = this.audio.currentTime
    })
    this.audio.addEventListener("durationchange", () => {
      this.position = this.audio.currentTime
      this.emit()
    })
    this.audio.addEventListener("play", () => this.startTicker())
    this.audio.addEventListener("pause", () => this.stopTicker())
    this.audio.addEventListener("ended", () => this.stopTicker())
  }

  get currentTime(): number {
    return this.audio.currentTime
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0
  }

  get paused(): boolean {
    return this.audio.paused
  }

  getPosition = (): number => this.position

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(decision: PlayerDecision): Promise<void> {
    this.audio.src = decision.url
    this.audio.load()
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error("This stream could not be played. Try the next track or resolve again."))
      }
      const cleanup = () => {
        this.audio.removeEventListener("canplay", onReady)
        this.audio.removeEventListener("error", onError)
      }
      this.audio.addEventListener("canplay", onReady, { once: true })
      this.audio.addEventListener("error", onError, { once: true })
    })
  }

  async play(): Promise<void> {
    await this.audio.play()
  }

  pause(): void {
    this.audio.pause()
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return
    this.audio.currentTime = seconds
    this.position = seconds
    this.emit()
  }

  setVolume(volume: number, muted = false): void {
    this.audio.volume = Math.min(1, Math.max(0, volume))
    this.audio.muted = muted
  }

  stop(): void {
    this.audio.pause()
    this.audio.removeAttribute("src")
    this.audio.load()
    this.position = 0
    this.stopTicker()
    this.emit()
  }

  private startTicker(): void {
    if (this.ticker !== null) return
    // 4 Hz keeps the seek bar smooth without per-frame React renders.
    this.ticker = window.setInterval(() => {
      this.position = this.audio.currentTime
      this.emit()
    }, 250)
  }

  private stopTicker(): void {
    if (this.ticker === null) return
    window.clearInterval(this.ticker)
    this.ticker = null
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const engine = new AudioEngine()

export function setMediaSession(track: Track | null, playing: boolean): void {
  if (!("mediaSession" in navigator)) return
  if (!track) {
    navigator.mediaSession.metadata = null
    return
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.subtitle,
    album: track.album?.name ?? "Muzeec",
    artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: "512x512", type: "image/jpeg" }] : [],
  })
  navigator.mediaSession.playbackState = playing ? "playing" : "paused"
}
