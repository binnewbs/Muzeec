import { create } from "zustand"

export type View =
  | { name: "home" }
  | { name: "explore" }
  | { name: "library" }
  | { name: "search"; query?: string }
  | { name: "album" | "artist" | "playlist"; id: string; title?: string }
  | { name: "settings" }

type ViewStore = {
  view: View
  stack: View[]
  navigate: (view: View) => void
  back: () => void
}

export const useView = create<ViewStore>((set, get) => ({
  view: { name: "home" },
  stack: [],
  navigate: (view) => set({ view, stack: [...get().stack, get().view].slice(-50) }),
  back: () => {
    const stack = get().stack
    const previous = stack.at(-1)
    if (!previous) return
    set({ view: previous, stack: stack.slice(0, -1) })
  },
}))
