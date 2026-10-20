import { create } from "zustand"
import type { Track } from "@shared/types"
import { shuffled } from "../shuffle.ts"

export type RepeatMode = "off" | "all" | "one"

type QueueStore = {
  tracks: Track[]
  autoplay: Track[]
  autoplaySeed: string | null
  autoplayLoading: boolean
  repeat: RepeatMode
  shuffle: boolean
  unshuffledTracks: Track[] | null
  replace: (tracks: Track[]) => void
  addNext: (track: Track) => void
  append: (track: Track) => void
  /** Return a track to the front of the queue (history navigation) unless it is already there. */
  prepend: (track: Track) => void
  takeNext: () => Track | null
  remove: (index: number) => void
  move: (from: number, to: number) => void
  clear: () => void
  setAutoplay: (seed: string, tracks: Track[]) => void
  setAutoplayLoading: (seed: string, loading: boolean) => void
  clearAutoplay: () => void
  setRepeat: (repeat: RepeatMode) => void
  setShuffle: (shuffle: boolean) => void
  shuffleTracks: () => void
  snapshotUnshuffled: () => void
  restoreUnshuffledTracks: () => void
  setUnshuffledTracks: (tracks: Track[] | null) => void
}

export const useQueue = create<QueueStore>((set, get) => ({
  tracks: [],
  autoplay: [],
  autoplaySeed: null,
  autoplayLoading: false,
  repeat: "off",
  shuffle: false,
  unshuffledTracks: null,
  replace: (tracks) => set({ tracks }),
  addNext: (track) => set({ tracks: [track, ...get().tracks] }),
  prepend: (track) => {
    const tracks = get().tracks
    if (tracks.some((entry) => entry.videoId === track.videoId)) return
    set({ tracks: [track, ...tracks] })
  },
  append: (track) => {
    const tracks = [...get().tracks]
    const index = get().shuffle ? Math.floor(Math.random() * (tracks.length + 1)) : tracks.length
    tracks.splice(index, 0, track)
    set({ tracks })
  },
  takeNext: () => {
    const [next, ...tracks] = get().tracks
    if (next) set({ tracks })
    return next ?? null
  },
  remove: (index) => set({ tracks: get().tracks.filter((_, i) => i !== index) }),
  move: (from, to) => {
    const tracks = [...get().tracks]
    if (from === to || !tracks[from] || to < 0 || to > tracks.length) return
    const [track] = tracks.splice(from, 1)
    tracks.splice(to, 0, track)
    set({ tracks })
  },
  clear: () => set({ tracks: [], unshuffledTracks: null }),
  setAutoplay: (seed, tracks) => set({ autoplay: tracks, autoplaySeed: seed, autoplayLoading: false }),
  setAutoplayLoading: (seed, loading) =>
    set({ autoplaySeed: seed, autoplayLoading: loading, autoplay: loading ? [] : get().autoplay }),
  clearAutoplay: () => set({ autoplay: [], autoplaySeed: null, autoplayLoading: false }),
  setRepeat: (repeat) => set({ repeat }),
  setShuffle: (shuffle) => set({ shuffle }),
  shuffleTracks: () => set({ tracks: shuffled(get().tracks) }),
  snapshotUnshuffled: () => {
    if (get().unshuffledTracks) return
    set({ unshuffledTracks: [...get().tracks] })
  },
  restoreUnshuffledTracks: () => {
    const snapshot = get().unshuffledTracks
    if (!snapshot) return
    const current = get().tracks
    const remaining = new Set(current.map((track) => track.videoId))
    const restored = snapshot.filter((track) => remaining.has(track.videoId))
    for (const track of current) {
      if (!snapshot.some((saved) => saved.videoId === track.videoId)) restored.push(track)
    }
    set({ tracks: restored, unshuffledTracks: null })
  },
  setUnshuffledTracks: (tracks) => set({ unshuffledTracks: tracks ? [...tracks] : null }),
}))
