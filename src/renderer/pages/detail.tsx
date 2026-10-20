import { ArrowLeftIcon, PlayIcon, TrashIcon } from "lucide-react"
import type { BrowsePage } from "@shared/types"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { useIpcQuery } from "@/lib/query"
import { tracksOf } from "@/lib/media"
import { useView } from "@/lib/store/view"
import { playTracks } from "@/player/controller"
import { Button } from "@/components/ui/button"
import { ArtistLinks } from "@/components/artist-links"
import { ShelfSection } from "@/components/shelf-section"
import { TrackList } from "@/components/track-list"
import { PageError, PageLoading } from "@/components/page-states"

function allItems(page: BrowsePage) {
  return page.shelves.flatMap((shelf) => shelf.items)
}

export default function DetailPage({ id, kind, title }: { id: string; kind: "album" | "artist" | "playlist"; title?: string }) {
  const back = useView((state) => state.back)
  const browseId = id.startsWith("VL") || kind !== "playlist" ? id : `VL${id}`
  const { data, error, loading, reload } = useIpcQuery(`browse:${browseId}`, () => unwrap(api.browse({ browseId })), {
    staleTime: 2 * 60 * 1000,
  })

  if (loading) return <PageLoading />
  if (error) return <PageError message={error} retry={reload} />
  if (!data) return null

  const items = allItems(data)
  const art = data.header?.thumbnail ?? items.find((item) => item.thumbnail)?.thumbnail
  const tracks = tracksOf(items).map((track) =>
    art && !track.thumbnail ? { ...track, thumbnail: art } : track,
  )
  const trackShelves = data.shelves.filter((shelf) => shelf.items.every((item) => item.kind === "track"))
  const cardShelves = data.shelves.filter((shelf) => !shelf.items.every((item) => item.kind === "track"))

  const remove = async () => {
    if (!window.confirm("Delete this playlist from your account?")) return
    try {
      await unwrap(api.playlistDelete({ playlistId: id }))
      toast.success("Playlist deleted")
      back()
    } catch (error) {
      toast.error(errorMessage(error))
    }
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
              {data.title || title || "Untitled"}
            </h1>
            {data.header?.artists?.length ? (
              <ArtistLinks
                artists={data.header.artists}
                fallback=""
                className="text-sm text-muted-foreground"
              />
            ) : null}
            <span className="text-sm text-muted-foreground">
              {data.header?.subtitle || (tracks.length ? `${tracks.length} songs` : `${items.length} items`)}
            </span>
            {tracks.length ? (
              <div className="flex gap-2">
                <Button className="w-fit" onClick={() => void playTracks(tracks, 0)}>
                  <PlayIcon data-icon="inline-start" />
                  Play all
                </Button>
                {kind === "playlist" ? (
                  <Button variant="ghost" className="w-fit" onClick={() => void remove()}>
                    <TrashIcon data-icon="inline-start" />
                    Delete
                  </Button>
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

      {trackShelves.map((shelf, index) => (
        <section key={`tracks-${index}`} className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-medium tracking-tight">{shelf.title}</h2>
          <TrackList items={shelf.items} context={items} />
        </section>
      ))}
      {cardShelves.map((shelf, index) => (
        <ShelfSection key={`cards-${shelf.title}-${index}`} shelf={shelf} />
      ))}
      {!trackShelves.length && tracks.length > 0 ? <TrackList items={tracks} context={tracks} /> : null}
    </div>
  )
}
