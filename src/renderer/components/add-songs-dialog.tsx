import { useEffect, useMemo, useState } from "react"
import type { Track } from "@shared/types"
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { formatDuration, tracksOf } from "@/lib/media"
import { useIpcQuery } from "@/lib/query"
import { invalidateLibrary } from "@/lib/store/library"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"

type Props = {
  playlistId: string
  playlistTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Searches YouTube Music and adds the picked songs to an existing playlist. */
export function AddSongsDialog({ playlistId, playlistTitle, open, onOpenChange }: Props) {
  const [query, setQuery] = useState("")
  const debounced = useDebounced(query.trim())
  const active = debounced.length >= 2
  const [pending, setPending] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [addedCount, setAddedCount] = useState(0)

  const { data, error, loading } = useIpcQuery(
    `search:${debounced}`,
    () => unwrap(api.search({ query: debounced })),
    { enabled: open && active, staleTime: 5 * 60 * 1000 },
  )

  const results = useMemo(() => {
    const seen = new Set<string>()
    return tracksOf((data?.shelves ?? []).flatMap((shelf) => shelf.items))
      .filter((track) => {
        if (seen.has(track.videoId)) return false
        seen.add(track.videoId)
        return true
      })
      .slice(0, 40)
  }, [data])

  useEffect(() => {
    if (!open) return
    setQuery("")
    setAdded(new Set())
    setAddedCount(0)
    setPending(null)
  }, [open])

  const close = (next: boolean) => {
    if (!next) {
      // One refresh for the whole session instead of one per added song.
      if (addedCount > 0) invalidateLibrary()
      setAddedCount(0)
    }
    onOpenChange(next)
  }

  const add = async (track: Track) => {
    if (pending || added.has(track.videoId)) return
    setPending(track.videoId)
    try {
      await unwrap(api.playlistAdd({ playlistId, videoId: track.videoId }))
      setAdded((previous) => new Set(previous).add(track.videoId))
      setAddedCount((count) => count + 1)
      toast.success(`Added “${track.title}”`)
    } catch (cause) {
      toast.error(errorMessage(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add songs</DialogTitle>
          <DialogDescription className="truncate">Search and add songs to “{playlistTitle}”.</DialogDescription>
        </DialogHeader>
        <InputGroup className="min-w-0">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Songs, artists"
            aria-label="Search songs to add"
          />
        </InputGroup>
        <ScrollArea className="max-h-80 min-w-0">
          {!active ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Type at least two characters.</p>
          ) : loading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : error ? (
            <p className="py-6 text-center text-sm text-destructive">{error}</p>
          ) : results.length ? (
            <div className="flex flex-col gap-1">
              {results.map((track) => {
                const isAdded = added.has(track.videoId)
                return (
                  <div
                    key={track.videoId}
                    className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50"
                  >
                    {track.thumbnail ? (
                      <img
                        src={track.thumbnail}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        decoding="async"
                        className="size-10 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="size-10 shrink-0 rounded-md bg-muted" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{track.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{track.subtitle}</p>
                    </div>
                    {track.duration ? (
                      <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(track.duration)}</span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={isAdded ? `${track.title} added` : `Add ${track.title}`}
                      disabled={Boolean(pending) || isAdded}
                      onClick={() => void add(track)}
                    >
                      {isAdded ? <CheckIcon /> : pending === track.videoId ? <Spinner /> : <PlusIcon />}
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No songs found.</p>
          )}
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
