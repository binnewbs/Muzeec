import { useEffect, useRef, useState } from "react"

type CacheEntry = { data: unknown; at: number }

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()

export type QueryState<T> = {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Tiny stale-while-revalidate query layer: in-memory cache + in-flight dedupe (PLAN §6). */
export function useIpcQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  { enabled = true, staleTime = 2 * 60 * 1000 }: { enabled?: boolean; staleTime?: number } = {},
): QueryState<T> {
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const [data, setData] = useState<T | null>(() => {
    const hit = cache.get(key)
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
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < staleTime && nonce === 0) {
      setData(hit.data as T)
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
        cache.set(key, { data: value, at: Date.now() })
        if (!cancelled) setData(value)
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

  return { data, error, loading, reload: () => setNonce((n) => n + 1) }
}

export function clearQueryCache(prefix = ""): void {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
}
