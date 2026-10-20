import { useCallback, useEffect, useRef, useState } from "react"

type CacheEntry = { data: unknown; at: number }

/** Keeps the largest pages (playlists) from growing the renderer cache forever. */
const MAX_ENTRIES = 60

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()

function store(key: string, data: unknown, at = Date.now()): void {
  cache.delete(key)
  cache.set(key, { data, at })
  while (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!)
  }
}

function cached(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  // Refresh recency without updating `at` (that controls freshness).
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

export type QueryState<T> = {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
  /** Update data locally (pagination, optimistic edits) and keep the cache in sync. */
  setData: (updater: T | ((previous: T) => T)) => void
}

/** Tiny stale-while-revalidate query layer: in-memory cache + in-flight dedupe (PLAN §6). */
export function useIpcQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  { enabled = true, staleTime = 2 * 60 * 1000 }: { enabled?: boolean; staleTime?: number } = {},
): QueryState<T> {
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const [data, setDataState] = useState<T | null>(() => {
    const hit = cached(key)
    return hit && Date.now() - hit.at < staleTime ? (hit.data as T) : null
  })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled && data === null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const hit = cached(key)
    if (hit && Date.now() - hit.at < staleTime && nonce === 0) {
      setDataState(hit.data as T)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const promise = (inflight.get(key) ?? fetcherRef.current()) as Promise<T>
    inflight.set(key, promise)
    promise
      .then((value) => {
        store(key, value)
        if (!cancelled) setDataState(value)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        inflight.delete(key)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, nonce])

  const setData = useCallback(
    (updater: T | ((previous: T) => T)) => {
      setDataState((previous) => {
        if (previous === null) return previous
        const next = typeof updater === "function" ? (updater as (value: T) => T)(previous) : updater
        store(key, next)
        return next
      })
    },
    [key],
  )

  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData }
}

export function clearQueryCache(prefix = ""): void {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
}
