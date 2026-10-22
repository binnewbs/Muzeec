import { useState } from "react"
import type { MediaItem } from "@shared/types"
import { CompassIcon, DownloadIcon, PlusIcon } from "lucide-react"
import downloadsCover from "@/assets/downloads-cover.svg"
import { BrowseView } from "@/components/browse-view"
import { CreatePlaylistDialog } from "@/components/create-playlist-dialog"
import { MediaCard } from "@/components/media-card"
import { MediaGrid } from "@/components/media-shelf"
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

  const downloadsItem: MediaItem = {
    kind: "playlist",
    id: "__downloads",
    title: "Downloaded Music",
    subtitle: downloads.length
      ? `Offline • ${downloads.length} ${downloads.length === 1 ? "song" : "songs"}`
      : "Offline • No songs yet",
    thumbnail: downloadsCover,
  }
  const downloadsCard = (
    <MediaCard item={downloadsItem} fill onActivate={() => navigate({ name: "downloads" })} />
  )

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Library</h1>
        <MediaGrid shelf={{ title: "", items: [] }} leading={downloadsCard} />
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
      <BrowseView browseId="FEmusic_library_landing" title="Library" grid pinned={downloadsCard} />
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
