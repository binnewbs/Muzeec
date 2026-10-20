import { useMemo, useState } from "react"
import type { MediaItem } from "@shared/types"
import { LibraryIcon, ListMusicIcon, PinIcon, PinOffIcon } from "lucide-react"
import { api, unwrap } from "@/lib/ipc"
import { useIpcQuery } from "@/lib/query"
import { useAuth } from "@/lib/store/auth"
import { useSettings } from "@/lib/store/settings"
import { useView } from "@/lib/store/view"
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"

const PLAYLISTS_BROWSE_ID = "FEmusic_liked_playlists"

/** Playlist browse IDs arrive with a `VL` prefix on some pages only. */
function bareId(id: string): string {
  return id.startsWith("VL") ? id.slice(2) : id
}

export function PinnedPlaylists() {
  const signedIn = useAuth((state) => state.state.signedIn)
  const pinned = useSettings((state) => state.settings.pinnedPlaylists)
  const update = useSettings((state) => state.update)
  const navigate = useView((state) => state.navigate)
  const current = useView((state) => state.view)
  const [open, setOpen] = useState(false)

  // Lazy: the sidebar reads pinned playlists from settings, so opening the
  // dropdown is the only moment this list is fetched.
  const { data, error, loading } = useIpcQuery(
    `browse:${PLAYLISTS_BROWSE_ID}`,
    () => unwrap(api.browse({ browseId: PLAYLISTS_BROWSE_ID })),
    { enabled: signedIn && open },
  )

  const playlists = useMemo(
    () => (data?.shelves ?? []).flatMap((shelf) => shelf.items).filter((item) => item.kind === "playlist"),
    [data],
  )
  const pinnedIds = useMemo(() => new Set(pinned.map((entry) => bareId(entry.id))), [pinned])
  const activeId = current.name === "playlist" ? bareId(current.id) : null
  const loadingList = open && !error && (loading || !data)

  if (!signedIn) return null

  const toggle = (playlist: { id: string; title: string }): void => {
    const list = useSettings.getState().settings.pinnedPlaylists
    const id = bareId(playlist.id)
    const exists = list.some((entry) => bareId(entry.id) === id)
    void update({
      pinnedPlaylists: exists
        ? list.filter((entry) => bareId(entry.id) !== id)
        : [...list, { id: playlist.id, title: playlist.title }],
    })
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Playlists</SidebarGroupLabel>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<SidebarGroupAction aria-label="Pin playlists" />}>
          <PinIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-64">
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
              playlists.map((playlist: MediaItem) => (
                <DropdownMenuCheckboxItem
                  key={playlist.id}
                  checked={pinnedIds.has(bareId(playlist.id))}
                  closeOnClick={false}
                  onCheckedChange={() => toggle(playlist)}
                >
                  <span className="truncate">{playlist.title}</span>
                </DropdownMenuCheckboxItem>
              ))
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
            <SidebarMenuItem key={playlist.id}>
              <SidebarMenuButton
                isActive={activeId === bareId(playlist.id)}
                tooltip={playlist.title}
                onClick={() => navigate({ name: "playlist", id: playlist.id, title: playlist.title })}
              >
                <ListMusicIcon />
                <span>{playlist.title}</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                showOnHover
                aria-label={`Unpin ${playlist.title}`}
                title="Unpin"
                onClick={() => toggle(playlist)}
              >
                <PinOffIcon />
              </SidebarMenuAction>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
