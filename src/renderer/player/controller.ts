import type { Track } from "@shared/types"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { usePlayer } from "@/lib/store/player"
import { useQueue } from "@/lib/store/queue"
import { shuffled } from "@/lib/shuffle"
import { useSettings } from "@/lib/store/settings"
import { useAuth } from "@/lib/store/auth"
import { engine, setMediaSession } from "./engine"
import { nextInCycle } from "./sequence.ts"

let started = false
let requestToken = 0
let radioToken = 0
let previewToken = 0
let cycle: Track[] = []
let unshuffledCycle: Track[] | null = null
let history: Track[] = []
let lastProgressPing = 0
let historyVideoId: string | null = null

function finishHistory(position: number, duration: number): void {
  if (!historyVideoId) return
  void api.history({ videoId: historyVideoId, event: "end", position, duration })
  historyVideoId = null
}

function resetAutoplay(): void {
  useQueue.getState().clearAutoplay()
  radioToken++
  previewToken++
}

function shuffleTail(tracks: Track[], seedId: string): Track[] {
  if (!useQueue.getState().shuffle) return tracks
  const index = tracks.findIndex((track) => track.videoId === seedId)
  if (index < 0) return shuffled(tracks)
  return [...tracks.slice(0, index + 1), ...shuffled(tracks.slice(index + 1))]
}

function addToCycle(track: Track, afterCurrent = false): void {
  const current = usePlayer.getState().current
  const index = current ? cycle.findIndex((entry) => entry.videoId === current.videoId) : -1
  if (index < 0) cycle.push(track)
  else cycle.splice(afterCurrent ? index + 1 : cycle.length, 0, track)
}

function remember(track: Track): void {
  const current = usePlayer.getState().current
  if (!current || current.videoId === track.videoId) return
  history.push(current)
  if (history.length > 50) history.shift()
}

export async function playTracks(tracks: Track[], index: number): Promise<void> {
  const track = tracks[index]
  if (!track) return
  const musicTrack = await ensureMusicTrack(track)
  const queue = useQueue.getState()
  const rest = tracks.slice(index + 1)
  queue.setUnshuffledTracks(rest)
  unshuffledCycle = [...tracks]
  const ordered = queue.shuffle ? shuffled(rest) : rest
  queue.replace(ordered)
  cycle = [musicTrack, ...ordered]
  resetAutoplay()
  await startTrack(musicTrack)
}

async function ensureMusicTrack(track: Track): Promise<Track> {
  if (track.musicVideoType !== "MUSIC_VIDEO_TYPE_OMV") return track
  const result = await api.musicTrack({ videoId: track.videoId })
  if (!result.ok || result.data === track.videoId) return track
  return { ...track, id: result.data, videoId: result.data, musicVideoType: "MUSIC_VIDEO_TYPE_ATV" }
}

export async function playTrack(track: Track): Promise<void> {
  const musicTrack = await ensureMusicTrack(track)
  const queue = useQueue.getState()
  const current = usePlayer.getState().current
  if (current?.videoId !== musicTrack.videoId) {
    queue.clear()
    unshuffledCycle = null
  }
  const nextQueue = useQueue.getState()
  if (!nextQueue.unshuffledTracks) nextQueue.setUnshuffledTracks([...nextQueue.tracks])
  if (!unshuffledCycle) unshuffledCycle = [musicTrack, ...nextQueue.tracks]
  resetAutoplay()
  cycle = [musicTrack, ...nextQueue.tracks]
  await startTrack(musicTrack)
}

async function startTrack(track: Track, rememberCurrent = true): Promise<void> {
  const token = ++requestToken
  if (rememberCurrent) remember(track)
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
    void api.setSettings({ lastTrack: track, lastPosition: 0 })
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
    void api.setSettings({ lastPosition: engine.currentTime })
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
  const queued = queue.takeNext()
  if (queued) {
    resetAutoplay()
    void startTrack(queued)
    return
  }

  const current = usePlayer.getState().current
  if (!current) {
    engine.pause()
    usePlayer.getState().set({ status: "paused" })
    return
  }

  if (queue.repeat === "all" && cycle.length) {
    const pass = nextInCycle(cycle, current.videoId, queue.shuffle)
    if (pass) {
      queue.replace(pass.upcoming)
      resetAutoplay()
      void startTrack(pass.track)
      return
    }
  }

  void playSimilar(current)
}

async function playSimilar(current: Track): Promise<void> {
  const token = ++radioToken
  try {
    const queue = useQueue.getState()
    let index = queue.autoplay.findIndex((track) => track.videoId === current.videoId)
    if (index < 0 || index + 1 >= queue.autoplay.length) {
      const fresh = await unwrap(api.radio({ videoId: current.videoId }))
      if (token !== radioToken) return
      const ordered = shuffleTail(fresh, current.videoId)
      const freshIndex = ordered.findIndex((track) => track.videoId === current.videoId)
      if (freshIndex < 0) {
        const pick = ordered.find((track) => track.videoId !== current.videoId)
        if (!pick) throw new Error("No similar songs found")
        useQueue.getState().setAutoplay(current.videoId, ordered)
        await startTrack(pick)
        return
      }
      useQueue.getState().setAutoplay(current.videoId, ordered)
      index = freshIndex
    }
    const track = useQueue.getState().autoplay[index + 1]
    if (!track) throw new Error("No similar songs found")
    await startTrack(track)
  } catch (error) {
    if (token !== radioToken) return
    toast.error(errorMessage(error))
  }
}

export async function previewAutoplay(): Promise<void> {
  const queue = useQueue.getState()
  const current = usePlayer.getState().current
  const seed = queue.tracks.at(-1) ?? current
  if (!seed) return
  if (queue.autoplay.some((track) => track.videoId === seed.videoId) && !queue.autoplayLoading) return
  if (queue.autoplaySeed === seed.videoId && (queue.autoplay.length || queue.autoplayLoading)) return

  const token = ++previewToken
  queue.setAutoplayLoading(seed.videoId, true)
  try {
    const fresh = await unwrap(api.radio({ videoId: seed.videoId }))
    if (token !== previewToken) return
    const latest = useQueue.getState()
    const latestSeed = latest.tracks.at(-1) ?? usePlayer.getState().current
    if (latestSeed?.videoId !== seed.videoId) return
    latest.setAutoplay(seed.videoId, shuffleTail(fresh, seed.videoId))
  } catch {
    if (token !== previewToken) return
    useQueue.getState().setAutoplayLoading(seed.videoId, false)
  }
}

export function previous(): void {
  if (engine.currentTime > 5) {
    engine.seek(0)
    return
  }
  const previousTrack = history.pop()
  if (!previousTrack) {
    engine.seek(0)
    return
  }
  void startTrack(previousTrack, false)
}

export function seek(seconds: number): void {
  engine.seek(seconds)
  void api.setSettings({ lastPosition: seconds })
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
  addToCycle(track, true)
  toast.success(`Playing next: ${track.title}`)
}

export function addToQueue(track: Track): void {
  useQueue.getState().append(track)
  addToCycle(track)
  toast.success(`Added to queue: ${track.title}`)
}

export function playFromQueue(index: number): void {
  const queue = useQueue.getState()
  const track = queue.tracks[index]
  if (!track) return
  queue.remove(index)
  const remaining = useQueue.getState().tracks
  if (!queue.unshuffledTracks) queue.setUnshuffledTracks([...remaining])
  if (!unshuffledCycle) unshuffledCycle = [track, ...remaining]
  cycle = [track, ...remaining]
  resetAutoplay()
  void startTrack(track)
}

/** Jump into the existing radio sequence without throwing away its place. */
export async function playAutoplayTrack(track: Track): Promise<void> {
  const queue = useQueue.getState()
  if (!queue.autoplay.some((entry) => entry.videoId === track.videoId)) {
    await playTrack(track)
    return
  }
  const musicTrack = await ensureMusicTrack(track)
  cycle = [musicTrack, ...queue.tracks]
  await startTrack(musicTrack)
}

export function cycleRepeat(): void {
  const { repeat, setRepeat } = useQueue.getState()
  setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off")
}

export function toggleShuffle(): void {
  const queue = useQueue.getState()
  const enabled = !queue.shuffle
  const current = usePlayer.getState().current

  if (enabled) {
    if (!queue.unshuffledTracks) queue.snapshotUnshuffled()
    if (!unshuffledCycle) unshuffledCycle = [...cycle]

    queue.setShuffle(true)
    queue.shuffleTracks()
    cycle = current ? [current, ...useQueue.getState().tracks] : useQueue.getState().tracks

    const { autoplay, autoplaySeed } = useQueue.getState()
    if (autoplaySeed && autoplay.length) {
      useQueue.getState().setAutoplay(autoplaySeed, shuffleTail(autoplay, autoplaySeed))
    }
    return
  }

  queue.restoreUnshuffledTracks()
  const restoredQueue = useQueue.getState().tracks
  cycle = current ? [current, ...restoredQueue] : restoredQueue
  unshuffledCycle = null
  queue.setShuffle(false)
}

export function initPlayer(): void {
  if (started) return
  started = true

  const { settings } = useSettings.getState()
  engine.setVolume(settings.volume)
  usePlayer.setState({ volume: settings.volume })

  let lastPlaybackPersist = 0
  engine.subscribe(() => {
    const { current } = usePlayer.getState()
    if (!current) return
    if (Date.now() - lastPlaybackPersist < 5000) return
    lastPlaybackPersist = Date.now()
    void api.setSettings({ lastTrack: current, lastPosition: engine.currentTime })
  })
  // Avoid pagehide: app teardown can report a zeroed media position.

  engine.audio.addEventListener("ended", () => {
    if (useQueue.getState().repeat === "one") {
      engine.seek(0)
      void engine.play()
      return
    }
    void api.setSettings({ lastPosition: 0 })
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
      void api.setSettings({ lastPosition: engine.currentTime })
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

  void restoreLastPlayback()
}

async function restoreLastPlayback(): Promise<void> {
  const { settings } = useSettings.getState()
  const track = settings.lastTrack
  if (!track) return

  const position = Number.isFinite(settings.lastPosition) ? settings.lastPosition : 0
  const token = ++requestToken
  try {
    const musicTrack = await ensureMusicTrack(track)
    if (token !== requestToken) return

    const player = usePlayer.getState()
    player.set({ current: musicTrack, status: "loading", error: null, liked: false, duration: musicTrack.duration ?? 0 })
    setMediaSession(musicTrack, false)

    const decision = await unwrap(api.player({ videoId: musicTrack.videoId }))
    if (token !== requestToken) return
    await engine.load(decision)
    if (token !== requestToken) return

    const seekTo = Math.min(position, decision.duration || musicTrack.duration || 0)
    const waitSeekable = async () => {
      if (engine.audio.readyState >= 2 && engine.audio.seekable.length > 0) return
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        engine.audio.addEventListener("loadeddata", done, { once: true })
        engine.audio.addEventListener("canplay", done, { once: true })
        setTimeout(done, 1000)
      })
    }
    await waitSeekable()
    engine.seek(seekTo)
    usePlayer.getState().set({
      status: "paused",
      duration: engine.duration || decision.duration || musicTrack.duration || 0,
    })
    void api.setSettings({ lastTrack: musicTrack, lastPosition: seekTo })
    setMediaSession(musicTrack, false)
  } catch {
    await api.setSettings({ lastTrack: null, lastPosition: 0 }).catch(() => undefined)
  }
}
