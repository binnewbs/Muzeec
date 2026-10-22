import type { ReactNode } from "react"
import type { Shelf as ShelfType } from "@shared/types"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { MediaCard } from "./media-card"

export const MEDIA_GRID_CLASS = "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"

export function MediaShelf({ shelf }: { shelf: ShelfType }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-medium tracking-tight">{shelf.title}</h2>
      <ScrollArea className="group/shelf w-full">
        <div className="flex w-max gap-4 px-0.5 pb-3">
          {shelf.items.map((item) => (
            <MediaCard key={item.kind + item.id} item={item} />
          ))}
        </div>
        <ScrollBar
          orientation="horizontal"
          className="opacity-0 transition-opacity duration-200 group-hover/shelf:opacity-100 group-focus-within/shelf:opacity-100"
        />
      </ScrollArea>
    </section>
  )
}

export function MediaGrid({ shelf, leading }: { shelf: ShelfType; leading?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      {shelf.title ? <h2 className="font-heading text-lg font-medium tracking-tight">{shelf.title}</h2> : null}
      <div className={MEDIA_GRID_CLASS}>
        {leading}
        {shelf.items.map((item) => (
          <MediaCard key={item.kind + item.id} item={item} fill />
        ))}
      </div>
    </section>
  )
}
