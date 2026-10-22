import type { ReactNode } from "react"
import { useIpcQuery } from "@/lib/query"
import { api, unwrap } from "@/lib/ipc"
import { useLibraryRevision } from "@/lib/store/library"
import { MediaGrid, MEDIA_GRID_CLASS } from "@/components/media-shelf"
import { ShelfSection } from "@/components/shelf-section"
import { PageEmpty, PageError, PageLoading } from "@/components/page-states"

type Props = {
  browseId: string
  title: string
  enabled?: boolean
  grid?: boolean
  emptyAction?: React.ReactNode
  /** Card rendered first in the grid, before the account's own items. */
  pinned?: ReactNode
}

export function BrowseView({ browseId, title, enabled = true, grid = false, emptyAction, pinned }: Props) {
  const revision = useLibraryRevision((state) => state.revision)
  const { data, error, loading, reload } = useIpcQuery(
    `browse:${browseId}:${revision}`,
    () => unwrap(api.browse({ browseId })),
    { enabled },
  )

  const pinnedGrid = pinned ? (
    <section className="flex flex-col gap-3">
      <div className={MEDIA_GRID_CLASS}>{pinned}</div>
    </section>
  ) : null

  if (loading) {
    if (!pinned) return <PageLoading />
    return (
      <div className="flex flex-col gap-8">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
        {pinnedGrid}
        <PageLoading />
      </div>
    )
  }
  if (error) {
    if (!pinned) return <PageError message={error} retry={reload} />
    return (
      <div className="flex flex-col gap-8">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
        {pinnedGrid}
        <PageError message={error} retry={reload} />
      </div>
    )
  }
  if (!data?.shelves.length) {
    if (!pinned) {
      return (
        <PageEmpty
          title="Nothing here yet"
          description="YouTube Music returned an empty page. Try again in a moment."
          action={emptyAction}
        />
      )
    }
    return (
      <div className="flex flex-col gap-8">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
        {pinnedGrid}
        <PageEmpty
          title="Nothing here yet"
          description="YouTube Music returned an empty page. Try again in a moment."
          action={emptyAction}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
      {data.shelves.map((shelf, index) => (
        <ShelfSection
          key={`${shelf.title}-${index}`}
          shelf={shelf}
          grid={grid}
          leading={index === 0 ? pinned : undefined}
        />
      ))}
    </div>
  )
}
