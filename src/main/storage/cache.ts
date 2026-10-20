import { getSettings } from "./settings.ts"

type Entry<T> = { value: T; expires: number; cost: number }

/**
 * In-memory LRU cache. Persisting parsed pages to SQLite is a later optimisation;
 * one process-lifetime cache already removes repeated InnerTube round-trips.
 *
 * Entries are weighted by the number of media items they contain so a handful of
 * large paginated playlists cannot crowd out everything else.
 */
const DEFAULT_MAX_ENTRIES = 120
const DEFAULT_MAX_COST = 20_000
const LOW_MEMORY_MAX_ENTRIES = 40
const LOW_MEMORY_MAX_COST = 4_000

const store = new Map<string, Entry<unknown>>()
let totalCost = 0

function limits(): { entries: number; cost: number } {
  return getSettings().lowMemory
    ? { entries: LOW_MEMORY_MAX_ENTRIES, cost: LOW_MEMORY_MAX_COST }
    : { entries: DEFAULT_MAX_ENTRIES, cost: DEFAULT_MAX_COST }
}

function remove(key: string): void {
  const entry = store.get(key)
  if (!entry) return
  totalCost -= entry.cost
  store.delete(key)
}

function purgeExpired(now = Date.now()): void {
  for (const [key, entry] of store) {
    if (entry.expires <= now) remove(key)
  }
}

export function cacheGet<T>(key: string): T | null {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    remove(key)
    return null
  }
  // Refresh recency: Map iteration order is insertion order.
  store.delete(key)
  store.set(key, hit)
  return hit.value as T
}

export function cacheSet<T>(key: string, value: T, ttlMs: number, cost = 1): T {
  const { entries: maxEntries, cost: maxCost } = limits()
  // A single oversized page still gets cached, but cannot exceed the whole budget.
  const weight = Math.min(maxCost, Math.max(1, Math.floor(cost)))

  remove(key)
  if (store.size >= maxEntries || totalCost + weight > maxCost) purgeExpired()

  while (store.size && (store.size >= maxEntries || totalCost + weight > maxCost)) {
    remove(store.keys().next().value!)
  }

  store.set(key, { value, expires: Date.now() + ttlMs, cost: weight })
  totalCost += weight
  return value
}

/** Enforce the current budget immediately (used when low-memory mode is enabled). */
export function cacheTrim(): void {
  const { entries: maxEntries, cost: maxCost } = limits()
  purgeExpired()
  while (store.size && (store.size > maxEntries || totalCost > maxCost)) {
    remove(store.keys().next().value!)
  }
}

export function cacheClear(prefix = ""): void {
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) remove(key)
}
