export const SEARCH_HISTORY_LIMIT = 10

/** Trim and reject terms that would make a noisy history entry. */
export function normalizeSearchTerm(value: unknown): string | null {
  if (typeof value !== "string") return null
  const term = value.trim().replace(/\s+/g, " ")
  if (term.length < 2 || term.length > 200) return null
  return term
}

/** Newest first, case-insensitive de-dupe, capped. */
export function addSearchHistory(history: readonly string[], query: string): string[] {
  const term = normalizeSearchTerm(query)
  if (!term) return [...history]
  const key = term.toLowerCase()
  return [term, ...history.filter((entry) => entry.toLowerCase() !== key)].slice(0, SEARCH_HISTORY_LIMIT)
}

/** Validate untrusted settings input before it reaches the store. */
export function normalizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const terms: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const term = normalizeSearchTerm(entry)
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= SEARCH_HISTORY_LIMIT) break
  }
  return terms
}
