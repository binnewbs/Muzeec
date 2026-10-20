import { useCallback, useEffect, useState } from "react"
import { HistoryIcon, SearchIcon, XIcon } from "lucide-react"
import { addSearchHistory } from "@shared/search-history"
import { api, unwrap } from "@/lib/ipc"
import { useIpcQuery } from "@/lib/query"
import { useSettings } from "@/lib/store/settings"
import { Button } from "@/components/ui/button"
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
  const history = useSettings((state) => state.settings.searchHistory)
  const updateSettings = useSettings((state) => state.update)
  const { data, error, loading, reload } = useIpcQuery(
    `search:${debounced}`,
    () => unwrap(api.search({ query: debounced })),
    { enabled: active, staleTime: 5 * 60 * 1000 },
  )

  const remember = useCallback(
    (value: string) => {
      const current = useSettings.getState().settings.searchHistory
      const next = addSearchHistory(current, value)
      if (next.length === current.length && next.every((term, index) => term === current[index])) return
      void updateSettings({ searchHistory: next })
    },
    [updateSettings],
  )

  // Live search has no submit button, so save once the query has been stable for a moment.
  useEffect(() => {
    if (!active || !data || loading) return
    const timer = setTimeout(() => remember(debounced), 1200)
    return () => clearTimeout(timer)
  }, [active, data, loading, debounced, remember])

  const remove = (term: string) => {
    void updateSettings({ searchHistory: history.filter((entry) => entry !== term) })
  }

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
            onBlur={() => remember(query)}
            onKeyDown={(event) => {
              if (event.key === "Enter") remember(query)
            }}
            placeholder="Songs, albums, artists"
            aria-label="Search YouTube Music"
          />
        </InputGroup>
      </div>

      {!active ? (
        <div className="flex max-w-xl flex-col gap-6">
          {history.length ? (
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-heading text-lg font-medium tracking-tight">Recent searches</h2>
                <Button variant="ghost" size="sm" onClick={() => void updateSettings({ searchHistory: [] })}>
                  Clear
                </Button>
              </div>
              <div className="flex flex-col overflow-hidden rounded-2xl border">
                {history.map((term) => (
                  <div
                    key={term}
                    className="group flex items-center gap-2 border-b py-1 pl-3 last:border-b-0 hover:bg-muted/50"
                  >
                    <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(term)
                        remember(term)
                      }}
                      className="min-w-0 flex-1 truncate py-1.5 text-left text-sm underline-offset-2 hover:underline"
                    >
                      {term}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`Remove ${term} from search history`}
                      onClick={() => remove(term)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          <p className="text-sm text-muted-foreground">Type at least two characters. Searches stay anonymous.</p>
        </div>
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
