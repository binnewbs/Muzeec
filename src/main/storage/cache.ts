type Entry<T> = { value: T; expires: number }

/**
 * In-memory cache. Persisting parsed pages to SQLite is a later optimisation;
 * one process-lifetime cache already removes repeated InnerTube round-trips.
 */
const store = new Map<string, Entry<unknown>>()
const MAX = 300

export function cacheGet<T>(key: string): T | null {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    store.delete(key)
    return null
  }
  return hit.value as T
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  if (store.size >= MAX) store.delete(store.keys().next().value!)
  store.set(key, { value, expires: Date.now() + ttlMs })
  return value
}

export function cacheClear(prefix = ""): void {
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key)
}
