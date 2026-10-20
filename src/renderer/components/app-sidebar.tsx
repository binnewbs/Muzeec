import { CompassIcon, HomeIcon, LibraryIcon, LogOutIcon, SearchIcon, SettingsIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Logo } from "@/components/logo"
import { PinnedPlaylists } from "@/components/pinned-playlists"
import { useAuth } from "@/lib/store/auth"
import { useView, type View } from "@/lib/store/view"

const NAV = [
  { view: { name: "home" } as View, label: "Home", icon: HomeIcon },
  { view: { name: "explore" } as View, label: "Explore", icon: CompassIcon },
  { view: { name: "library" } as View, label: "Library", icon: LibraryIcon },
  { view: { name: "search" } as View, label: "Search", icon: SearchIcon },
]

export function AppSidebar() {
  const navigate = useView((state) => state.navigate)
  const current = useView((state) => state.view)
  const { toggleSidebar } = useSidebar()
  const { state, login, logout, loading } = useAuth()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="py-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={toggleSidebar}
              tooltip="Muzeec"
              className="h-12 group-data-[collapsible=icon]:justify-center"
            >
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Logo className="size-5" />
              </div>
              <div className="flex flex-col gap-0.5 leading-none group-data-[collapsible=icon]:hidden">
                <span className="font-heading text-sm font-semibold">Muzeec</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pt-1">
          <SidebarGroupLabel>Browse</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    isActive={current.name === item.view.name}
                    tooltip={item.label}
                    onClick={() => navigate(item.view)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <PinnedPlaylists />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={current.name === "settings"}
              tooltip="Settings"
              onClick={() => navigate({ name: "settings" })}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {state.signedIn && state.user ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SidebarMenuButton size="lg" aria-label={state.user.name ?? "Account"} />}
                >
                  <Avatar className="size-8">
                    <AvatarImage src={state.user.avatar ?? undefined} alt="" />
                    <AvatarFallback>{(state.user.name ?? "Y").slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col gap-0.5 leading-none">
                    <span className="truncate text-sm font-medium">{state.user.name ?? "Signed in"}</span>
                    <span className="text-xs text-muted-foreground">Account {state.user.authUser}</span>
                  </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>YouTube Music</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => navigate({ name: "settings" })}>Settings</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={loading} onClick={() => void logout()}>
                      <LogOutIcon data-icon="inline-start" />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SidebarMenuButton size="lg" tooltip="Sign in" disabled={loading} onClick={() => void login()}>
                <Avatar className="size-7">
                  <AvatarFallback>Y</AvatarFallback>
                </Avatar>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="text-sm font-medium">Sign in</span>
                  <span className="text-xs text-muted-foreground">Sync likes</span>
                </div>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
