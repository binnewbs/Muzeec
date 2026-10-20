import type { Shelf as ShelfType } from "@shared/types"
import { MediaGrid, MediaShelf } from "./media-shelf"
import { TrackList } from "./track-list"

export function ShelfSection({ shelf, grid = false }: { shelf: ShelfType; grid?: boolean }) {
  const allTracks = shelf.items.every((item) => item.kind === "track")
  if (allTracks) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-medium tracking-tight">{shelf.title}</h2>
        <TrackList items={shelf.items} layout="grid" />
      </section>
    )
  }
  return grid ? <MediaGrid shelf={shelf} /> : <MediaShelf shelf={shelf} />
}
