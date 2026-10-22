import { useMemo } from "react"
import type { DownloadProgress, Track } from "@shared/types"
import {
  CaptionsIcon,
  CompassIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PageEmpty } from "@/components/page-states"
import { Progress } from "@/components/ui/progress"
import { downloadLabel, downloadPercent, formatBytes, downloadedToTrack } from "@/lib/downloads"
import { formatDuration } from "@/lib/media"
import { useDownloads } from "@/lib/store/downloads"
import { useView } from "@/lib/store/view"
import { playTracks } from "@/player/controller"

export default function DownloadsPage() {
  const items = useDownloads((state) => state.items)
  const active = useDownloads((state) => state.active)
  const loading = useDownloads((state) => state.loading)
  const remove = useDownloads((state) => state.remove)
  const navigate = useView((state) => state.navigate)

  const tracks = useMemo(() => items.map(downloadedToTrack), [items])
  const activeItems = useMemo(() => {
    const unique = new Map<string, DownloadProgress>()
    for (const progress of Object.values(active)) {
      if (progress.status === "completed" || progress.status === "error") continue
      unique.set(progress.videoId, progress)
    }
    return [...unique.values()]
  }, [active])
  const totalSize = useMemo(() => items.reduce((sum, item) => sum + item.size, 0), [items])

  const play = (track: Track) => {
    const index = tracks.findIndex((entry) => entry.videoId === track.videoId)
    void playTracks(tracks, Math.max(0, index))
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Downloaded Music</h1>
          <p className="text-sm text-muted-foreground">
            {items.length
              ? `${items.length} ${items.length === 1 ? "song" : "songs"} · ${formatBytes(totalSize)}`
              : "Listen without a connection"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate({ name: "explore" })}>
          <CompassIcon data-icon="inline-start" />
          Find more music
        </Button>
      </header>

      {activeItems.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-lg font-medium tracking-tight">In progress</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {activeItems.map((progress) => (
              <Card key={progress.videoId} className="gap-0 p-3">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">{progress.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{downloadLabel(progress)}</span>
                  </div>
                  <Progress
                    value={progress.total ? downloadPercent(progress) : null}
                    aria-label={`Downloading ${progress.title}`}
                    className="[&_[data-slot=progress-track]]:h-1.5"
                  />
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? null : items.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => {
            const track = downloadedToTrack(item)
            return (
              <Card key={item.videoId} className="group gap-0 overflow-hidden p-0 transition-colors hover:bg-accent">
                <div className="relative aspect-square w-full overflow-hidden bg-muted">
                  <button
                    type="button"
                    onClick={() => play(track)}
                    aria-label={`Play ${item.title}`}
                    className="size-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.thumbnail ? (
                      <img
                        src={item.thumbnail}
                        alt=""
                        loading="lazy"
                        width={320}
                        height={320}
                        className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center text-muted-foreground">
                        <DownloadIcon className="size-8" />
                      </span>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
                      <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                        <PlayIcon className="size-4" />
                      </span>
                    </span>
                  </button>
                  {item.hasLyrics ? (
                    <span
                      className="absolute top-2 left-2 rounded-full bg-black/55 p-1.5 text-white"
                      title="Lyrics saved for offline listening"
                    >
                      <CaptionsIcon className="size-3.5" />
                    </span>
                  ) : null}
                </div>
                <CardContent className="flex items-center gap-1 p-2.5">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.subtitle}
                      {item.duration ? ` · ${formatDuration(item.duration)}` : ""}
                    </span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${item.title}`}
                          className="opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
                        />
                      }
                    >
                      <MoreHorizontalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => play(track)}>
                          <PlayIcon />
                          Play
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void remove(item.videoId)}>
                          <Trash2Icon />
                          Remove download
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : (
        <PageEmpty
          title="No downloads yet"
          description="Use the three-dot menu on any song, or right-click the title in the player, to save it for offline listening."
          action={<Button onClick={() => navigate({ name: "explore" })}>Explore music</Button>}
        />
      )}
    </div>
  )
}
