import { create } from "zustand"
import { toast } from "sonner"
import type { DownloadedTrack, DownloadProgress, Track } from "@shared/types"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { downloadMatches } from "@/lib/downloads"

type DownloadsStore = {
  items: DownloadedTrack[]
  active: Record<string, DownloadProgress>
  loading: boolean
  load: () => Promise<void>
  start: (track: Track) => Promise<void>
  remove: (videoId: string) => Promise<void>
}

let started = false

function progressKeys(progress: DownloadProgress): string[] {
  return [...new Set([progress.videoId, progress.sourceVideoId].filter((id): id is string => Boolean(id)))]
}

function applyProgress(progress: DownloadProgress): void {
  const keys = progressKeys(progress)
  useDownloads.setState((state) => {
    const active = { ...state.active }
    for (const key of keys) active[key] = progress
    return { active }
  })
  if (progress.status === "completed") {
    window.setTimeout(() => {
      useDownloads.setState((state) => {
        const active = { ...state.active }
        for (const key of keys) {
          if (active[key] === progress) delete active[key]
        }
        return { active }
      })
    }, 1200)
  }
}

export const useDownloads = create<DownloadsStore>((set, get) => ({
  items: [],
  active: {},
  loading: true,
  load: async () => {
    const items = await unwrap(api.downloadsList()).catch(() => [])
    set({ items, loading: false })
  },
  start: async (track) => {
    const { items, active } = get()
    const pending = active[track.videoId]
    if (items.some((item) => downloadMatches(item, track.videoId)) || (pending && pending.status !== "error")) return
    set((state) => ({
      active: {
        ...state.active,
        [track.videoId]: {
          videoId: track.videoId,
          sourceVideoId: null,
          title: track.title,
          status: "resolving",
          received: 0,
          total: 0,
        },
      },
    }))
    toast(`Downloading ${track.title}`)
    try {
      const item = await unwrap(api.downloadStart({ track }))
      set((state) => ({
        items: [item, ...state.items.filter((entry) => entry.videoId !== item.videoId)],
      }))
      toast.success(`Downloaded ${item.title}`)
    } catch (error) {
      const message = errorMessage(error)
      set((state) => {
        const current = state.active[track.videoId]
        return {
          active: {
            ...state.active,
            [track.videoId]: {
              ...(current ?? {
                videoId: track.videoId,
                sourceVideoId: null,
                title: track.title,
                received: 0,
                total: 0,
              }),
              status: "error",
              error: message,
            },
          },
        }
      })
      toast.error(message)
    }
  },
  remove: async (videoId) => {
    try {
      await unwrap(api.downloadRemove({ videoId }))
      set((state) => {
        const removed = state.items.find((item) => downloadMatches(item, videoId))
        const active = { ...state.active }
        for (const key of [videoId, removed?.videoId, removed?.sourceVideoId]) {
          if (key) delete active[key]
        }
        return {
          items: state.items.filter((item) => !downloadMatches(item, videoId)),
          active,
        }
      })
      toast.success("Download removed")
    } catch (error) {
      toast.error(errorMessage(error))
    }
  },
}))

/** Subscribe to main-process progress and hydrate the downloaded-music grid. */
export function initDownloads(): void {
  if (started) return
  started = true
  api.onDownloadProgress(applyProgress)
  void useDownloads.getState().load()
}
