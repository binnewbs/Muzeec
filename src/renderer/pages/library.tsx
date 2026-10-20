import { useState } from "react"
import { CompassIcon, PlusIcon } from "lucide-react"
import { BrowseView } from "@/components/browse-view"
import { CreatePlaylistDialog } from "@/components/create-playlist-dialog"
import { PageEmpty } from "@/components/page-states"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/store/auth"
import { useView } from "@/lib/store/view"

export default function LibraryPage() {
  const signedIn = useAuth((state) => state.state.signedIn)
  const login = useAuth((state) => state.login)
  const loading = useAuth((state) => state.loading)
  const navigate = useView((state) => state.navigate)
  const [creating, setCreating] = useState(false)

  if (!signedIn) {
    return (
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
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <CompassIcon className="size-4" />
        <span className="text-sm">Live from your account</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          New playlist
        </Button>
      </div>
      <BrowseView browseId="FEmusic_library_landing" title="Library" grid />
      <CreatePlaylistDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, title) => navigate({ name: "playlist", id, title })}
      />
    </div>
  )
}
