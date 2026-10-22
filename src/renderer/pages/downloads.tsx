import { useMemo, useState } from "react"
import type { DownloadProgress } from "@shared/types"
import { ArrowLeftIcon, ArrowUpDownIcon, DownloadIcon, PinIcon, PinOffIcon, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DownloadsArtwork } from "@/components/downloads-artwork"
import { Progress } from "@/components/ui/progress"
import { TrackList } from "@/components/track-list"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  DOWNLOADS_PIN_ID,
  DOWNLOADS_PIN_TITLE,
  downloadLabel,
  downloadPercent,
  downloadedToTrack,
  formatBytes,
  isDownloadsPin,
} from "@/lib/downloads"
import { formatTotalDuration } from "@/lib/media"
import { useDownloads } from "@/lib/store/downloads"
import { useSettings } from "@/lib/store/settings"
import { useView } from "@/lib/store/view"
import { playTracks } from "@/player/controller"

export default function DownloadsPage() {
  const items = useDownloads((state) => state.items)
  const active = useDownloads((state) => state.active)
  const back = useView((state) => state.back)
  const navigate = useView((state) => state.navigate)
  const pinned = useSettings((state) => state.settings.pinnedPlaylists.some((entry) => isDownloadsPin(entry.id)))
  const [sortBy, setSortBy] = useState<"downloaded" | "title">("downloaded")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const tracks = useMemo(() => items.map(downloadedToTrack), [items])
  const sortedTracks = useMemo(() => {
    const indexed = tracks.map((track, index) => ({ track, index }))
    indexed.sort((a, b) => {
      const cmp =
        sortBy === "title"
          ? a.track.title.localeCompare(b.track.title, undefined, { sensitivity: "base" })
          : a.index - b.index
      return sortDir === "asc" ? cmp : -cmp
    })
    return indexed.map((entry) => entry.track)
  }, [tracks, sortBy, sortDir])

  const totalSize = useMemo(() => items.reduce((sum, item) => sum + item.size, 0), [items])
  const totalDuration = useMemo(() => items.reduce((sum, item) => sum + (item.duration ?? 0), 0), [items])
  const activeItems = useMemo(() => {
    const unique = new Map<string, DownloadProgress>()
    for (const progress of Object.values(active)) {
      if (progress.status === "completed" || progress.status === "error") continue
      unique.set(progress.videoId, progress)
    }
    return [...unique.values()]
  }, [active])

  const playAll = () => {
    if (sortedTracks.length) void playTracks(sortedTracks, 0)
  }

  const togglePinned = () => {
    const list = useSettings.getState().settings.pinnedPlaylists
    const exists = list.some((entry) => isDownloadsPin(entry.id))
    void useSettings.getState().update({
      pinnedPlaylists: exists
        ? list.filter((entry) => !isDownloadsPin(entry.id))
        : [...list, { id: DOWNLOADS_PIN_ID, title: DOWNLOADS_PIN_TITLE, thumbnail: null }],
    })
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <Button variant="ghost" size="sm" className="w-fit" onClick={back}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          <DownloadsArtwork className="size-40 shrink-0 rounded-2xl shadow-lg sm:size-52" />
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Offline</span>
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance">Downloaded Music</h1>
            <span className="text-sm text-muted-foreground">
              {items.length
                ? `${items.length} ${items.length === 1 ? "song" : "songs"}${
                    totalDuration ? ` · ${formatTotalDuration(totalDuration)}` : ""
                  } · ${formatBytes(totalSize)}`
                : "No songs yet"}
            </span>
            <div className="flex flex-wrap gap-2">
              {tracks.length ? (
                <Button className="w-fit" onClick={playAll}>
                  <PlayIcon data-icon="inline-start" />
                  Play all
                </Button>
              ) : null}
              {tracks.length ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger render={<Button variant="ghost" className="w-fit" />}>
                    <ArrowUpDownIcon data-icon="inline-start" />
                    Sort
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={sortBy}
                        onValueChange={(value) => setSortBy(value as "downloaded" | "title")}
                      >
                        <DropdownMenuRadioItem value="downloaded">Downloaded</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="title">Title</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Order</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={sortDir}
                        onValueChange={(value) => setSortDir(value as "asc" | "desc")}
                      >
                        <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button variant="ghost" className="w-fit" onClick={togglePinned}>
                {pinned ? <PinOffIcon data-icon="inline-start" /> : <PinIcon data-icon="inline-start" />}
                {pinned ? "Unpin from sidebar" : "Pin to sidebar"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {activeItems.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-medium tracking-tight">Downloading</h2>
          <div className="flex flex-col gap-1">
            {activeItems.map((progress) => (
              <div key={progress.videoId} className="flex items-center gap-3 rounded-xl px-2 py-2">
                <DownloadsArtwork className="size-10 shrink-0 rounded-md" iconClassName="size-4" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="truncate text-sm font-medium">{progress.title}</span>
                  <Progress
                    value={progress.total ? downloadPercent(progress) : null}
                    aria-label={`Downloading ${progress.title}`}
                    className="[&_[data-slot=progress-track]]:h-1"
                  />
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{downloadLabel(progress)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tracks.length ? (
        <TrackList items={sortedTracks} context={sortedTracks} />
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
          <DownloadIcon className="size-6 text-muted-foreground" strokeWidth={1.5} />
          <div className="flex flex-col gap-1">
            <p className="font-heading text-lg font-medium">No downloads yet</p>
            <p className="text-sm text-muted-foreground">
              Use the three-dot menu on any song, or right-click the title in the player, to save it for offline
              listening.
            </p>
          </div>
          <Button onClick={() => navigate({ name: "explore" })}>Explore music</Button>
        </div>
      )}
    </div>
  )
}
