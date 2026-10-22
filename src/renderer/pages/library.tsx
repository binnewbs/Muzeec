import { useState } from "react"
import { ChevronRightIcon, CompassIcon, DownloadIcon, PlusIcon } from "lucide-react"
import { BrowseView } from "@/components/browse-view"
import { CreatePlaylistDialog } from "@/components/create-playlist-dialog"
import { SpotifyImportDialog } from "@/components/spotify-import-dialog"
import { PageEmpty } from "@/components/page-states"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/store/auth"
import { useDownloads } from "@/lib/store/downloads"
import { useView } from "@/lib/store/view"

export default function LibraryPage() {
  const signedIn = useAuth((state) => state.state.signedIn)
  const login = useAuth((state) => state.login)
  const loading = useAuth((state) => state.loading)
  const downloads = useDownloads((state) => state.items)
  const navigate = useView((state) => state.navigate)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const downloadedTile = (
    <button
      type="button"
      onClick={() => navigate({ name: "downloads" })}
      className="flex w-full items-center gap-4 rounded-2xl border bg-muted/20 p-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <DownloadIcon className="size-6" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-heading text-lg font-medium tracking-tight">Downloaded Music</span>
        <span className="truncate text-sm text-muted-foreground">
          {downloads.length
            ? `${downloads.length} ${downloads.length === 1 ? "song" : "songs"} saved on this device`
            : "Save songs to listen without a connection"}
        </span>
      </span>
      <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
    </button>
  )

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-6">
        {downloadedTile}
        <PageEmpty
          title="Your library lives on YouTube Music"
          description="Sign in to see your playlists, liked songs and artists."
          action={
            <div className="flex gap-2">
              <Button disabled={loading} onClick={() => void login()}>
                Sign in
              </Button>
              <Button variant="ghost" onClick={() => navigate({ name: "explore" })}>
                Explore instead
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {downloadedTile}
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <CompassIcon className="size-4" />
        <span className="text-sm">Live from your account</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
            <DownloadIcon data-icon="inline-start" />
            Import from Spotify
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            New playlist
          </Button>
        </div>
      </div>
      <BrowseView browseId="FEmusic_library_landing" title="Library" grid />
      <CreatePlaylistDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, title) => navigate({ name: "playlist", id, title })}
      />
      <SpotifyImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImported={(id, title) => navigate({ name: "playlist", id, title })}
      />
    </div>
  )
}
