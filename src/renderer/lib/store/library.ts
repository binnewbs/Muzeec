import { create } from "zustand"
import { clearQueryCache } from "@/lib/query"

type LibraryRevision = {
  revision: number
  invalidate: () => void
}

/**
 * Playlist writes happen on the account, so every browse page (library,
 * sidebar picker, playlist detail) has to refetch. Bumping the revision
 * changes the query keys of the components that are currently mounted.
 */
export const useLibraryRevision = create<LibraryRevision>((set) => ({
  revision: 0,
  invalidate: () => {
    clearQueryCache("browse:")
    set((state) => ({ revision: state.revision + 1 }))
  },
}))

export function invalidateLibrary(): void {
  useLibraryRevision.getState().invalidate()
}
