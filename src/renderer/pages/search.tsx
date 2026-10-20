import { useEffect, useState } from "react"
import { SearchIcon } from "lucide-react"
import { api, unwrap } from "@/lib/ipc"
import { useIpcQuery } from "@/lib/query"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ShelfSection } from "@/components/shelf-section"
import { PageError, PageLoading } from "@/components/page-states"

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export default function SearchPage({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery)
  const debounced = useDebounced(query.trim())
  const active = debounced.length >= 2
  const { data, error, loading, reload } = useIpcQuery(
    `search:${debounced}`,
    () => unwrap(api.search({ query: debounced })),
    { enabled: active, staleTime: 5 * 60 * 1000 },
  )

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Search</h1>
        <InputGroup className="max-w-xl">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Songs, albums, artists"
            aria-label="Search YouTube Music"
          />
        </InputGroup>
      </div>

      {!active ? (
        <p className="text-sm text-muted-foreground">Type at least two characters. Searches stay anonymous.</p>
      ) : loading ? (
        <PageLoading />
      ) : error ? (
        <PageError message={error} retry={reload} />
      ) : data?.shelves.length ? (
        <div className="flex flex-col gap-8">
          {data.shelves.map((shelf, index) => (
            <ShelfSection key={`${shelf.title}-${index}`} shelf={shelf} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No results for “{debounced}”.</p>
      )}
    </div>
  )
}
