import { useSyncExternalStore, useEffect, useState } from "react"
import type { Track } from "@shared/types"
import { toast } from "sonner"
import {
  CaptionsIcon,
  DownloadIcon,
  GripVerticalIcon,
  HeartIcon,
  ListMusicIcon,
  ListPlusIcon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Trash2Icon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "cn"
import { formatTime } from "@/lib/media"
import { useIncrementalList } from "@/lib/incremental"
import { ArtistLinks } from "@/components/artist-links"
import { AddToPlaylistDialog } from "@/components/add-to-playlist"
import { LyricsPanel } from "@/components/lyrics-panel"
import { SeekBar } from "@/components/seek-bar"
import { useAuth } from "@/lib/store/auth"
import { useDownloads } from "@/lib/store/downloads"
import { downloadFor, downloadLabel } from "@/lib/downloads"
import { usePlayer } from "@/lib/store/player"
import { useQueue } from "@/lib/store/queue"
import { useSettings } from "@/lib/store/settings"
import { engine } from "@/player/engine"
import {
  next,
  previous,
  seek,
  setVolume,
  toggleLike,
  togglePlay,
  playFromQueue,
  playAutoplayTrack,
  previewAutoplay,
  cycleRepeat,
  toggleShuffle,
} from "@/player/controller"

function usePosition(): number {
  return useSyncExternalStore(engine.subscribe, engine.getPosition, () => 0)
}

export function PlayerBar() {
  const { current, status, error, duration, liked, volume, muted } = usePlayer()
  const shuffle = useQueue((state) => state.shuffle)
  const repeat = useQueue((state) => state.repeat)
  const position = usePosition()
  const update = useSettings((state) => state.update)
  const lyricsEnabled = useSettings((state) => state.settings.lyricsEnabled)
  const signedIn = useAuth((state) => state.state.signedIn)
  const downloads = useDownloads((state) => state.items)
  const activeDownloads = useDownloads((state) => state.active)
  const downloaded = current ? downloadFor(downloads, current.videoId) : null
  const downloadProgress = current ? activeDownloads[current.videoId] : undefined
  const downloading = Boolean(downloadProgress && downloadProgress.status !== "error")
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const [addTo, setAddTo] = useState<Track | null>(null)
  const display = scrubbing ?? position
  const playing = status === "playing"
  const VolumeIcon = muted || volume === 0 ? VolumeXIcon : volume < 0.5 ? Volume1Icon : Volume2Icon

  return (
    <footer className="flex shrink-0 flex-col border-t bg-background">
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-3">
          {current?.thumbnail ? (
            <img src={current.thumbnail} alt="" width={48} height={48} className="size-12 rounded-lg object-cover" />
          ) : (
            <div className="size-12 rounded-lg bg-muted" />
          )}
          <ContextMenu>
            <ContextMenuTrigger className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{current?.title ?? "Nothing playing"}</span>
              <span className={cn("truncate text-xs", error ? "text-destructive" : "text-muted-foreground")}>
                {error ? (
                  error
                ) : current ? (
                  <ArtistLinks artists={current.artists} fallback={current.subtitle} />
                ) : (
                  "Pick a song to start"
                )}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuGroup>
                <ContextMenuItem
                  disabled={!current}
                  onClick={() => {
                    if (!current) return
                    if (!signedIn) {
                      toast.error("Sign in to edit your library")
                      return
                    }
                    setAddTo(current)
                  }}
                >
                  <ListPlusIcon />
                  Add to playlist
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!current || downloading}
                  onClick={() => {
                    if (!current) return
                    if (downloaded) void useDownloads.getState().remove(downloaded.videoId)
                    else void useDownloads.getState().start(current)
                  }}
                >
                  {downloaded ? <Trash2Icon /> : <DownloadIcon />}
                  {downloaded
                    ? "Remove download"
                    : downloadProgress
                      ? downloadLabel(downloadProgress)
                      : "Download"}
                </ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={liked ? "Remove from liked songs" : "Like song"}
            disabled={!current}
            onClick={() => void toggleLike()}
          >
            <HeartIcon className={cn(liked && "fill-current text-primary")} />
          </Button>
        </div>

        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={shuffle ? "Turn shuffle off" : "Turn shuffle on"}
              aria-pressed={shuffle}
              className={cn(shuffle ? "text-primary" : "text-muted-foreground/60")}
              onClick={toggleShuffle}
            >
              <ShuffleIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Previous track" onClick={previous}>
              <SkipBackIcon />
            </Button>
            <Button
              size="icon"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!current || status === "loading"}
              onClick={togglePlay}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Next track" onClick={next}>
              <SkipForwardIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={repeat === "one" ? "Loop one" : repeat === "all" ? "Loop all" : "Loop off"}
              aria-pressed={repeat !== "off"}
              className={cn(repeat !== "off" ? "text-primary" : "text-muted-foreground/60")}
              onClick={cycleRepeat}
            >
              {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
            </Button>
          </div>
          <div className="hidden w-full items-center gap-2 md:flex">
            <span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{formatTime(display)}</span>
            <SeekBar
              value={display}
              max={duration}
              disabled={!current || !duration}
              onScrub={setScrubbing}
              onCommit={(value) => {
                seek(value)
                setScrubbing(null)
              }}
              onCancel={() => setScrubbing(null)}
            />
            <span className="w-10 text-[11px] tabular-nums text-muted-foreground">{formatTime(duration)}</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-1">
          {lyricsEnabled ? (
            <Sheet>
              <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Show lyrics" />}>
                <CaptionsIcon />
              </SheetTrigger>
              <SheetContent side="right" className="sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>Lyrics</SheetTitle>
                  <SheetDescription>{current?.title ?? "Play a song to see its lyrics."}</SheetDescription>
                </SheetHeader>
                <LyricsPanel />
              </SheetContent>
            </Sheet>
          ) : null}
          <Sheet>
            <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open queue" />}>
              <ListMusicIcon />
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Queue</SheetTitle>
                <SheetDescription>Up next from your queue, followed by autoplay preview.</SheetDescription>
              </SheetHeader>
              <QueueList />
            </SheetContent>
          </Sheet>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => setVolume(volume, !muted)}
          >
            <VolumeIcon />
          </Button>
          <Slider
            className="hidden w-24 lg:block"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onValueChange={(value) => setVolume(typeof value === "number" ? value : 0, false)}
            onValueCommitted={(value) => void update({ volume: typeof value === "number" ? value : 0 })}
            aria-label="Volume"
          />
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 pb-2 md:hidden">
        <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{formatTime(display)}</span>
        <SeekBar
          value={display}
          max={duration}
          disabled={!current || !duration}
          onScrub={setScrubbing}
          onCommit={(value) => {
            seek(value)
            setScrubbing(null)
          }}
          onCancel={() => setScrubbing(null)}
        />
        <span className="w-9 text-[11px] tabular-nums text-muted-foreground">{formatTime(duration)}</span>
      </div>
      <AddToPlaylistDialog
        videoId={addTo?.videoId ?? ""}
        title={addTo?.title ?? ""}
        open={addTo !== null}
        onOpenChange={(open) => !open && setAddTo(null)}
      />
    </footer>
  )
}

function QueueList() {
  const { tracks, autoplay, autoplaySeed, autoplayLoading, move } = useQueue()
  const current = usePlayer((state) => state.current)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const queueWindow = useIncrementalList(tracks.length)

  const seed = tracks.at(-1) ?? current
  const seedId = seed?.videoId ?? null
  useEffect(() => {
    void previewAutoplay()
  }, [seedId])

  const seedIndex = seedId ? autoplay.findIndex((track) => track.videoId === seedId) : -1
  const upcoming =
    seedId && seedIndex >= 0
      ? autoplay.slice(seedIndex + 1)
      : autoplay.filter((track) => track.videoId !== seedId)
  const loading = autoplayLoading && autoplaySeed === seedId
  const afterQueue = tracks.length > 0
  const autoplayWindow = useIncrementalList(upcoming.length)

  return (
    <ScrollArea className="h-[calc(100vh-8rem)] px-3">
      <div className="flex flex-col gap-5 pb-4">
        <section className="flex flex-col gap-1">
          <h3 className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">Up next</h3>
          {tracks.length ? (
            tracks.slice(0, queueWindow.visibleCount).map((track, i) => (
              <div
                key={`${track.videoId}-${i}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move"
                  setDragging(i)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = "move"
                  setOver(i)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging !== null) move(dragging, i)
                  setDragging(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                className={cn(
                  "flex cursor-grab items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-muted active:cursor-grabbing",
                  dragging === i && "opacity-50",
                  over === i && dragging !== i && "ring-1 ring-ring",
                )}
              >
                <button
                  type="button"
                  aria-label={`Reorder ${track.title}`}
                  title="Drag, or use arrow keys to reorder"
                  className="shrink-0 rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp") {
                      event.preventDefault()
                      move(i, i - 1)
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault()
                      move(i, i + 1)
                    }
                  }}
                >
                  <GripVerticalIcon aria-hidden />
                </button>
                <span className="w-4 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <button
                  type="button"
                  onClick={() => playFromQueue(i)}
                  className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline"
                >
                  {track.title}
                </button>
                <span className="max-w-40 truncate text-xs text-muted-foreground">
                  <ArtistLinks artists={track.artists} fallback={track.subtitle} />
                </span>
              </div>
            ))
          ) : (
            <p className="px-3 text-sm text-muted-foreground">No songs added. Autoplay continues when this song ends.</p>
          )}
          {queueWindow.hasMore ? (
            <div ref={queueWindow.sentinelRef} className="flex justify-center py-1">
              <Button variant="ghost" size="sm" onClick={queueWindow.showMore}>
                Show more ({tracks.length - queueWindow.visibleCount})
              </Button>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {afterQueue ? "Autoplay after queue" : "Autoplay"}
          </h3>
          {loading ? (
            <p className="px-3 text-sm text-muted-foreground">Loading similar songs…</p>
          ) : upcoming.length ? (
            upcoming.slice(0, autoplayWindow.visibleCount).map((track, i) => (
              <div key={`${track.videoId}-${i}`} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-muted">
                <span className="w-4 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <button
                  type="button"
                  onClick={() => playAutoplayTrack(track)}
                  className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline"
                >
                  {track.title}
                </button>
                <span className="max-w-40 truncate text-xs text-muted-foreground">
                  <ArtistLinks artists={track.artists} fallback={track.subtitle} />
                </span>
              </div>
            ))
          ) : (
            <p className="px-3 text-sm text-muted-foreground">Autoplay preview unavailable.</p>
          )}
          {autoplayWindow.hasMore ? (
            <div ref={autoplayWindow.sentinelRef} className="flex justify-center py-1">
              <Button variant="ghost" size="sm" onClick={autoplayWindow.showMore}>
                Show more ({upcoming.length - autoplayWindow.visibleCount})
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </ScrollArea>
  )
}
