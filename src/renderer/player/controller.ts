import type { PlayerState, Track } from "@shared/types"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { usePlayer } from "@/lib/store/player"
import { useQueue } from "@/lib/store/queue"
import { shuffled } from "@/lib/shuffle"
import { useSettings } from "@/lib/store/settings"
import { useAuth } from "@/lib/store/auth"
import { engine, setMediaSession } from "./engine"
import { HISTORY_LIMIT, initialHistory, nextInCycle } from "./sequence.ts"

let started = false
let requestToken = 0
let radioToken = 0
let previewToken = 0
let cycle: Track[] = []
let unshuffledCycle: Track[] | null = null
let history: Track[] = []
let lastProgressPing = 0
let historyVideoId: string | null = null
/** Track restored from the last session; its stream resolves only when the user hits play. */
let pendingRestore: { track: Track; position: number } | null = null
/** Next track whose stream is already buffered on the engine's standby element. */
let prepared: { track: Track; rawVideoId: string } | null = null
let prefetching = false
let prefetchToken = 0
/** True while a crossfade/gapless hand-off is creating the next track. */
let transitioning = false
/** Invalidates in-flight like-status reads after a track change or a manual like/unlike. */
let likeGeneration = 0
/** How long before the end we start resolving the next track for gapless/crossfade. */
const PREFETCH_WINDOW = 15

function finishHistory(position: number, duration: number): void {
  if (!historyVideoId) return
  void api.history({ videoId: historyVideoId, event: "end", position, duration })
  historyVideoId = null
}

let lastReportedState = ""

function playerStatePayload(): PlayerState {
  const { current, status, duration } = usePlayer.getState()
  return {
    playing: status === "playing",
    videoId: current?.videoId ?? null,
    title: current?.title ?? "",
    artist: current?.subtitle ?? "",
    album: current?.album?.name ?? null,
    thumbnail: current?.thumbnail ?? null,
    duration: duration || engine.duration || current?.duration || 0,
    position: pendingRestore ? pendingRestore.position : engine.currentTime,
  }
}

/** Sends the tray/presence snapshot. Loading a stream should not clear the card. */
function reportPlayerState(): void {
  const { status } = usePlayer.getState()
  if (status === "loading") return
  const payload = playerStatePayload()
  const serialized = JSON.stringify(payload)
  if (serialized === lastReportedState) return
  lastReportedState = serialized
  void api.setPlayerState(payload)
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
  if (history.length > HISTORY_LIMIT) history.shift()
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
  if (queue.shuffle) {
    // Leave the previous-track stack alone; startTrack records the outgoing
    // song, so Previous returns to whatever was playing before the collection.
    await startTrack(musicTrack)
    return
  }
  // Starting a collection replaces previous history with the songs before the
  // clicked one, so stepping back walks the collection rather than the last one.
  history = initialHistory(tracks, index)
  await startTrack(musicTrack, false)
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
    history = []
    unshuffledCycle = null
  }
  const nextQueue = useQueue.getState()
  if (!nextQueue.unshuffledTracks) nextQueue.setUnshuffledTracks([...nextQueue.tracks])
  if (!unshuffledCycle) unshuffledCycle = [musicTrack, ...nextQueue.tracks]
  resetAutoplay()
  cycle = [musicTrack, ...nextQueue.tracks]
  // A standalone song starts a fresh session; don't let startTrack push the
  // outgoing track back onto the history we just cleared.
  await startTrack(musicTrack, false)
}

function clampFadeSeconds(): number {
  return Math.min(10, Math.max(1, useSettings.getState().settings.crossfadeSeconds))
}

/** Drops any pending prefetch/transition state (manual skips, fresh starts). */
function cancelTransition(): void {
  prefetchToken++
  prefetching = false
  prepared = null
  transitioning = false
  engine.clearPrepared()
  engine.cancelFade()
}

async function syncLiked(track: Track): Promise<void> {
  const generation = likeGeneration
  if (!useAuth.getState().state.signedIn) return
  try {
    const rating = await unwrap(api.likeStatus({ videoId: track.videoId }))
    if (generation !== likeGeneration) return
    const player = usePlayer.getState()
    if (player.current?.videoId !== track.videoId) return
    player.set({ liked: rating === "like" })
  } catch {
    // A failed status read must not interrupt playback; keep the last known state.
  }
}

async function startTrack(
  track: Track,
  rememberCurrent = true,
  startAt = 0,
  preparedMode?: "crossfade" | "gapless",
): Promise<void> {
  pendingRestore = null
  const token = ++requestToken
  if (rememberCurrent) remember(track)
  if (historyVideoId && historyVideoId !== track.videoId) finishHistory(engine.currentTime, engine.duration)
  const player = usePlayer.getState()
  likeGeneration++
  // Replaying the current song keeps its known state until the account check returns.
  const liked = player.current?.videoId === track.videoId ? player.liked : false
  player.set({ current: track, status: "loading", error: null, liked, duration: track.duration ?? 0 })
  void syncLiked(track)
  setMediaSession(track, false)
  let fadeSeconds = 0
  if (preparedMode) {
    // Promote the preloaded stream before anything else, so the swap is instant.
    fadeSeconds = clampFadeSeconds()
    if (!engine.adoptPrepared(preparedMode)) preparedMode = undefined
  } else {
    cancelTransition()
  }
  try {
    if (!preparedMode) {
      const decision = await unwrap(api.player({ videoId: track.kind === "track" ? track.videoId : track.id }))
      if (token !== requestToken) return
      await engine.load(decision)
      if (token !== requestToken) return
    } else if (preparedMode === "crossfade") {
      // The incoming track ramps in while the old one fades out; fade timing
      // follows the new track's position so pause/seek stay correct.
      engine.beginFade(fadeSeconds)
    }
    const maxDuration = engine.duration || track.duration || 0
    if (startAt > 0 && maxDuration > 0) engine.seek(Math.min(startAt, maxDuration))
    await engine.play()
    usePlayer.getState().set({ status: "playing", duration: engine.duration || track.duration || 0 })
    setMediaSession(track, true)
    lastProgressPing = Date.now()
    historyVideoId = track.videoId
    void api.history({ videoId: track.videoId, event: "start", position: startAt, duration: engine.duration })
    void api.setSettings({ lastTrack: track, lastPosition: startAt })
  } catch (error) {
    if (preparedMode) engine.cancelFade()
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
    const pending = pendingRestore
    if (pending) {
      pendingRestore = null
      // Resolve the stream on the first play after a cold start, at the saved position.
      void (async () => {
        const musicTrack = await ensureMusicTrack(pending.track)
        await startTrack(musicTrack, false, pending.position)
      })()
      return
    }
    void engine.play().then(() => {
      usePlayer.getState().set({ status: "playing" })
      setMediaSession(current, true)
    })
    return
  }
  if (status === "error") void playTrack(current)
}

/** Decides the next track without touching the network; `consume` applies the queue side effects. */
function pickNext(): { track: Track; consume: () => void } | null {
  const queue = useQueue.getState()
  const head = queue.tracks[0]
  if (head) {
    return {
      track: head,
      consume: () => {
        resetAutoplay()
        useQueue.getState().takeNext()
      },
    }
  }
  const current = usePlayer.getState().current
  if (queue.repeat === "all" && cycle.length && current) {
    const pass = nextInCycle(cycle, current.videoId, queue.shuffle)
    if (pass) {
      return {
        track: pass.track,
        consume: () => {
          useQueue.getState().replace(pass.upcoming)
          resetAutoplay()
        },
      }
    }
  }
  return null
}

export function next(): void {
  const picked = pickNext()
  if (picked) {
    picked.consume()
    void startTrack(picked.track)
    return
  }

  const current = usePlayer.getState().current
  if (!current) {
    engine.pause()
    usePlayer.getState().set({ status: "paused" })
    return
  }

  void playSimilar(current)
}

/** Buffers the next track's stream on the standby element ahead of the transition. */
async function prefetchNext(): Promise<void> {
  const { gaplessEnabled, crossfadeEnabled } = useSettings.getState().settings
  if (!gaplessEnabled && !crossfadeEnabled) return
  if (useQueue.getState().repeat === "one") return
  const picked = pickNext()
  if (!picked || (prepared && prepared.rawVideoId === picked.track.videoId)) return
  if (prefetching) return
  prefetching = true
  const token = ++prefetchToken
  let resolved: Track | null = null
  try {
    resolved = await ensureMusicTrack(picked.track)
    const decision = await unwrap(api.player({ videoId: resolved.kind === "track" ? resolved.videoId : resolved.id }))
    if (token !== prefetchToken) return
    await engine.prepare(decision)
  } catch {
    engine.clearPrepared()
    return // Prefetch is best-effort; the fallback path still advances on "ended".
  } finally {
    prefetching = false
  }
  if (token !== prefetchToken || !resolved) return
  prepared = { track: resolved, rawVideoId: picked.track.videoId }
}

/**
 * Starts the buffered next track: gapless swaps at "ended", crossfade fires
 * while the current track still has fade time left. Falls back to the legacy
 * path when the pick changed or the standby was never populated.
 */
async function beginTransition(mode: "crossfade" | "gapless"): Promise<void> {
  if (transitioning || !prepared) return
  const pending = prepared
  const picked = pickNext()
  if (!picked || picked.track.videoId !== pending.rawVideoId) {
    prepared = null
    engine.clearPrepared()
    if (mode === "gapless") {
      // The current track already ended; advance through the legacy path.
      void api.setSettings({ lastPosition: 0 })
      finishHistory(engine.duration, engine.duration)
      next()
    }
    return
  }
  transitioning = true
  prepared = null
  if (mode === "crossfade") finishHistory(engine.currentTime, engine.duration)
  picked.consume()
  await startTrack(pending.track, true, 0, mode)
  transitioning = false
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
  const position = pendingRestore ? pendingRestore.position : engine.currentTime
  if (position > 5) {
    seek(0)
    return
  }
  const previousTrack = history.pop()
  if (!previousTrack) {
    seek(0)
    return
  }
  // Put the track we are leaving back at the head of the queue, otherwise the
  // next press resumes from the old queue head and skips what we just played.
  const current = usePlayer.getState().current
  if (current) useQueue.getState().prepend(current)
  void startTrack(previousTrack, false)
}

export function seek(seconds: number): void {
  if (pendingRestore) {
    pendingRestore.position = seconds
    engine.setPosition(seconds)
    void api.setSettings({ lastPosition: seconds })
    reportPlayerState()
    return
  }
  engine.seek(seconds)
  void api.setSettings({ lastPosition: seconds })
  reportPlayerState()
}

/** Moves the playhead by `delta` seconds, clamped to the current track. */
export function seekBy(delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return
  const position = pendingRestore ? pendingRestore.position : engine.currentTime
  const duration = usePlayer.getState().duration || engine.duration
  const target = Math.max(0, position + delta)
  seek(duration > 0 ? Math.min(target, duration) : target)
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
    const player = usePlayer.getState()
    if (player.current?.videoId === track.videoId) {
      likeGeneration++
      player.set({ liked: true })
    }
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
    likeGeneration++
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

  let normalizationEnabled = settings.volumeNormalization
  engine.setNormalizationEnabled(normalizationEnabled)
  useSettings.subscribe((state) => {
    if (state.settings.volumeNormalization === normalizationEnabled) return
    normalizationEnabled = state.settings.volumeNormalization
    engine.setNormalizationEnabled(normalizationEnabled)
  })

  // Restored playback is shown before `auth.init()` finishes; sync the heart as
  // soon as the signed-in account is known (and clear it again on logout).
  let wasSignedIn = useAuth.getState().state.signedIn
  useAuth.subscribe((state) => {
    if (state.state.signedIn === wasSignedIn) return
    wasSignedIn = state.state.signedIn
    likeGeneration++
    const current = usePlayer.getState().current
    if (wasSignedIn && current) void syncLiked(current)
    else usePlayer.getState().set({ liked: false })
  })

  let lastPlaybackPersist = 0
  engine.subscribe(() => {
    const { current } = usePlayer.getState()
    if (!current) return
    // Coalesce resume-position writes to one every 15 s instead of every 5 s.
    if (Date.now() - lastPlaybackPersist < 15_000) return
    lastPlaybackPersist = Date.now()
    void api.setSettings({ lastTrack: current, lastPosition: engine.currentTime })
  })
  // Avoid pagehide: app teardown can report a zeroed media position.

  engine.onEnded = () => {
    if (useQueue.getState().repeat === "one") {
      engine.seek(0)
      void engine.play()
      return
    }
    const { gaplessEnabled, crossfadeEnabled } = useSettings.getState().settings
    if (prepared && (gaplessEnabled || crossfadeEnabled)) {
      void beginTransition("gapless")
      return
    }
    void api.setSettings({ lastPosition: 0 })
    finishHistory(engine.duration, engine.duration)
    next()
  }

  engine.onError = () => {
    if (usePlayer.getState().status !== "loading") {
      usePlayer.getState().set({ status: "error", error: "Playback stream was refused" })
    }
  }

  // Drives gapless/crossfade: resolves the upcoming track near the end of the
  // current one, then hands over at the crossfade point or on "ended".
  engine.subscribe(() => {
    if (transitioning) return
    const { gaplessEnabled, crossfadeEnabled } = useSettings.getState().settings
    if (!gaplessEnabled && !crossfadeEnabled) {
      if (prepared) cancelTransition()
      return
    }
    if (useQueue.getState().repeat === "one") {
      if (prepared) cancelTransition()
      return
    }
    const { current, status } = usePlayer.getState()
    if (!current || status !== "playing") return
    const duration = engine.duration
    if (!duration) return
    const remaining = duration - engine.currentTime
    if (!prepared) {
      if (remaining <= 0 || remaining > PREFETCH_WINDOW) return
      void prefetchNext()
      return
    }
    if (crossfadeEnabled && remaining <= clampFadeSeconds()) void beginTransition("crossfade")
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

  usePlayer.subscribe(() => reportPlayerState())

  api.onMediaKey((action) => {
    if (action === "playpause") togglePlay()
    if (action === "next") next()
    if (action === "previous") previous()
  })

  restoreLastPlayback()
  reportPlayerState()
}

/**
 * Restores the last session's track metadata without touching the network.
 * The stream is resolved on the first play press, which keeps cold start offline-fast.
 */
function restoreLastPlayback(): void {
  const { settings } = useSettings.getState()
  const track = settings.lastTrack
  if (!track) return

  const position = Number.isFinite(settings.lastPosition) ? Math.max(0, settings.lastPosition) : 0
  pendingRestore = { track, position }
  likeGeneration++
  usePlayer.getState().set({
    current: track,
    status: "paused",
    error: null,
    liked: false,
    duration: track.duration ?? 0,
  })
  void syncLiked(track)
  engine.setPosition(position)
  setMediaSession(track, false)
}
