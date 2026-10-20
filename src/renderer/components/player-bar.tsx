import { useSyncExternalStore, useState } from "react"
import {
  CaptionsIcon,
  HeartIcon,
  ListMusicIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "cn"
import { formatTime } from "@/lib/media"
import { ArtistLinks } from "@/components/artist-links"
import { LyricsPanel } from "@/components/lyrics-panel"
import { usePlayer } from "@/lib/store/player"
import { useQueue } from "@/lib/store/queue"
import { useSettings } from "@/lib/store/settings"
import { engine } from "@/player/engine"
import { next, previous, seek, setVolume, toggleLike, togglePlay } from "@/player/controller"
import { playTracks } from "@/player/controller"

function usePosition(): number {
  return useSyncExternalStore(engine.subscribe, engine.getPosition, () => 0)
}

export function PlayerBar() {
  const { current, status, error, duration, liked, volume, muted } = usePlayer()
  const position = usePosition()
  const update = useSettings((state) => state.update)
  const lyricsEnabled = useSettings((state) => state.settings.lyricsEnabled)
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const display = scrubbing ?? position
  const playing = status === "playing"
  const VolumeIcon = muted || volume === 0 ? VolumeXIcon : volume < 0.5 ? Volume1Icon : Volume2Icon

  return (
    <footer className="flex shrink-0 flex-col border-t bg-background/95 backdrop-blur">
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-3">
          {current?.thumbnail ? (
            <img src={current.thumbnail} alt="" width={48} height={48} className="size-12 rounded-lg object-cover" />
          ) : (
            <div className="size-12 rounded-lg bg-muted" />
          )}
          <div className="flex min-w-0 flex-col">
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
          </div>
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
          </div>
          <div className="hidden w-full items-center gap-2 md:flex">
            <span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{formatTime(display)}</span>
            <Slider
              min={0}
              max={Math.max(duration, 1)}
              value={display}
              disabled={!current || !duration}
              onValueChange={(value) => setScrubbing(typeof value === "number" ? value : 0)}
              onValueCommitted={(value) => {
                seek(typeof value === "number" ? value : 0)
                setScrubbing(null)
              }}
              aria-label="Seek"
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
                <SheetDescription>Up next from your current selection.</SheetDescription>
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
        <Slider
          min={0}
          max={Math.max(duration, 1)}
          value={display}
          disabled={!current || !duration}
          onValueChange={(value) => setScrubbing(typeof value === "number" ? value : 0)}
          onValueCommitted={(value) => {
            seek(typeof value === "number" ? value : 0)
            setScrubbing(null)
          }}
          aria-label="Seek"
        />
        <span className="w-9 text-[11px] tabular-nums text-muted-foreground">{formatTime(duration)}</span>
      </div>
    </footer>
  )
}

function QueueList() {
  const { tracks, index } = useQueue()
  if (!tracks.length) return <p className="px-6 text-sm text-muted-foreground">Queue is empty.</p>
  return (
    <ScrollArea className="h-[calc(100vh-8rem)] px-3">
      <div className="flex flex-col gap-1">
        {tracks.map((track, i) => (
          <div
            key={`${track.videoId}-${i}`}
            className={cn(
              "flex flex-col gap-1 rounded-xl px-3 py-2 text-sm hover:bg-muted",
              i === index && "bg-muted",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="w-4 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <button
                type="button"
                onClick={() => void playTracks(tracks, i)}
                className="truncate text-left font-medium underline-offset-2 hover:underline"
              >
                {track.title}
              </button>
            </div>
            <ArtistLinks
              artists={track.artists}
              fallback={track.subtitle}
              className="truncate pl-6 text-xs text-muted-foreground"
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
