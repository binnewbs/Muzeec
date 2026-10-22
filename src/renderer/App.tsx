import { Suspense, lazy, useEffect } from "react"
import { SearchIcon } from "lucide-react"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { AppSidebar } from "@/components/app-sidebar"
import { CommandPalette } from "@/components/command-palette"
import { PlayerBar } from "@/components/player-bar"
import { WindowControls } from "@/components/window-controls"
import { PageLoading } from "@/components/page-states"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAuth } from "@/lib/store/auth"
import { useSettings } from "@/lib/store/settings"
import { useView } from "@/lib/store/view"
import { initDownloads } from "@/lib/store/downloads"
import { initPlayer } from "@/player/controller"
import { usePlaybackShortcuts } from "@/hooks/use-playback-shortcuts"

const HomePage = lazy(() => import("@/pages/home"))
const ExplorePage = lazy(() => import("@/pages/explore"))
const LibraryPage = lazy(() => import("@/pages/library"))
const DownloadsPage = lazy(() => import("@/pages/downloads"))
const HistoryPage = lazy(() => import("@/pages/history"))
const SearchPage = lazy(() => import("@/pages/search"))
const DetailPage = lazy(() => import("@/pages/detail"))
const ArtistPage = lazy(() => import("@/pages/artist"))
const SettingsPage = lazy(() => import("@/pages/settings"))

export default function App() {
  const view = useView((state) => state.view)
  const settings = useSettings((state) => state.settings)
  const loadSettings = useSettings((state) => state.load)
  const initAuth = useAuth((state) => state.init)

  usePlaybackShortcuts()

  useEffect(() => {
    void (async () => {
      await loadSettings()
      initPlayer()
      initDownloads()
      await initAuth()
    })()
  }, [loadSettings, initAuth])

  useEffect(() => {
    if (settings.theme !== "system") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => document.documentElement.classList.toggle("dark", media.matches)
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [settings.theme])

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="flex h-svh min-h-0 flex-col overflow-hidden">
          <header className="app-drag flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <div className="app-no-drag flex items-center gap-2">
              <SidebarTrigger />
              <CommandPalette />
            </div>
            <div className="app-no-drag ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground"
                onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              >
                <SearchIcon data-icon="inline-start" />
                Search
                <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
              </Button>
              <WindowControls />
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="mx-auto w-full max-w-6xl px-6 py-6">
                <Suspense fallback={<PageLoading />}>
                  {view.name === "home" ? (
                    <HomePage />
                  ) : view.name === "explore" ? (
                    <ExplorePage />
                  ) : view.name === "library" ? (
                    <LibraryPage />
                  ) : view.name === "downloads" ? (
                    <DownloadsPage />
                  ) : view.name === "history" ? (
                    <HistoryPage />
                  ) : view.name === "search" ? (
                    <SearchPage key={view.query ?? "empty"} initialQuery={view.query} />
                  ) : view.name === "settings" ? (
                    <SettingsPage />
                  ) : view.name === "artist" ? (
                    <ArtistPage key={view.id} id={view.id} title={view.title} />
                  ) : (
                    <DetailPage
                      key={view.id}
                      id={view.id}
                      kind={view.name}
                      title={"title" in view ? view.title : undefined}
                    />
                  )}
                </Suspense>
              </div>
            </ScrollArea>
          </div>
          <PlayerBar />
        </SidebarInset>
      </SidebarProvider>
      <Toaster theme={settings.theme === "system" ? "system" : settings.theme} position="bottom-right" />
    </TooltipProvider>
  )
}
