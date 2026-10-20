import { useEffect, useState } from "react"
import type { MediaItem } from "@shared/types"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"

type Props = {
  videoId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddToPlaylistDialog({ videoId, title, open, onOpenChange }: Props) {
  const [playlists, setPlaylists] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    unwrap(api.browse({ browseId: "FEmusic_liked_playlists" }))
      .then((page) => {
        if (!alive) return
        setPlaylists(page.shelves.flatMap((shelf) => shelf.items).filter((item) => item.kind === "playlist"))
      })
      .catch((error) => alive && toast.error(errorMessage(error)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open])

  const add = async (playlistId: string) => {
    setBusy(true)
    try {
      await unwrap(api.playlistAdd({ playlistId, videoId }))
      toast.success(`Added to playlist`)
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    const value = name.trim()
    if (!value) return
    setBusy(true)
    try {
      await unwrap(api.playlistCreate({ title: value, videoId }))
      toast.success(`Created “${value}”`)
      setName("")
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to playlist</DialogTitle>
          <DialogDescription className="truncate">{title}</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="New playlist" maxLength={150} />
          <Button type="submit" disabled={busy || !name.trim()} aria-label="Create playlist">
            <PlusIcon data-icon="inline-start" />
            Create
          </Button>
        </form>
        <ScrollArea className="max-h-64">
          {loading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : playlists.length ? (
            <div className="flex flex-col gap-1">
              {playlists.map((playlist) => (
                <Button
                  key={playlist.id}
                  variant="ghost"
                  className="justify-start"
                  disabled={busy}
                  onClick={() => void add(playlist.id)}
                >
                  <span className="truncate">{playlist.title}</span>
                </Button>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No playlists yet.</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
