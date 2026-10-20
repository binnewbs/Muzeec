import { create } from "zustand"
import type { Track } from "@shared/types"

type QueueStore = {
  tracks: Track[]
  index: number
  set: (tracks: Track[], index: number) => void
  nextIndex: () => number | null
  prevIndex: () => number | null
  addNext: (track: Track) => void
  append: (tracks: Track[]) => void
  remove: (index: number) => void
  clear: () => void
}

export const useQueue = create<QueueStore>((set, get) => ({
  tracks: [],
  index: -1,
  set: (tracks, index) => set({ tracks, index }),
  nextIndex: () => {
    const { tracks, index } = get()
    return index + 1 < tracks.length ? index + 1 : null
  },
  prevIndex: () => {
    const { index } = get()
    return index > 0 ? index - 1 : null
  },
  addNext: (track) => {
    const { tracks, index } = get()
    const next = [...tracks]
    next.splice(index + 1, 0, track)
    set({ tracks: next })
  },
  append: (tracks) => set({ tracks: [...get().tracks, ...tracks] }),
  remove: (index) => {
    const tracks = get().tracks.filter((_, i) => i !== index)
    const current = get().index
    set({ tracks, index: index < current ? current - 1 : Math.min(current, tracks.length - 1) })
  },
  clear: () => set({ tracks: [], index: -1 }),
}))
