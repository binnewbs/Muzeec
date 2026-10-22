import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import type { MediaItem, Track } from "@shared/types"
import { MoreHorizontalIcon, ListPlusIcon, MusicIcon, PauseIcon, PlayIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { AddToPlaylistDialog } from "@/components/add-to-playlist"
import { ArtistLinks } from "@/components/artist-links"
import { useAuth } from "@/lib/store/auth"
import { useView } from "@/lib/store/view"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatDuration, toTrack } from "@/lib/media"
import { cn } from "@/lib/utils"
import { usePlayer } from "@/lib/store/player"
import { playTracks, playTrack, playTrackNext, addToQueue, likeTrack, toggleLike, togglePlay } from "@/player/controller"

type Props = {
  items: MediaItem[]
  context?: MediaItem[]
  layout?: "list" | "grid"
  /** True while more items can be fetched from the main process (paged collections). */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  /** Enable drag-to-reorder on the rows (playlist pages). */
  reorderable?: boolean
  onReorder?: (from: number, to: number) => void
}

/** Rows rendered before the first scroll extends the window. */
const PAGE_SIZE = 150
const TYPE_LABELS = new Set(["song", "video", "single", "album", "ep", "podcast", "music video"])

export function TrackList({
  items,
  context,
  layout = "list",
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  reorderable = false,
  onReorder,
}: Props) {
  const currentId = usePlayer((state) => state.current?.videoId)
  const playing = usePlayer((state) => state.status === "playing")
  const signedIn = useAuth((state) => state.state.signedIn)
  const [addTo, setAddTo] = useState<Track | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const draggingRef = useRef<number | null>(null)
  const canReorder = reorderable && Boolean(onReorder)

  const collection = useMemo(
    () => context?.filter((item) => item.kind === "track").map(toTrack) ?? [],
    [context],
  )

  const play = useCallback(
    (track: Track) => {
      const index = collection.findIndex((entry) => entry.videoId === track.videoId)
      if (collection.length > 1 && index >= 0) void playTracks(collection, index)
      else void playTrack(track)
    },
    [collection],
  )

  const openAddTo = useCallback((track: Track) => setAddTo(track), [])

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>, index: number) => {
      if (!canReorder) return
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", String(index))
      draggingRef.current = index
      setDraggingIndex(index)
    },
    [canReorder],
  )

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, index: number) => {
      if (!canReorder || draggingRef.current === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      setOverIndex(index)
    },
    [canReorder],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, index: number) => {
      event.preventDefault()
      const from = draggingRef.current
      draggingRef.current = null
      setDraggingIndex(null)
      setOverIndex(null)
      if (from === null || from === index) return
      onReorder?.(from, index)
    },
    [onReorder],
  )

  const handleDragEnd = useCallback(() => {
    draggingRef.current = null
    setDraggingIndex(null)
    setOverIndex(null)
  }, [])

  // Bound the DOM: render a window of rows and extend it as the list scrolls.
  const [visibleCount, setVisibleCount] = useState(() => Math.min(items.length, PAGE_SIZE))
  useEffect(() => {
    setVisibleCount((count) => Math.min(Math.max(count, Math.min(items.length, PAGE_SIZE)), items.length))
  }, [items.length])

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(loadingMore)
  loadingRef.current = loadingMore

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver === "undefined") return
    const localRemaining = visibleCount < items.length
    if (!localRemaining && !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (visibleCount < items.length) setVisibleCount((count) => Math.min(items.length, count + PAGE_SIZE))
        else if (hasMore && !loadingRef.current) onLoadMore?.()
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [visibleCount, items.length, hasMore, onLoadMore])

  const visible = useMemo(() => items.slice(0, visibleCount), [items, visibleCount])
  const remaining = items.length - visibleCount
  const hasAnyMore = remaining > 0 || hasMore

  return (
    <div className={layout === "grid" ? "grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col"}>
      {visible.map((item, index) => {
        const active = currentId === item.id
        return (
          <TrackRow
            key={`${item.kind}${item.id}-${index}`}
            index={index}
            item={item}
            active={active}
            playing={active && playing}
            signedIn={signedIn}
            reorderable={canReorder}
            dragging={draggingIndex === index}
            over={overIndex === index && draggingIndex !== index}
            onPlay={play}
            onAddTo={openAddTo}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        )
      })}
      {hasAnyMore ? (
        <div
          ref={sentinelRef}
          className={layout === "grid" ? "col-span-full flex justify-center py-3" : "flex justify-center py-3"}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={() => {
              if (visibleCount < items.length) setVisibleCount((count) => Math.min(items.length, count + PAGE_SIZE))
              else onLoadMore?.()
            }}
          >
            {loadingMore ? "Loading…" : remaining > 0 ? `Show more (${remaining})` : "Load more songs"}
          </Button>
        </div>
      ) : null}
      <AddToPlaylistDialog
        videoId={addTo?.videoId ?? ""}
        title={addTo?.title ?? ""}
        open={addTo !== null}
        onOpenChange={(open) => !open && setAddTo(null)}
      />
    </div>
  )
}

const TrackRow = memo(function TrackRow({
  index,
  item,
  active,
  playing,
  signedIn,
  reorderable,
  dragging,
  over,
  onPlay,
  onAddTo,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  index: number
  item: MediaItem
  active: boolean
  playing: boolean
  signedIn: boolean
  reorderable: boolean
  dragging: boolean
  over: boolean
  onPlay: (track: Track) => void
  onAddTo: (track: Track) => void
  onDragStart: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragOver: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDrop: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragEnd: () => void
}) {
  const track = toTrack(item)
  const artistNames = (track.artists ?? []).map((artist) => artist.name.trim().toLowerCase()).filter(Boolean)
  const rest = track.artists?.length
    ? track.subtitle
        .split(" • ")
        .map((part) => part.trim())
        .filter((part) => {
          if (!part || TYPE_LABELS.has(part.toLowerCase())) return false
          return !artistNames.every((name) => part.toLowerCase().includes(name))
        })
        .join(" • ")
    : ""
  const artistId = track.artists?.find((artist) => artist.id)?.id

  return (
    <div
      className={cn(
        "list-row group flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted/70 data-[active=true]:bg-muted/50",
        reorderable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-50",
        over && "ring-1 ring-ring",
      )}
      data-active={active}
      draggable={reorderable}
      onDragStart={(event) => onDragStart(event, index)}
      onDragOver={(event) => onDragOver(event, index)}
      onDrop={(event) => onDrop(event, index)}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
        onClick={() => (active ? togglePlay() : onPlay(track))}
        className="group/cover relative size-10 shrink-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {track.thumbnail ? (
          <img
            src={track.thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            width={80}
            height={80}
            draggable={false}
            className="size-full object-cover"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <MusicIcon className="size-4" />
          </span>
        )}
        <span
          className={`absolute inset-0 flex items-center justify-center bg-black/45 text-white transition-opacity ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col items-start text-left">
        <button
          type="button"
          onClick={() => onPlay(track)}
          className="w-full truncate text-left text-sm font-medium underline-offset-2 hover:underline"
        >
          {track.title}
        </button>
        <span className="w-full truncate text-xs text-muted-foreground">
          <ArtistLinks artists={track.artists} fallback={track.subtitle} />
          {rest ? ` • ${rest}` : null}
        </span>
      </div>
      <span className="hidden text-xs text-muted-foreground tabular-nums sm:block">
        {formatDuration(track.duration)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${track.title}`}
              className="opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onPlay(track)}>Play</DropdownMenuItem>
            <DropdownMenuItem onClick={() => playTrackNext(track)}>Play next</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addToQueue(track)}>
              <ListPlusIcon data-icon="inline-start" />
              Add to queue
            </DropdownMenuItem>
            {artistId ? (
              <DropdownMenuItem
                onClick={() =>
                  useView.getState().navigate({ name: "artist", id: artistId, title: track.artists?.[0]?.name })
                }
              >
                Go to artist
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => (signedIn ? onAddTo(track) : toast.error("Sign in to edit your library"))}
            >
              Add to playlist
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void (active ? toggleLike() : likeTrack(track))}>Like</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
