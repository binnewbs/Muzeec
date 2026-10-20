import { useEffect, useState } from "react"
import { ArrowLeftIcon, CheckIcon, PlayIcon, UserPlusIcon } from "lucide-react"
import { toast } from "sonner"
import type { BrowsePage } from "@shared/types"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { useIpcQuery } from "@/lib/query"
import { tracksOf } from "@/lib/media"
import { useView } from "@/lib/store/view"
import { useAuth } from "@/lib/store/auth"
import { playTracks } from "@/player/controller"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShelfSection } from "@/components/shelf-section"
import { TrackList } from "@/components/track-list"
import { PageError, PageLoading } from "@/components/page-states"

function allItems(page: BrowsePage) {
  return page.shelves.flatMap((shelf) => shelf.items)
}

export default function ArtistPage({ id, title }: { id: string; title?: string }) {
  const back = useView((state) => state.back)
  const signedIn = useAuth((state) => state.state.signedIn)
  const { data, error, loading, reload } = useIpcQuery(`browse:${id}`, () => unwrap(api.browse({ browseId: id })), {
    staleTime: 5 * 60 * 1000,
  })
  const header = data?.header ?? null
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (header) setSubscribed(header.subscribed)
  }, [header])

  if (loading) return <PageLoading />
  if (error) return <PageError message={error} retry={reload} />
  if (!data) return null

  const items = allItems(data)
  const tracks = tracksOf(items)
  const banner = header?.thumbnail ?? items.find((item) => item.thumbnail)?.thumbnail
  const trackShelves = data.shelves.filter((shelf) => shelf.items.every((item) => item.kind === "track"))
  const cardShelves = data.shelves.filter((shelf) => !shelf.items.every((item) => item.kind === "track"))

  const toggleSubscription = async () => {
    if (!signedIn) {
      toast.error("Sign in to follow artists")
      return
    }
    if (!header?.channelId) {
      toast.error("This artist cannot be followed")
      return
    }
    setBusy(true)
    try {
      await unwrap(
        api.subscribe({
          channelId: header.channelId,
          subscribed,
          params: header.subscriptionParams,
        }),
      )
      setSubscribed((value) => !value)
      toast.success(subscribed ? `Unfollowed ${header.title}` : `Following ${header.title}`)
      reload()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <Button variant="ghost" size="sm" className="w-fit" onClick={back}>
        <ArrowLeftIcon data-icon="inline-start" />
        Back
      </Button>

      <section className="relative isolate overflow-hidden rounded-3xl border bg-card">
        {banner ? (
          <img src={banner} alt="" className="absolute inset-0 size-full object-cover opacity-40" />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-card via-card/70 to-card/10" />
        <div className="relative flex flex-col gap-4 p-6 sm:p-8">
          <Badge variant="secondary" className="w-fit">
            Artist
          </Badge>
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {header?.title || data.title || title || "Unknown artist"}
            </h1>
            {header?.subtitle ? (
              <span className="text-sm text-muted-foreground">{header.subtitle}</span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {tracks.length ? (
              <Button onClick={() => void playTracks(tracks, 0)}>
                <PlayIcon data-icon="inline-start" />
                Play all
              </Button>
            ) : null}
            <Button variant={subscribed ? "outline" : "secondary"} disabled={busy} onClick={() => void toggleSubscription()}>
              {subscribed ? <CheckIcon data-icon="inline-start" /> : <UserPlusIcon data-icon="inline-start" />}
              {subscribed ? "Following" : "Follow"}
            </Button>
          </div>
          {header?.description ? (
            <div className="flex max-w-3xl flex-col gap-1">
              <p className={expanded ? "text-sm leading-relaxed text-muted-foreground" : "line-clamp-3 text-sm leading-relaxed text-muted-foreground"}>
                {header.description}
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto w-fit p-0 text-xs"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : "Read more"}
              </Button>
            </div>
          ) : null}
        </div>
      </section>

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
