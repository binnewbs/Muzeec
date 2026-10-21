import { useEffect, useRef, useState } from "react"
import type { SpotifyImportProgress, SpotifyImportResult } from "@shared/types"
import { extractPlaylistId, isSpotifyShortLink } from "@shared/spotify"
import { DownloadIcon } from "lucide-react"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { invalidateLibrary } from "@/lib/store/library"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported?: (playlistId: string, title: string) => void
}

type Phase = "idle" | "working" | "success" | "error"

function progressLabel(progress: SpotifyImportProgress | null): string {
  if (!progress) return "Starting…"
  switch (progress.phase) {
    case "reading":
      return "Reading the Spotify playlist…"
    case "matching":
      return `Matching songs ${progress.done} of ${progress.total}…`
    case "creating":
      return "Creating the playlist…"
    case "adding":
      return `Adding songs ${progress.done} of ${progress.total}…`
  }
}

function progressPercent(progress: SpotifyImportProgress | null): number | null {
  if (!progress || !progress.total) return null
  if (progress.phase !== "matching" && progress.phase !== "adding") return null
  return Math.round((progress.done / progress.total) * 100)
}

export function SpotifyImportDialog({ open, onOpenChange, onImported }: Props) {
  const [url, setUrl] = useState("")
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState<SpotifyImportProgress | null>(null)
  const [result, setResult] = useState<SpotifyImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const jobRef = useRef<string | null>(null)
  const busy = phase === "working"

  useEffect(() => {
    if (open) return
    setUrl("")
    setPhase("idle")
    setProgress(null)
    setResult(null)
    setError(null)
    setFieldError(null)
    jobRef.current = null
  }, [open])

  useEffect(
    () =>
      window.muzeec.onSpotifyProgress((update) => {
        if (update.jobId !== jobRef.current) return
        setProgress(update)
      }),
    [],
  )

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return

    if (!extractPlaylistId(url)) {
      setFieldError(
        isSpotifyShortLink(url)
          ? "That's a Spotify short link. Use “Copy link to playlist” instead."
          : "That isn't a Spotify playlist link.",
      )
      return
    }

    const jobId = crypto.randomUUID()
    jobRef.current = jobId
    setFieldError(null)
    setError(null)
    setResult(null)
    setProgress(null)
    setPhase("working")

    try {
      const data = await unwrap(api.spotifyImport({ url, jobId }))
      if (jobRef.current !== jobId) return
      setResult(data)
      setPhase("success")
      invalidateLibrary()
      toast.success(`Imported “${data.title}”`)
    } catch (cause) {
      if (jobRef.current !== jobId) return
      const message = errorMessage(cause)
      if (message === "Import cancelled") {
        setPhase("idle")
        setProgress(null)
      } else {
        setError(message)
        setPhase("error")
      }
    } finally {
      if (jobRef.current === jobId) jobRef.current = null
    }
  }

  const cancel = () => {
    const jobId = jobRef.current
    if (!jobId) {
      onOpenChange(false)
      return
    }
    void unwrap(api.spotifyCancel({ jobId })).catch((cause) => toast.error(errorMessage(cause)))
  }

  const close = (next: boolean) => {
    if (!next && busy) return
    onOpenChange(next)
  }

  const percent = progressPercent(progress)

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Import from Spotify</DialogTitle>
          <DialogDescription>
            Paste a public Spotify playlist link. Muzeec matches each song on YouTube Music and creates a private
            playlist.
          </DialogDescription>
        </DialogHeader>

        {phase === "success" && result ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="font-heading text-lg font-medium">Imported “{result.title}”</p>
              <p className="text-sm text-muted-foreground">
                Added {result.added} of {result.total} songs to your YouTube Music library.
              </p>
            </div>

            {result.skipped > 0 ? (
              <p className="text-sm text-muted-foreground">
                {result.skipped} podcast episode{result.skipped === 1 ? "" : "s"} or non-track item
                {result.skipped === 1 ? " was" : "s were"} skipped.
              </p>
            ) : null}

            {result.truncated ? (
              <Alert>
                <DownloadIcon />
                <AlertTitle>Spotify limited this import</AlertTitle>
                <AlertDescription>
                  Only the first 100 songs were available from the public playlist page.
                </AlertDescription>
              </Alert>
            ) : null}

            {result.warning ? (
              <Alert variant="destructive">
                <DownloadIcon />
                <AlertTitle>Playlist created with a warning</AlertTitle>
                <AlertDescription>{result.warning}</AlertDescription>
              </Alert>
            ) : null}

            {result.unmatched.length ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                  {result.unmatched.length} song{result.unmatched.length === 1 ? "" : "s"} weren’t found
                </p>
                <ScrollArea className="max-h-40 rounded-xl border">
                  <ul className="flex flex-col divide-y">
                    {result.unmatched.map((track, index) => (
                      <li key={`${track.title}-${index}`} className="flex flex-col gap-0.5 px-3 py-2">
                        <span className="truncate text-sm">{track.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {track.artists.join(", ") || "Unknown artist"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              </div>
            ) : null}
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <FieldGroup>
              <Field data-invalid={fieldError ? true : undefined}>
                <FieldLabel htmlFor="spotify-playlist-url">Playlist link</FieldLabel>
                <Input
                  id="spotify-playlist-url"
                  autoFocus
                  value={url}
                  disabled={busy}
                  onChange={(event) => {
                    setUrl(event.target.value)
                    if (fieldError) setFieldError(null)
                  }}
                  placeholder="https://open.spotify.com/playlist/…"
                  maxLength={2048}
                  aria-invalid={Boolean(fieldError)}
                />
                <FieldError>{fieldError}</FieldError>
              </Field>
            </FieldGroup>

            {busy ? (
              <div className="flex flex-col gap-2 rounded-xl border bg-muted/20 px-3 py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner />
                  <span>{progressLabel(progress)}</span>
                </div>
                {percent !== null ? <Progress value={percent} /> : null}
              </div>
            ) : null}

            {error ? (
              <Alert variant="destructive">
                <DownloadIcon />
                <AlertTitle>Import failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              {busy ? (
                <Button type="button" variant="outline" onClick={cancel}>
                  Cancel import
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={() => close(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!url.trim()}>
                    <DownloadIcon data-icon="inline-start" />
                    Import
                  </Button>
                </>
              )}
            </DialogFooter>
          </form>
        )}

        {phase === "success" && result ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                onImported?.(result.playlistId, result.title)
                close(false)
              }}
            >
              Open playlist
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
