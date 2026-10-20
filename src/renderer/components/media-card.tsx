import type { MediaItem } from "@shared/types"
import { PlayIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { useView } from "@/lib/store/view"
import { playTrack } from "@/player/controller"
import { toTrack } from "@/lib/media"

type Props = { item: MediaItem; fill?: boolean }

export function MediaCard({ item, fill = false }: Props) {
  const navigate = useView((state) => state.navigate)

  const activate = () => {
    if (item.kind === "track") {
      void playTrack(toTrack(item))
      return
    }
    if (item.kind === "album") navigate({ name: "album", id: item.id, title: item.title })
    else if (item.kind === "playlist") navigate({ name: "playlist", id: item.id, title: item.title })
    else navigate({ name: "artist", id: item.id, title: item.title })
  }

  return (
    <button
      type="button"
      onClick={activate}
      className={`group flex flex-col rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        fill ? "w-full" : "w-40 shrink-0"
      }`}
    >
      <Card className="w-full gap-0 overflow-hidden p-0 transition-colors group-hover:bg-accent">
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
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
            <div className="size-full bg-muted" />
          )}
          <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/50 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
              <PlayIcon className="size-4" />
            </span>
          </div>
        </div>
        <CardContent className="flex flex-col gap-0.5 p-3">
          <span className="truncate text-sm font-medium">
            {/^(VL|MPRE|UC|RDCLAK|FEmusic_)/.test(item.title) ? "Untitled" : item.title}
          </span>
          <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>
        </CardContent>
      </Card>
    </button>
  )
}
