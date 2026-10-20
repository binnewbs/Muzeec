import { useIpcQuery } from "@/lib/query"
import { api, unwrap } from "@/lib/ipc"
import { useLibraryRevision } from "@/lib/store/library"
import { ShelfSection } from "@/components/shelf-section"
import { PageEmpty, PageError, PageLoading } from "@/components/page-states"

type Props = {
  browseId: string
  title: string
  enabled?: boolean
  grid?: boolean
  emptyAction?: React.ReactNode
}

export function BrowseView({ browseId, title, enabled = true, grid = false, emptyAction }: Props) {
  const revision = useLibraryRevision((state) => state.revision)
  const { data, error, loading, reload } = useIpcQuery(
    `browse:${browseId}:${revision}`,
    () => unwrap(api.browse({ browseId })),
    { enabled },
  )

  if (loading) return <PageLoading />
  if (error) return <PageError message={error} retry={reload} />
  if (!data?.shelves.length)
    return (
      <PageEmpty
        title="Nothing here yet"
        description="YouTube Music returned an empty page. Try again in a moment."
        action={emptyAction}
      />
    )

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
      {data.shelves.map((shelf, index) => (
        <ShelfSection key={`${shelf.title}-${index}`} shelf={shelf} grid={grid} />
      ))}
    </div>
  )
}
