import { useEffect, useMemo, useRef, useState } from "react"
import type { MediaItem } from "@shared/types"
import { LibraryIcon, ListMusicIcon, PinIcon, PinOffIcon } from "lucide-react"
import { api, unwrap } from "@/lib/ipc"
import { barePlaylistId } from "@/lib/media"
import { useIpcQuery } from "@/lib/query"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/store/auth"
import { useLibraryRevision } from "@/lib/store/library"
import { useSettings } from "@/lib/store/settings"
import { useView } from "@/lib/store/view"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"

const PLAYLISTS_BROWSE_ID = "FEmusic_liked_playlists"

export function PinnedPlaylists() {
  const signedIn = useAuth((state) => state.state.signedIn)
  const pinned = useSettings((state) => state.settings.pinnedPlaylists)
  const update = useSettings((state) => state.update)
  const navigate = useView((state) => state.navigate)
  const current = useView((state) => state.view)
  const revision = useLibraryRevision((state) => state.revision)
  const [open, setOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const draggingRef = useRef<string | null>(null)

  // Lazy: the sidebar reads pinned playlists from settings, so opening the
  // dropdown is the only moment this list is fetched.
  const { data, error, loading } = useIpcQuery(
    `browse:${PLAYLISTS_BROWSE_ID}:${revision}`,
    () => unwrap(api.browse({ browseId: PLAYLISTS_BROWSE_ID })),
    { enabled: signedIn && open },
  )

  const playlists = useMemo(
    () => (data?.shelves ?? []).flatMap((shelf) => shelf.items).filter((item) => item.kind === "playlist"),
    [data],
  )
  const pinnedIds = useMemo(() => new Set(pinned.map((entry) => barePlaylistId(entry.id))), [pinned])
  const activeId = current.name === "playlist" ? barePlaylistId(current.id) : null
  const loadingList = open && !error && (loading || !data)

  // Backfill covers (and renamed titles) for playlists pinned before thumbnails were stored.
  useEffect(() => {
    if (!playlists.length) return
    const list = useSettings.getState().settings.pinnedPlaylists
    if (!list.length) return
    let changed = false
    const next = list.map((entry) => {
      const match = playlists.find((item) => barePlaylistId(item.id) === barePlaylistId(entry.id))
      if (!match) return entry
      const thumbnail = match.thumbnail ?? null
      if (entry.title === match.title && entry.thumbnail === thumbnail) return entry
      changed = true
      return { ...entry, title: match.title, thumbnail }
    })
    if (changed) void useSettings.getState().update({ pinnedPlaylists: next })
  }, [playlists])

  if (!signedIn) return null

  const toggle = (playlist: { id: string; title: string; thumbnail: string | null }): void => {
    const list = useSettings.getState().settings.pinnedPlaylists
    const id = barePlaylistId(playlist.id)
    const exists = list.some((entry) => barePlaylistId(entry.id) === id)
    void update({
      pinnedPlaylists: exists
        ? list.filter((entry) => barePlaylistId(entry.id) !== id)
        : [...list, { id: playlist.id, title: playlist.title, thumbnail: playlist.thumbnail ?? null }],
    })
  }

  /** Persist the sidebar order after a drag. */
  const move = (from: number, to: number): void => {
    if (from === to) return
    const list = useSettings.getState().settings.pinnedPlaylists
    if (from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [entry] = next.splice(from, 1)
    next.splice(to, 0, entry)
    void update({ pinnedPlaylists: next })
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Playlists</SidebarGroupLabel>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<SidebarGroupAction aria-label="Pin playlists" />}>
          <PinIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-64 scrollbar-subtle">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Pin playlists</DropdownMenuLabel>
            {loadingList ? (
              <DropdownMenuItem disabled>
                <Spinner />
                Loading playlists…
              </DropdownMenuItem>
            ) : error ? (
              <DropdownMenuItem disabled className="truncate">
                {error}
              </DropdownMenuItem>
            ) : playlists.length ? (
              <div className="scrollbar-subtle max-h-[min(16rem,calc(var(--available-height)-7rem))] overflow-y-auto overscroll-contain">
                {playlists.map((playlist: MediaItem) => (
                  <DropdownMenuCheckboxItem
                    key={playlist.id}
                    checked={pinnedIds.has(barePlaylistId(playlist.id))}
                    closeOnClick={false}
                    onCheckedChange={() => toggle(playlist)}
                  >
                    <span className="truncate">{playlist.title}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
            ) : (
              <DropdownMenuItem disabled>No playlists yet</DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => navigate({ name: "library" })}>
              <LibraryIcon />
              Open library
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidebarGroupContent>
        <SidebarMenu>
          {pinned.map((playlist) => (
            <SidebarMenuItem
              key={playlist.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", playlist.id)
                draggingRef.current = playlist.id
                setDraggingId(playlist.id)
              }}
              onDragOver={(event) => {
                if (draggingRef.current === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                setOverId(playlist.id)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = pinned.findIndex((entry) => entry.id === draggingRef.current)
                const to = pinned.findIndex((entry) => entry.id === playlist.id)
                draggingRef.current = null
                setDraggingId(null)
                setOverId(null)
                if (from >= 0 && to >= 0) move(from, to)
              }}
              onDragEnd={() => {
                draggingRef.current = null
                setDraggingId(null)
                setOverId(null)
              }}
              className={cn(
                draggingId === playlist.id && "opacity-50",
                overId === playlist.id && draggingId !== playlist.id && "rounded-xl ring-1 ring-sidebar-ring",
              )}
            >
              <ContextMenu>
                <ContextMenuTrigger className="block w-full">
                  <SidebarMenuButton
                    isActive={activeId === barePlaylistId(playlist.id)}
                    tooltip={playlist.title}
                    onClick={() => navigate({ name: "playlist", id: playlist.id, title: playlist.title })}
                  >
                    {playlist.thumbnail ? (
                      <img
                        src={playlist.thumbnail}
                        alt=""
                        width={32}
                        height={32}
                        loading="lazy"
                        decoding="async"
                        className="size-4 shrink-0 rounded-[4px] object-cover"
                      />
                    ) : (
                      <ListMusicIcon />
                    )}
                    <span>{playlist.title}</span>
                  </SidebarMenuButton>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => toggle(playlist)}>
                      <PinOffIcon />
                      Unpin from sidebar
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
