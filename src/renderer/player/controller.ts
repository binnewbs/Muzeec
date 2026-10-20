import type { Track } from "@shared/types"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { usePlayer } from "@/lib/store/player"
import { useQueue } from "@/lib/store/queue"
import { useSettings } from "@/lib/store/settings"
import { useAuth } from "@/lib/store/auth"
import { engine, setMediaSession } from "./engine"

let started = false
let requestToken = 0
let lastProgressPing = 0
let historyVideoId: string | null = null

function finishHistory(position: number, duration: number): void {
  if (!historyVideoId) return
  void api.history({ videoId: historyVideoId, event: "end", position, duration })
  historyVideoId = null
}

export async function playTracks(tracks: Track[], index: number): Promise<void> {
  useQueue.getState().set(tracks, index)
  const track = tracks[index]
  if (track) await playTrack(track)
}

export async function playTrack(track: Track): Promise<void> {
  const token = ++requestToken
  if (historyVideoId && historyVideoId !== track.videoId) finishHistory(engine.currentTime, engine.duration)
  const player = usePlayer.getState()
  player.set({ current: track, status: "loading", error: null, liked: false, duration: track.duration ?? 0 })
  setMediaSession(track, false)
  try {
    const decision = await unwrap(api.player({ videoId: track.kind === "track" ? track.videoId : track.id }))
    if (token !== requestToken) return
    await engine.load(decision)
    if (token !== requestToken) return
    await engine.play()
    usePlayer.getState().set({ status: "playing", duration: engine.duration || track.duration || 0 })
    setMediaSession(track, true)
    lastProgressPing = Date.now()
    historyVideoId = track.videoId
    void api.history({ videoId: track.videoId, event: "start", position: 0, duration: engine.duration })
  } catch (error) {
    if (token !== requestToken) return
    const message = errorMessage(error)
    usePlayer.getState().set({ status: "error", error: message })
    setMediaSession(track, false)
    toast.error(message)
  }
}

export function togglePlay(): void {
  const { status, current } = usePlayer.getState()
  if (!current) return
  if (status === "playing") {
    engine.pause()
    usePlayer.getState().set({ status: "paused" })
    setMediaSession(current, false)
    return
  }
  if (status === "paused") {
    void engine.play().then(() => {
      usePlayer.getState().set({ status: "playing" })
      setMediaSession(current, true)
    })
    return
  }
  if (status === "error") void playTrack(current)
}

export function next(): void {
  const queue = useQueue.getState()
  const index = queue.nextIndex()
  if (index === null) {
    engine.pause()
    usePlayer.getState().set({ status: "paused" })
    return
  }
  queue.set(queue.tracks, index)
  void playTrack(queue.tracks[index])
}

export function previous(): void {
  const queue = useQueue.getState()
  if (engine.currentTime > 5) {
    engine.seek(0)
    return
  }
  const index = queue.prevIndex()
  if (index === null) {
    engine.seek(0)
    return
  }
  queue.set(queue.tracks, index)
  void playTrack(queue.tracks[index])
}

export function seek(seconds: number): void {
  engine.seek(seconds)
}

export function setVolume(volume: number, muted = usePlayer.getState().muted): void {
  usePlayer.getState().set({ volume, muted })
  engine.setVolume(volume, muted)
}

export async function likeTrack(track: Track): Promise<void> {
  if (!useAuth.getState().state.signedIn) {
    toast.error("Sign in to like songs")
    return
  }
  try {
    await unwrap(api.like({ videoId: track.videoId, rating: "like" }))
    toast.success("Added to liked songs")
  } catch (error) {
    toast.error(errorMessage(error))
  }
}

export async function toggleLike(): Promise<void> {
  const { current, liked } = usePlayer.getState()
  if (!current) return
  if (!useAuth.getState().state.signedIn) {
    toast.error("Sign in to like songs")
    return
  }
  try {
    await unwrap(api.like({ videoId: current.videoId, rating: liked ? "none" : "like" }))
    usePlayer.getState().set({ liked: !liked })
  } catch (error) {
    toast.error(errorMessage(error))
  }
}

export function playTrackNext(track: Track): void {
  useQueue.getState().addNext(track)
  toast.success(`Playing next: ${track.title}`)
}

export function initPlayer(): void {
  if (started) return
  started = true

  const { settings } = useSettings.getState()
  engine.setVolume(settings.volume)
  usePlayer.setState({ volume: settings.volume })

  engine.audio.addEventListener("ended", () => {
    finishHistory(engine.duration, engine.duration)
    next()
  })

  engine.audio.addEventListener("error", () => {
    if (usePlayer.getState().status !== "loading") {
      usePlayer.getState().set({ status: "error", error: "Playback stream was refused" })
    }
  })

  engine.subscribe(() => {
    const { current, status } = usePlayer.getState()
    if (!current || status !== "playing") return
    if (Date.now() - lastProgressPing > 15_000) {
      lastProgressPing = Date.now()
      void api.history({
        videoId: current.videoId,
        event: "progress",
        position: engine.currentTime,
        duration: engine.duration,
      })
    }
  })

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => togglePlay())
    navigator.mediaSession.setActionHandler("pause", () => togglePlay())
    navigator.mediaSession.setActionHandler("nexttrack", () => next())
    navigator.mediaSession.setActionHandler("previoustrack", () => previous())
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") seek(details.seekTime)
    })
  }

  let last = { playing: false, videoId: null as string | null, title: "", artist: "" }
  usePlayer.subscribe((state) => {
    const payload = {
      playing: state.status === "playing",
      videoId: state.current?.videoId ?? null,
      title: state.current?.title ?? "",
      artist: state.current?.subtitle ?? "",
    }
    if (JSON.stringify(payload) === JSON.stringify(last)) return
    last = payload
    void api.setPlayerState(payload)
  })

  api.onMediaKey((action) => {
    if (action === "playpause") togglePlay()
    if (action === "next") next()
    if (action === "previous") previous()
  })
}
