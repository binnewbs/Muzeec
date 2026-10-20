import { Fragment } from "react"
import type { ArtistRef } from "@shared/types"
import { useView } from "@/lib/store/view"

type Props = {
  artists?: ArtistRef[]
  fallback: string
  className?: string
}

/** Artist names that jump to the artist page. Falls back to plain text when no ID is known. */
export function ArtistLinks({ artists, fallback, className }: Props) {
  const navigate = useView((state) => state.navigate)

  if (!artists?.length) return <span className={className}>{fallback}</span>

  return (
    <span className={className}>
      {artists.map((artist, index) => {
        const id = artist.id
        return (
          <Fragment key={id ?? `${artist.name}-${index}`}>
            {index > 0 ? <span className="text-muted-foreground/60">, </span> : null}
            {id ? (
              <button
                type="button"
                className="rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={(event) => {
                  event.stopPropagation()
                  navigate({ name: "artist", id, title: artist.name })
                }}
              >
                {artist.name}
              </button>
            ) : (
              artist.name
            )}
          </Fragment>
        )
      })}
    </span>
  )
}
