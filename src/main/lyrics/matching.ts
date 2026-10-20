const CREDITS = [
  /\s*[(\[]\s*(feat|ft|featuring|with)\b[^)\]]*[)\]]/gi,
  /\s+(feat|ft|featuring)\.?\s+.*$/gi,
  /\s*[(\[]\s*(official\s*)?(music\s*)?(video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m\/?v|hd|hq|4k|full\s*song)\s*[)\]]/gi,
  /\s*[(\[]\s*official\s*[)\]]/gi,
]

const VERSION_WORDS = new Set([
  "live",
  "remix",
  "acoustic",
  "unplugged",
  "instrumental",
  "karaoke",
  "a",
  "cappella",
  "acappella",
  "demo",
  "edit",
  "cover",
  "sped",
  "up",
  "slowed",
  "reverb",
  "nightcore",
  "lofi",
  "lo-fi",
  "orchestral",
  "extended",
  "version",
])

export type MatchQuery = {
  title: string
  artist: string
  durationMs: number
}

export type Candidate = {
  title: string
  artist: string
  durationMs: number
}

/** Remove upload packaging, but keep markers that name a different recording. */
export function forLyricsSearch(title: string): string {
  let name = title
  for (const pattern of CREDITS) name = name.replace(pattern, " ")
  name = name.replace(/\s+/g, " ").trim().replace(/[,–—-]+$/, "").trim()
  return name || title.trim()
}

export function artistForLyricsSearch(artist: string): string {
  const cleaned = artist.replace(/\s*-\s*Topic$/i, "").trim()
  return cleaned || artist.trim()
}

export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function splitArtists(artist: string): string[] {
  return artist
    .replace(/\s*-\s*Topic$/i, "")
    .split(/\s*(?:,|&|;|\/|、|，|\band\b|\bx\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/gi)
    .map(normalizeText)
    .filter(Boolean)
}

export function coreTitle(title: string): { core: string; versions: Set<string> } {
  const removed: string[] = []
  let name = title.replace(/[(\[]([^)\]]*)[)\]]/g, (_match, inner: string) => {
    removed.push(inner)
    return " "
  })
  name = name.replace(/\s+[-–—]\s+.*$/, (match) => {
    removed.push(match.replace(/^\s+[-–—]\s+/, ""))
    return " "
  })
  const core = normalizeText(name) || normalizeText(title)
  const versions = new Set(
    normalizeText(removed.join(" "))
      .split(" ")
      .filter((word) => VERSION_WORDS.has(word)),
  )
  return { core, versions }
}

export function versionCompatible(wanted: string, candidate: string): boolean {
  const a = coreTitle(wanted)
  const b = coreTitle(candidate)
  if (a.core !== b.core) return false
  if (a.versions.size !== b.versions.size) return false
  for (const word of a.versions) if (!b.versions.has(word)) return false
  return true
}

export function artistMatches(wanted: string, candidate: string): boolean {
  const a = splitArtists(wanted)
  const b = splitArtists(candidate)
  return a.length > 0 && b.length > 0 && a.some((artist) => b.includes(artist))
}

export function durationMatches(wantedMs: number, candidateMs: number, toleranceMs: number): boolean {
  if (!wantedMs || !candidateMs) return true
  return Math.abs(wantedMs - candidateMs) <= toleranceMs
}

export function lrcRedHit(query: MatchQuery, hit: { title?: string; artist?: string; duration?: number }): boolean {
  if (!hit.title || !hit.artist) return false
  return (
    versionCompatible(query.title, hit.title) &&
    artistMatches(query.artist, hit.artist) &&
    durationMatches(query.durationMs, Number(hit.duration ?? 0) * 1000, 3000)
  )
}

/** Generic candidate score: title, artist, duration. */
export function scoreCandidate(query: MatchQuery, candidate: Candidate): number {
  const wantedTitle = normalizeText(coreTitle(query.title).core)
  const candidateTitle = normalizeText(coreTitle(candidate.title).core)
  let score = 0
  if (wantedTitle && wantedTitle === candidateTitle) score += 20
  else if (wantedTitle && candidateTitle && (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle))) {
    score += 10
  }

  const wantedArtists = splitArtists(query.artist)
  const candidateArtists = splitArtists(candidate.artist)
  if (wantedArtists.some((artist) => candidateArtists.includes(artist))) score += 15
  else if (
    wantedArtists.some((artist) =>
      candidateArtists.some((other) => other.includes(artist) || artist.includes(other)),
    )
  ) {
    score += 5
  }

  if (query.durationMs && candidate.durationMs) {
    const delta = Math.abs(query.durationMs - candidate.durationMs)
    if (delta <= 3000) score += 10
    else if (delta <= 10_000) score += 5
  }
  return score
}

export function pickCandidate<T extends Candidate>(query: MatchQuery, candidates: T[], maxDurationMs = 15_000): T | null {
  let best: T | null = null
  let bestScore = 0
  let bestDelta = Infinity
  for (const candidate of candidates) {
    const score = scoreCandidate(query, candidate)
    if (score < 10) continue
    if (query.durationMs && candidate.durationMs && Math.abs(query.durationMs - candidate.durationMs) > maxDurationMs) continue
    const delta = query.durationMs && candidate.durationMs ? Math.abs(query.durationMs - candidate.durationMs) : 0
    if (score > bestScore || (score === bestScore && delta < bestDelta)) {
      best = candidate
      bestScore = score
      bestDelta = delta
    }
  }
  return best
}

export function isIsrc(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value)
}
