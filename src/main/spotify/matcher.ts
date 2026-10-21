import { pinyin } from "pinyin-pro"
import { toRomaji } from "wanakana"
import type { SpotifyTrack } from "../../shared/types.ts"

export type MatchCandidate = {
  videoId: string
  title: string
  artists: string[]
  album: string | null
  durationSec: number | null
  explicit?: boolean | null
  musicVideoType?: string | null
}

export type SpotifyMatch = {
  candidate: MatchCandidate
  score: number
}

export type SearchFn = (query: string) => Promise<MatchCandidate[]>

export type ParsedTitle = {
  /** Identity key: lowercase letters and digits only. */
  core: string
  /** Version markers that must match in both directions. */
  versions: string[]
  /** Packaging/context words used as a tie-breaker. */
  context: string[]
  /** Human-readable title used to build search queries. */
  searchable: string
}

const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/
const HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7a3]/
const LATIN = /^[\p{Script=Latin}\p{N}\s\p{P}]+$/u

const VERSION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsped[\s-]?up\b/i, "spedup"],
  [/\bslowed(?:\s*\+\s*reverb)?\b/i, "slowed"],
  [/\bnightcore\b/i, "nightcore"],
  [/\bunplugged\b/i, "unplugged"],
  [/\bre-?recorded\b/i, "rerecorded"],
  [/\binstrumental\b/i, "instrumental"],
  [/\bacoustic\b/i, "acoustic"],
  [/\bkaraoke\b/i, "karaoke"],
  [/\bextended\b/i, "extended"],
  [/\bremix\b/i, "remix"],
  [/\brmx\b/i, "remix"],
  [/\blive\b/i, "live"],
  [/\bdemo\b/i, "demo"],
  [/\bedit\b/i, "edit"],
]

const NEUTRAL_LABELS =
  /\b(album version|radio edit|original mix|deluxe (?:version|edition)|bonus track|clean|explicit|single version|remaster(?:ed)?(?:\s+\d{4})?)\b/gi

const CONTEXT_NOISE = new Set([
  "from",
  "the",
  "official",
  "video",
  "audio",
  "music",
  "lyrics",
  "lyric",
  "full",
  "song",
  "soundtrack",
  "version",
  "edition",
  "deluxe",
  "bonus",
  "track",
  "single",
  "album",
  "original",
  "radio",
  "remaster",
  "remastered",
  "with",
  "feat",
  "ft",
  "featuring",
])

const TRAILING_NOISE = /\s*[-–—|]?\s*\b(?:official(?:\s+(?:video|audio|music\s+video))?|video|audio|lyrics?|full|hd|4k|mv|m\/v)\b\.?\s*$/i

const CHO = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
const JUNG = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
const JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]

/** Lowercase identity key: letters and digits in any script. */
export function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

function normalizeWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function romanizeHangul(word: string): string {
  let out = ""
  for (const char of word) {
    const offset = (char.codePointAt(0) ?? 0) - 0xac00
    if (offset < 0 || offset > 11171) {
      out += char
      continue
    }
    out += CHO[Math.floor(offset / 588)] + JUNG[Math.floor((offset % 588) / 28)] + JONG[offset % 28]
  }
  return out
}

/** Romanize scripts we can convert cheaply; kanji readings need a dictionary. */
export function romanizeText(text: string): string {
  if (!text) return text
  if (KANA.test(text)) return toRomaji(text)
  if (HANGUL.test(text)) return text.replace(/[\uac00-\ud7a3]+/g, romanizeHangul)
  if (HAN.test(text)) return pinyin(text, { toneType: "none", type: "string" })
  return text
}

function contextWords(segment: string): string[] {
  return normalizeWords(segment.replace(NEUTRAL_LABELS, " ")).filter(
    (word) => word.length >= 2 && !CONTEXT_NOISE.has(word) && !VERSION_PATTERNS.some(([pattern]) => pattern.test(word)),
  )
}

function versionsIn(segment: string): string[] {
  const neutral = segment.replace(NEUTRAL_LABELS, " ")
  const found: string[] = []
  for (const [pattern, name] of VERSION_PATTERNS) {
    if (pattern.test(neutral)) found.push(name)
  }
  return found
}

function splitBrackets(title: string): { text: string; segments: string[] } {
  let text = title.replace(/[「『【]/g, "(").replace(/[」』】]/g, ")")
  const segments: string[] = []
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    text = text.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (_match, paren: string, square: string) => {
      segments.push(paren ?? square ?? "")
      changed = true
      return " "
    })
    if (!changed) break
  }
  return { text, segments }
}

function splitArtistCredit(credit: string): string[] {
  return credit
    .split(/\s*(?:,|&|\/|;|·|\||、|，|×|\band\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean)
}

function parseWithArtists(title: string, artists: string[], extraKnownArtists: string[] = []): ParsedTitle {
  const known = [...artists, ...extraKnownArtists].flatMap((credit) => [credit, ...splitArtistCredit(credit)])
  const knownKeys = new Set(known.map(normalizeKey).filter(Boolean))
  const versions: string[] = []
  const context: string[] = []

  const collectSegment = (segment: string) => {
    if (!segment.trim()) return
    const found = versionsIn(segment)
    if (found.length) {
      versions.push(...found)
      const remainder = segment.replace(NEUTRAL_LABELS, " ").replace(
        /\b(?:sped[\s-]?up|slowed|nightcore|unplugged|instrumental|acoustic|karaoke|extended|remix|rmx|live|demo|edit|re-?recorded)\b/gi,
        " ",
      )
      context.push(...contextWords(remainder))
    } else {
      context.push(...contextWords(segment))
    }
  }

  const { text: unwrapped, segments } = splitBrackets(title)
  segments.forEach(collectSegment)

  let searchable = unwrapped.replace(/\s+/g, " ").trim()
  const dash = searchable.split(/\s+[-–—|]\s+/)
  if (dash.length > 1) {
    const head = dash[0].trim()
    const tail = dash.slice(1).join(" - ").trim()
    const headKey = normalizeKey(head)
    const tailIsLatin = LATIN.test(tail) && /[A-Za-z]/.test(tail)

    if (head && CJK.test(head) && tailIsLatin && !CJK.test(tail)) {
      // "紅蓮華 - Gurenge": use the Latin transliteration for search.
      context.push(...contextWords(head))
      searchable = tail
    } else if (head && tail && knownKeys.has(headKey)) {
      // "Artist - Song" upload convention.
      context.push(...contextWords(head))
      searchable = tail
    } else {
      searchable = head || tail
      collectSegment(tail)
    }
  }

  // Drop feature tails that survived brackets.
  searchable = searchable.replace(/\s*[(\[]?\s*\b(?:feat|ft|featuring)\.?\s+[^)\]]+[)\]]?\s*$/i, " ").trim()
  for (let pass = 0; pass < 3; pass++) {
    const stripped = searchable.replace(TRAILING_NOISE, "").trim()
    // "Song" is a valid title; never strip the identity down to nothing.
    if (!stripped || !/[\p{L}\p{N}]/u.test(stripped)) break
    if (stripped === searchable) break
    searchable = stripped
  }
  searchable = searchable.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim()

  return {
    core: normalizeKey(searchable),
    versions: [...new Set(versions)],
    context: [...new Set(context)],
    searchable,
  }
}

/** Split a title into identity, version markers and packaging context. */
export function parseTitle(title: string, artists: string[] = []): ParsedTitle {
  return parseWithArtists(title, artists)
}

export function buildQueries(track: SpotifyTrack): string[] {
  const parsed = parseTitle(track.title, track.artists)
  const primary = track.artists[0]?.trim() ?? ""
  const queries: string[] = []
  const add = (query: string) => {
    const value = query.replace(/\s+/g, " ").trim()
    if (!value) return
    if (!queries.some((existing) => existing.toLowerCase() === value.toLowerCase())) queries.push(value)
  }

  add([parsed.searchable, primary].filter(Boolean).join(" "))
  add(parsed.searchable)

  const roman = romanizeText(parsed.searchable).replace(/\s+/g, " ").trim()
  if (roman && normalizeKey(roman) !== normalizeKey(parsed.searchable)) {
    add([roman, primary].filter(Boolean).join(" "))
    add(roman)
  }
  return queries.slice(0, 4)
}

function artistKeys(artists: string[]): { full: Set<string>; parts: Set<string> } {
  const full = new Set<string>()
  const parts = new Set<string>()
  for (const credit of artists) {
    const fullKey = normalizeKey(credit)
    if (fullKey) full.add(fullKey)
    for (const part of splitArtistCredit(credit)) {
      const key = normalizeKey(part)
      if (key) parts.add(key)
    }
  }
  return { full, parts }
}

function artistOverlap(target: { full: Set<string>; parts: Set<string> }, candidate: { full: Set<string>; parts: Set<string> }): boolean {
  const left = [...target.full, ...target.parts]
  const right = [...candidate.full, ...candidate.parts]
  return left.some((a) => right.some((b) => a === b))
}

function sameArtistSet(target: { parts: Set<string> }, candidate: { parts: Set<string> }): boolean {
  if (!target.parts.size || target.parts.size !== candidate.parts.size) return false
  return [...target.parts].every((name) => candidate.parts.has(name))
}

function titleMatches(target: ParsedTitle, candidate: ParsedTitle): boolean {
  if (!target.core || !candidate.core) return false
  if (target.core === candidate.core) return true

  const targetRoman = normalizeKey(romanizeText(target.core))
  const candidateRoman = normalizeKey(romanizeText(candidate.core))
  if (targetRoman && candidateRoman && targetRoman === candidateRoman) return true

  if (
    target.core.length > 3 &&
    candidate.core.length > 3 &&
    (target.core.includes(candidate.core) || candidate.core.includes(target.core))
  ) {
    return true
  }
  return (
    targetRoman.length > 3 &&
    candidateRoman.length > 3 &&
    (targetRoman.includes(candidateRoman) || candidateRoman.includes(targetRoman))
  )
}

function sameVersions(a: string[], b: string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  return [...left].every((version) => right.has(version))
}

function durationOf(track: SpotifyTrack): number | null {
  return track.durationMs && track.durationMs > 0 ? track.durationMs / 1000 : null
}

function candidateDuration(candidate: MatchCandidate): number | null {
  return candidate.durationSec && candidate.durationSec > 0 ? candidate.durationSec : null
}

function albumKey(album: string | null | undefined): string {
  return album ? normalizeKey(album) : ""
}

/** Rank candidates that passed the hard gates; null means no confident match. */
export function rankCandidates(track: SpotifyTrack, candidates: MatchCandidate[]): SpotifyMatch | null {
  const target = parseTitle(track.title, track.artists)
  const targetArtists = artistKeys(track.artists)
  const targetDuration = durationOf(track)
  let best: SpotifyMatch | null = null
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (!candidate.videoId || seen.has(candidate.videoId)) continue
    seen.add(candidate.videoId)

    const parsed = parseWithArtists(candidate.title, candidate.artists, track.artists)
    const candidateArtists = artistKeys(candidate.artists)
    if (!titleMatches(target, parsed)) continue
    if (!sameVersions(target.versions, parsed.versions)) continue

    const candidateTime = candidateDuration(candidate)
    const delta =
      targetDuration !== null && candidateTime !== null ? Math.abs(targetDuration - candidateTime) : null
    if (delta !== null && delta > 30) continue

    if (
      track.explicit !== null &&
      candidate.explicit !== null &&
      candidate.explicit !== undefined &&
      track.explicit !== candidate.explicit
    ) {
      continue
    }

    const hasTargetArtists = targetArtists.full.size > 0 || targetArtists.parts.size > 0
    let creditsMatch = hasTargetArtists
      ? artistOverlap(targetArtists, candidateArtists)
      : true
    let rescued = false
    if (!creditsMatch) {
      // Composer-vs-singer credits can differ on film catalogues. Only audio
      // files with a near-exact runtime get this escape hatch.
      const isVideo = candidate.musicVideoType === "MUSIC_VIDEO_TYPE_OMV"
      if (!isVideo && delta !== null && delta <= 2) {
        creditsMatch = false
        rescued = true
      } else {
        continue
      }
    }

    let score = 100
    if (hasTargetArtists && creditsMatch) {
      score += sameArtistSet(targetArtists, candidateArtists) ? 25 : 10
    }
    if (delta !== null) score += delta <= 3 ? 40 : delta <= 30 ? 15 : 0
    if (track.album && candidate.album && albumKey(track.album) === albumKey(candidate.album)) score += 35
    if (track.explicit !== null && candidate.explicit !== null && candidate.explicit !== undefined) score += 20
    if (target.context.some((word) => parsed.context.includes(word))) score += 20
    if (rescued) score -= 30

    if (!best || score > best.score) best = { candidate, score }
  }

  return best
}

/** Search with the best query first, continuing only while nothing passes the gates. */
export async function matchTrack(track: SpotifyTrack, search: SearchFn): Promise<SpotifyMatch | null> {
  const candidates: MatchCandidate[] = []
  const seen = new Set<string>()

  for (const query of buildQueries(track)) {
    const results = await search(query)
    for (const candidate of results) {
      if (seen.has(candidate.videoId)) continue
      seen.add(candidate.videoId)
      candidates.push(candidate)
    }
    const match = rankCandidates(track, candidates)
    if (match) return match
  }

  return null
}
