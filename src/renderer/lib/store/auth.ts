import { create } from "zustand"
import type { AuthState } from "@shared/types"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { clearQueryCache } from "@/lib/query"
import { toast } from "sonner"

type AuthStore = {
  state: AuthState
  loading: boolean
  init: () => Promise<void>
  login: () => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthStore>((set) => ({
  state: { signedIn: false, user: null },
  loading: false,
  init: async () => {
    try {
      set({ state: await unwrap(api.authState()) })
    } catch {
      set({ state: { signedIn: false, user: null } })
    }
  },
  login: async () => {
    set({ loading: true })
    try {
      const state = await unwrap(api.login())
      set({ state })
      clearQueryCache()
      toast.success("Signed in to YouTube Music")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      set({ loading: false })
    }
  },
  logout: async () => {
    set({ loading: true })
    try {
      set({ state: await unwrap(api.logout()) })
      clearQueryCache()
      toast.success("Signed out")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      set({ loading: false })
    }
  },
}))
