import { create } from "zustand"
import type { Track } from "@shared/types"

type Status = "idle" | "loading" | "playing" | "paused" | "error"

type PlayerStore = {
  current: Track | null
  status: Status
  error: string | null
  duration: number
  liked: boolean
  volume: number
  muted: boolean
  set: (patch: Partial<Omit<PlayerStore, "set">>) => void
}

export const usePlayer = create<PlayerStore>((set) => ({
  current: null,
  status: "idle",
  error: null,
  duration: 0,
  liked: false,
  volume: 0.8,
  muted: false,
  set: (patch) => set(patch),
}))
