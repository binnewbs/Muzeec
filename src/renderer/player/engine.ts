import type { PlayerDecision, Track } from "@shared/types"
import { fadeGain } from "./fade.ts"

type Listener = () => void
type Fade = { element: HTMLAudioElement; startPos: number; duration: number }

const FADE_TICK_MS = 50

/**
 * One primary audio element, no React updates per frame (PLAN §9).
 * A standby element is preloaded for gapless swaps and crossfades; the previous
 * element keeps playing until it has been faded out.
 */
class AudioEngine {
  audio = new Audio()
  private standby: HTMLAudioElement | null = null
  private standbyUrl: string | null = null
  /** The previous primary element, kept playing during a crossfade until fully faded out. */
  private fading: HTMLAudioElement | null = null
  private fade: Fade | null = null
  private fadeTicker: number | null = null
  private listeners = new Set<Listener>()
  private ticker: number | null = null
  private position = 0
  private userVolume = 1
  private muted = false
  /** Set once per track by the controller; fires when the primary track reaches its end. */
  onEnded: (() => void) | null = null
  /** Set once by the controller; fires when the primary stream refuses to play. */
  onError: (() => void) | null = null

  constructor() {
    this.wire(this.audio)
    this.audio.preload = "auto"
  }

  private wire(element: HTMLAudioElement): void {
    element.addEventListener("timeupdate", () => this.onTimeUpdate(element))
    element.addEventListener("durationchange", () => this.onDurationChange(element))
    element.addEventListener("play", () => this.onElementPlay(element))
    element.addEventListener("pause", () => this.onElementPause(element))
    element.addEventListener("ended", () => this.onElementEnded(element))
    element.addEventListener("error", () => {
      if (element !== this.audio) return
      this.onError?.()
    })
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

  /**
   * Loads a stream onto the standby element without playing it.
   * Resolves once it is buffered and ready to start on command.
   */
  prepare(decision: PlayerDecision): Promise<void> {
    if (!this.standby) {
      this.standby = new Audio()
      this.wire(this.standby)
      this.standby.preload = "auto"
    }
    if (this.standbyUrl === decision.url && this.standby.readyState >= 3) return Promise.resolve()
    this.standbyUrl = decision.url
    this.standby.src = decision.url
    this.standby.load()
    return new Promise((resolve, reject) => {
      const element = this.standby
      if (!element) {
        reject(new Error("Standby element was released"))
        return
      }
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error("This stream could not be preloaded."))
      }
      const cleanup = () => {
        element.removeEventListener("canplay", onReady)
        element.removeEventListener("error", onError)
      }
      element.addEventListener("canplay", onReady, { once: true })
      element.addEventListener("error", onError, { once: true })
    })
  }

  get prepared(): boolean {
    return this.standby !== null && this.standby.readyState >= 3 && this.standbyUrl !== null
  }

  /**
   * Promotes the standby element to primary. In "crossfade" mode the old element
   * keeps playing until faded out; in "gapless" mode it is released right away.
   * Returns false when nothing was preloaded.
   */
  adoptPrepared(mode: "crossfade" | "gapless"): boolean {
    const standby = this.standby
    if (!standby || standby.readyState < 2 || !this.standbyUrl) return false
    this.standby = null
    this.standbyUrl = null
    const previous = this.audio
    this.audio = standby
    if (mode === "crossfade") this.fading = previous
    else this.release(previous)
    this.position = 0
    this.refreshGain()
    this.emit()
    return true
  }

  /** Fades the retained previous element out over the new track's playback. */
  beginFade(seconds: number): void {
    if (!this.fading) return
    this.fade = { element: this.fading, startPos: this.position, duration: Math.max(0.5, seconds) }
    this.refreshGain()
    this.startFadeTicker()
  }

  /** Stops any fade in flight and releases the retained previous element immediately. */
  cancelFade(): void {
    this.stopFadeTicker()
    this.fade = null
    if (this.fading) {
      this.release(this.fading)
      this.fading = null
    }
    this.refreshGain()
  }

  /** Throws away the preloaded standby (prefetch invalidated, manual skip). */
  clearPrepared(): void {
    if (this.standby !== null) this.release(this.standby)
    this.standby = null
    this.standbyUrl = null
  }

  async play(): Promise<void> {
    await this.audio.play()
  }

  pause(): void {
    this.audio.pause()
    if (this.fade) this.fade.element.pause()
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return
    this.audio.currentTime = seconds
    this.position = seconds
    this.emit()
  }

  /** Sets the reported position without touching the media element (used by lazy restore). */
  setPosition(seconds: number): void {
    if (!Number.isFinite(seconds)) return
    this.position = seconds
    this.emit()
  }

  setVolume(volume: number, muted = false): void {
    this.userVolume = Math.min(1, Math.max(0, volume))
    this.muted = muted
    this.refreshGain()
  }

  stop(): void {
    this.clearPrepared()
    this.cancelFade()
    this.audio.pause()
    this.audio.removeAttribute("src")
    this.audio.load()
    this.position = 0
    this.stopTicker()
    this.emit()
  }

  private release(element: HTMLAudioElement): void {
    element.pause()
    element.removeAttribute("src")
    element.load()
  }

  private onTimeUpdate(element: HTMLAudioElement): void {
    if (element !== this.audio) return
    this.position = element.currentTime
    this.refreshGain()
  }

  private onDurationChange(element: HTMLAudioElement): void {
    if (element !== this.audio) return
    this.position = element.currentTime
    this.emit()
  }

  private onElementPlay(element: HTMLAudioElement): void {
    if (element !== this.audio) return
    this.startTicker()
    if (this.fade && this.fade.element.paused) this.fade.element.play().catch(() => undefined)
  }

  private onElementPause(element: HTMLAudioElement): void {
    if (element !== this.audio) return
    this.stopTicker()
    if (this.fade) this.fade.element.pause()
  }

  private onElementEnded(element: HTMLAudioElement): void {
    if (element === this.audio) {
      this.stopTicker()
      this.onEnded?.()
      return
    }
    if (this.fade && this.fade.element === element) this.cancelFade()
  }

  private refreshGain(): void {
    const gain = this.fade ? fadeGain(this.position, this.fade.startPos, this.fade.duration) : 1
    this.audio.volume = Math.min(1, this.userVolume * gain)
    this.audio.muted = this.muted
    if (this.fade) {
      this.fade.element.volume = Math.min(1, this.userVolume * (1 - gain))
      this.fade.element.muted = this.muted
    }
    if (this.fade && this.position - this.fade.startPos >= this.fade.duration) {
      this.stopFadeTicker()
      const element = this.fade.element
      this.fade = null
      if (this.fading === element) this.fading = null
      this.release(element)
      this.refreshGain()
    }
  }

  private startFadeTicker(): void {
    if (this.fadeTicker !== null) return
    // 50 ms keeps the volume ramp audibly smooth.
    this.fadeTicker = window.setInterval(() => {
      this.refreshGain()
    }, FADE_TICK_MS)
  }

  private stopFadeTicker(): void {
    if (this.fadeTicker === null) return
    window.clearInterval(this.fadeTicker)
    this.fadeTicker = null
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
    artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: "320x320", type: "image/jpeg" }] : [],
  })
  navigator.mediaSession.playbackState = playing ? "playing" : "paused"
}
