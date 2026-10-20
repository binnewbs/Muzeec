import { useCallback, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, ArrowUpDownIcon, PlayIcon, TrashIcon } from "lucide-react"
import type { BrowseChunk, BrowsePage, MediaItem, Track } from "@shared/types"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { useIpcQuery } from "@/lib/query"
import { tracksOf } from "@/lib/media"
import { useView } from "@/lib/store/view"
import { playTracks } from "@/player/controller"
import { Button } from "@/components/ui/button"
import { ArtistLinks } from "@/components/artist-links"
import { ShelfSection } from "@/components/shelf-section"
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
import { TrackList } from "@/components/track-list"
import { PageError, PageLoading } from "@/components/page-states"

function allItems(page: BrowsePage) {
  return page.shelves.flatMap((shelf) => shelf.items)
}

function isTrackShelf(shelf: BrowsePage["shelves"][number]) {
  return shelf.items.every((item) => item.kind === "track")
}

function isBrowseId(value: string | null | undefined) {
  return /^(VL|MPRE|UC|RDCLAK|FEmusic_)/.test(value ?? "")
}

type ShelfEntry = { shelf: BrowsePage["shelves"][number]; index: number }

export default function DetailPage({ id, kind, title }: { id: string; kind: "album" | "artist" | "playlist"; title?: string }) {
  const back = useView((state) => state.back)
  const browseId = id.startsWith("VL") || kind !== "playlist" ? id : `VL${id}`
  const isPlaylist = kind === "playlist"
  const { data, error, loading, reload, setData } = useIpcQuery(
    `browse:${browseId}`,
    () => unwrap(api.browse({ browseId })),
    { staleTime: 2 * 60 * 1000 },
  )
  const [sortBy, setSortBy] = useState<"added" | "title">("added")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  const loadingMoreRef = useRef(false)
  const loadingAllRef = useRef(false)
  const cursorRef = useRef<string | null>(null)
  cursorRef.current = data?.continuation ?? null

  const appendChunk = useCallback(
    (chunkItems: MediaItem[], cursor: string | null) => {
      setData((previous) => {
        if (!previous) return previous
        const targetIndex =
          previous.trackListIndex ??
          previous.shelves.findIndex((shelf) => shelf.items.length > 0 && isTrackShelf(shelf))
        if (targetIndex < 0 || targetIndex >= previous.shelves.length) return { ...previous, continuation: cursor }
        const target = previous.shelves[targetIndex]
        const seen = new Set(target.items.map((item) => `${item.kind}:${item.id}`))
        const merged = [...target.items]
        for (const item of chunkItems) {
          const key = `${item.kind}:${item.id}`
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(item)
        }
        const shelves = previous.shelves.map((shelf, index) =>
          index === targetIndex ? { ...shelf, items: merged } : shelf,
        )
        return { ...previous, shelves, continuation: cursor }
      })
    },
    [setData],
  )

  const loadMore = useCallback((): void => {
    void (async () => {
      if (loadingMoreRef.current) return
      const cursor = cursorRef.current
      if (!cursor) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      try {
        const chunk: BrowseChunk = await unwrap<BrowseChunk>(api.browseMore({ browseId, cursor }))
        appendChunk(chunk.items, chunk.continuation)
      } catch (loadError) {
        toast.error(errorMessage(loadError))
      } finally {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    })()
  }, [browseId, appendChunk])

  const items = useMemo(() => (data ? allItems(data) : []), [data])

  const sortTracks = useCallback(
    (list: MediaItem[]) => {
      if (!isPlaylist) return list
      const indexed = list.map((item, index) => ({ item, index }))
      indexed.sort((a, b) => {
        const cmp =
          sortBy === "title"
            ? a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base" })
            : a.index - b.index
        return sortDir === "asc" ? cmp : -cmp
      })
      return indexed.map((entry) => entry.item)
    },
    [isPlaylist, sortBy, sortDir],
  )

  const art = data?.header?.thumbnail ?? items.find((item) => item.thumbnail)?.thumbnail
  const sortedItems = useMemo(() => sortTracks(items), [sortTracks, items])
  const tracks = useMemo(
    () => tracksOf(sortedItems).map((track) => (art && !track.thumbnail ? { ...track, thumbnail: art } : track)),
    [sortedItems, art],
  )
  const trackShelves = useMemo<ShelfEntry[]>(
    () =>
      (data?.shelves ?? [])
        .map((shelf, index) => ({ shelf, index }))
        .filter((entry) => isTrackShelf(entry.shelf)),
    [data],
  )
  const cardShelves = useMemo<ShelfEntry[]>(
    () =>
      (data?.shelves ?? [])
        .map((shelf, index) => ({ shelf, index }))
        .filter((entry) => !isTrackShelf(entry.shelf)),
    [data],
  )
  const targetShelfIndex = useMemo(() => {
    if (!data) return -1
    return (
      data.trackListIndex ??
      data.shelves.findIndex((shelf) => shelf.items.length > 0 && isTrackShelf(shelf))
    )
  }, [data])

  if (loading) return <PageLoading />
  if (error) return <PageError message={error} retry={reload} />
  if (!data) return null

  const safeTitle = isBrowseId(title) ? "" : (title || "")
  const displayTitle = isBrowseId(data.title) ? (safeTitle || "Untitled") : (data.title || safeTitle || "Untitled")
  const hasContinuation = Boolean(data.continuation)

  const remove = async () => {
    if (!window.confirm("Delete this playlist from your account?")) return
    try {
      await unwrap(api.playlistDelete({ playlistId: id }))
      toast.success("Playlist deleted")
      back()
    } catch (removeError) {
      toast.error(errorMessage(removeError))
    }
  }

  /** Fetches every remaining page, then starts playback with the complete list. */
  const playAll = (): void => {
    void (async () => {
      if (loadingAllRef.current) return
      const startCursor = cursorRef.current
      if (!startCursor) {
        void playTracks(tracks, 0)
        return
      }
      loadingAllRef.current = true
      setLoadingAll(true)
      try {
        const collected: Track[] = [...tracks]
        const seen = new Set(collected.map((track) => track.videoId))
        let cursor: string | null = startCursor
        let guard = 0
        while (cursor && guard++ < 200) {
          const chunk: BrowseChunk = await unwrap<BrowseChunk>(api.browseMore({ browseId, cursor }))
          cursor = chunk.continuation
          if (!chunk.items.length) continue
          appendChunk(chunk.items, cursor)
          for (const track of tracksOf(chunk.items)) {
            if (seen.has(track.videoId)) continue
            seen.add(track.videoId)
            collected.push(track)
          }
        }
        if (collected.length) void playTracks(collected, 0)
      } catch (playError) {
        toast.error(errorMessage(playError))
      } finally {
        loadingAllRef.current = false
        setLoadingAll(false)
      }
    })()
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <Button variant="ghost" size="sm" className="w-fit" onClick={back}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          {art ? (
            <img
              src={art}
              alt=""
              width={208}
              height={208}
              className="size-40 rounded-2xl object-cover shadow-lg sm:size-52"
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{kind}</span>
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance">
              {displayTitle}
            </h1>
            {data.header?.artists?.length ? (
              <ArtistLinks
                artists={data.header.artists}
                fallback=""
                className="text-sm text-muted-foreground"
              />
            ) : null}
            <span className="text-sm text-muted-foreground">
              {data.header?.subtitle ||
                (tracks.length ? `${tracks.length}${hasContinuation ? "+" : ""} songs` : `${items.length} items`)}
            </span>
            {tracks.length ? (
              <div className="flex flex-wrap gap-2">
                <Button className="w-fit" disabled={loadingAll} onClick={playAll}>
                  <PlayIcon data-icon="inline-start" />
                  {loadingAll ? "Loading…" : "Play all"}
                </Button>
                {kind === "playlist" ? (
                  <>
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
                            onValueChange={(value) => setSortBy(value as "added" | "title")}
                          >
                            <DropdownMenuRadioItem value="added">Date added</DropdownMenuRadioItem>
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
                    <Button variant="ghost" className="w-fit" onClick={() => void remove()}>
                      <TrashIcon data-icon="inline-start" />
                      Delete
                    </Button>
                  </>
                ) : null}
              </div>
            ) : kind === "playlist" ? (
              <Button variant="ghost" className="w-fit" onClick={() => void remove()}>
                <TrashIcon data-icon="inline-start" />
                Delete playlist
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {trackShelves.map(({ shelf, index }) => {
        const shelfItems = sortTracks(shelf.items)
        const isMain = index === targetShelfIndex
        return (
          <section key={`tracks-${index}`} className="flex flex-col gap-2">
            <h2 className="font-heading text-lg font-medium tracking-tight">{shelf.title}</h2>
            <TrackList
              items={shelfItems}
              context={shelfItems}
              hasMore={isMain && hasContinuation}
              loadingMore={isMain && loadingMore}
              onLoadMore={isMain ? loadMore : undefined}
            />
          </section>
        )
      })}
      {cardShelves.map(({ shelf, index }) => (
        <ShelfSection key={`cards-${shelf.title}-${index}`} shelf={shelf} />
      ))}
      {!trackShelves.length && tracks.length > 0 ? (
        <TrackList
          items={tracks}
          context={tracks}
          hasMore={hasContinuation}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      ) : null}
    </div>
  )
}
