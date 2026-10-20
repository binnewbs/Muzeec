import { useState } from "react"
import type { MediaItem, Track } from "@shared/types"
import { MoreHorizontalIcon, MusicIcon, PauseIcon, PlayIcon } from "lucide-react"
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
import { usePlayer } from "@/lib/store/player"
import { playTracks, playTrack, playTrackNext, likeTrack, toggleLike, togglePlay } from "@/player/controller"

type Props = {
  items: MediaItem[]
  context?: MediaItem[]
  layout?: "list" | "grid"
}

export function TrackList({ items, context = items, layout = "list" }: Props) {
  const currentId = usePlayer((state) => state.current?.videoId)
  const playing = usePlayer((state) => state.status === "playing")
  const signedIn = useAuth((state) => state.state.signedIn)
  const navigate = useView((state) => state.navigate)
  const [addTo, setAddTo] = useState<Track | null>(null)
  const tracks = context.filter((item) => item.kind === "track").map(toTrack)

  const play = (track: Track) => {
    const index = tracks.findIndex((entry) => entry.videoId === track.videoId)
    if (tracks.length > 1 && index >= 0) void playTracks(tracks, index)
    else void playTrack(track)
  }

  return (
    <div className={layout === "grid" ? "grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col"}>
      {items.map((item) => {
        const track = toTrack(item)
        const active = currentId === track.videoId
        const artistCount = track.artists?.length ?? 0
        const rest = artistCount ? track.subtitle.split(" • ").slice(1).join(" • ") : ""
        const artistId = track.artists?.find((artist) => artist.id)?.id
        return (
          <div
            key={track.videoId}
            className="group flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted/70 data-[active=true]:bg-muted/50"
            data-active={active}
          >
            <button
              type="button"
              aria-label={active && playing ? `Pause ${track.title}` : `Play ${track.title}`}
              onClick={() => (active ? togglePlay() : play(track))}
              className="group/cover relative size-10 shrink-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {track.thumbnail ? (
                <img
                  src={track.thumbnail}
                  alt=""
                  loading="lazy"
                  width={80}
                  height={80}
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
                {active && playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
              </span>
            </button>
            <div className="flex min-w-0 flex-1 flex-col items-start text-left">
              <button
                type="button"
                onClick={() => play(track)}
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
                  <DropdownMenuItem onClick={() => play(track)}>Play</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => playTrackNext(track)}>Play next</DropdownMenuItem>
                  {artistId ? (
                    <DropdownMenuItem
                      onClick={() => navigate({ name: "artist", id: artistId, title: track.artists?.[0]?.name })}
                    >
                      Go to artist
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    onClick={() => (signedIn ? setAddTo(track) : toast.error("Sign in to edit your library"))}
                  >
                    Add to playlist
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void (currentId === track.videoId ? toggleLike() : likeTrack(track))}
                  >
                    Like
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })}
      <AddToPlaylistDialog
        videoId={addTo?.videoId ?? ""}
        title={addTo?.title ?? ""}
        open={addTo !== null}
        onOpenChange={(open) => !open && setAddTo(null)}
      />
    </div>
  )
}
