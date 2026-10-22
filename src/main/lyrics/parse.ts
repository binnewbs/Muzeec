import type { LyricLine, LyricSyllable, LyricWord, LyricsResult } from "../../shared/types.ts"

type TimedRun = { raw: string; startMs: number; endMs: number }

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u
const CONTENT_KEYS = [
  "ttml",
  "syncedLyrics",
  "plainLyrics",
  "lyrics",
  "lrc",
  "content",
  "text",
  "plain",
  "lines",
  "data",
  "result",
  "response",
]

export function parseLyricsPayload(raw: string | null): LyricLine[] | null {
  if (!raw) return null
  let body = raw.replace(/^\uFEFF/, "").trim()
  if (!body) return null
  body = body.replace(/^```[a-z0-9-]*\s*/i, "").replace(/\s*```$/i, "")

  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const json = JSON.parse(body)
      if (json?.isError === true || json?.success === false || json?.ok === false) return null
      const text = extractJsonText(json)
      if (!text) return null
      body = text.trim()
    } catch {
      // Some endpoints prefix JSON with an HTML error page; fall through to text parsing.
    }
  }

  body = decodeEntities(body).trim()
  if (!body) return null
  if (/<tt\b/i.test(body)) return nonEmpty(parseTtml(body))
  if (/^\s*\[\d+\s*,\s*\d+\]/m.test(body)) return nonEmpty(parseQrc(body))
  if (/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(body)) return nonEmpty(parseLrc(body))
  return nonEmpty(parsePlainText(body))
}

function extractJsonText(value: any, depth = 0): string | null {
  if (depth > 8) return null
  if (typeof value === "string") return value.trim() ? value : null
  if (Array.isArray(value)) {
    const parts = value.map((entry) => extractJsonText(entry, depth + 1)).filter(Boolean) as string[]
    return parts.length ? parts.join("\n") : null
  }
  if (!value || typeof value !== "object") return null
  if (value.isError === true || value.success === false || value.ok === false) return null
  for (const key of CONTENT_KEYS) {
    if (!(key in value)) continue
    const text = extractJsonText(value[key], depth + 1)
    if (text) return text
  }
  return null
}

export function parseTtml(xml: string): LyricLine[] {
  const lines: LyricLine[] = []
  const paragraphs = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
  for (const match of xml.matchAll(paragraphs)) {
    const attrs = match[1] ?? ""
    const inner = match[2] ?? ""
    const begin = parseTtmlTime(attr(attrs, "begin")) ?? 0
    const end = parseTtmlTime(attr(attrs, "end"))
    const voice = attr(attrs, "ttm:agent") ?? attr(attrs, "agent")
    let leadRuns: TimedRun[] = []
    let backgroundRuns: TimedRun[] = []

    if (/<span\b/i.test(inner)) {
      const runs = parseTtmlRuns(inner, begin, end)
      leadRuns = runs.lead
      backgroundRuns = runs.background
    }

    const words = mergeRuns(leadRuns)
    const backgroundWords = mergeRuns(backgroundRuns)
    const fallbackText = decodeEntities(stripHtml(inner)).trim()
    const text = words.length ? joinedWords(words) : backgroundWords.length ? "" : fallbackText
    if (!text && !backgroundWords.length) continue

    const line: LyricLine = {
      timeMs: Math.max(0, begin),
      text,
      words,
      sungUntilMs: end ?? words.at(-1)?.endMs ?? null,
      alignment: "start",
      voice,
    }
    if (backgroundWords.length) {
      line.background = {
        timeMs: Math.max(0, backgroundWords[0]?.startMs ?? begin),
        text: joinedWords(backgroundWords),
        words: backgroundWords,
        sungUntilMs: backgroundWords.at(-1)?.endMs ?? end ?? null,
        alignment: "start",
        voice,
      }
    }
    lines.push(line)
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

type TtmlSpan = { role: string; begin: number; end: number | null }

/**
 * Walks a paragraph's inline markup into timed runs. A stack keeps nested
 * spans' timing and role, so a closing tag can never leak into the lyrics as
 * text and an x-bg wrapper keeps all of its children in the background.
 */
function parseTtmlRuns(
  inner: string,
  begin: number,
  end: number | null,
): { lead: TimedRun[]; background: TimedRun[] } {
  const lead: TimedRun[] = []
  const background: TimedRun[] = []
  const stack: TtmlSpan[] = []
  let cursor = 0

  const addText = (raw: string) => {
    if (!raw) return
    const text = decodeEntities(raw)
    if (!text) return
    const roles = stack.map((span) => span.role).filter(Boolean)
    if (roles.some((role) => role.includes("x-translation") || role.includes("x-roman"))) return
    const current = stack.at(-1)
    const run: TimedRun = {
      raw: text,
      startMs: current?.begin ?? begin,
      endMs: current?.end ?? end ?? begin,
    }
    if (roles.some((role) => role.includes("x-bg"))) background.push(run)
    else lead.push(run)
  }

  for (const match of inner.matchAll(/<[^>]*>/g)) {
    const index = match.index ?? 0
    addText(inner.slice(cursor, index))
    cursor = index + match[0].length
    const tag = match[0]

    if (/^<\s*\/\s*span\b/i.test(tag)) {
      // An unmatched close is harmless; never turn it into lyric text.
      stack.pop()
      continue
    }
    if (/^<\s*span\b/i.test(tag)) {
      if (/\/\s*>$/.test(tag)) continue
      const spanAttrs = tag.replace(/^<\s*span\b/i, "").replace(/\s*>$/, "")
      const parent = stack.at(-1)
      stack.push({
        role: (attr(spanAttrs, "ttm:role") ?? attr(spanAttrs, "role") ?? "").toLowerCase(),
        begin: parseTtmlTime(attr(spanAttrs, "begin")) ?? parent?.begin ?? begin,
        end: parseTtmlTime(attr(spanAttrs, "end")) ?? parent?.end ?? end,
      })
      continue
    }
    if (/^<\s*br\b/i.test(tag)) addText(" ")
  }
  addText(inner.slice(cursor))
  return { lead, background }
}

export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw || /^\[(ti|ar|al|by|offset|re|ve):/i.test(raw)) continue
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const lastStamp = stamps.at(-1)!
    const content = raw.slice((lastStamp.index ?? 0) + lastStamp[0].length)
    const lineStart = stampMs(lastStamp)
    const wordStamps = [...content.matchAll(/<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g)]
    let words: LyricWord[] = []
    let sungUntilMs: number | null = null

    if (wordStamps.length) {
      const runs: TimedRun[] = []
      let lineEnd: number | null = null
      for (let index = 0; index < wordStamps.length; index++) {
        const wordStamp = wordStamps[index]
        const next = wordStamps[index + 1]
        const start = stampMs(wordStamp)
        const from = (wordStamp.index ?? 0) + wordStamp[0].length
        const to = next?.index ?? content.length
        const runText = content.slice(from, to)
        if (!runText.trim()) {
          lineEnd = start
          continue
        }
        runs.push({ raw: runText, startMs: start, endMs: next ? stampMs(next) : lineEnd ?? 0 })
      }
      words = mergeRuns(runs)
      sungUntilMs = lineEnd
    }

    const lineText = decodeEntities(stripHtml(content.replace(/<[^>]+>/g, ""))).trim()
    for (const stamp of stamps) {
      lines.push({
        timeMs: stampMs(stamp),
        text: words.length ? joinedWords(words) : lineText,
        words,
        sungUntilMs,
        alignment: "start",
      })
    }
    if (!words.length && lineStart < 0) lines.pop()
  }

  const sorted = lines.sort((a, b) => a.timeMs - b.timeMs)
  for (let index = 0; index < sorted.length; index++) {
    const line = sorted[index]
    if (!line.words.length) continue
    const next = sorted[index + 1]?.timeMs ?? 0
    for (const word of line.words) {
      if (!word.endMs || word.endMs <= word.startMs) {
        word.endMs = next > word.startMs ? next : word.startMs + 800
      }
    }
    line.sungUntilMs ??= line.words.at(-1)?.endMs ?? null
    line.text ||= joinedWords(line.words)
  }
  return sorted
}

export function parseEnhancedLrc(text: string): LyricLine[] {
  return parseLrc(text)
}

export function parseQrc(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*\[(\d+)\s*,\s*(\d+)\]\s*(.*)$/.exec(rawLine)
    if (!match) continue
    const lineStart = Number(match[1])
    const lineDuration = Number(match[2])
    const content = match[3] ?? ""
    const timings = [...content.matchAll(/\((\d+)\s*,\s*(\d+)\)/g)]
    if (!timings.length) {
      const plain = decodeEntities(stripHtml(content)).trim()
      if (plain) lines.push(lineAt(lineStart, plain, lineStart + lineDuration))
      continue
    }

    const prefix = timings[0].index === 0
    const runs: TimedRun[] = []
    if (prefix) {
      for (let index = 0; index < timings.length; index++) {
        const timing = timings[index]
        const next = timings[index + 1]
        const from = (timing.index ?? 0) + timing[0].length
        const to = next?.index ?? content.length
        const runText = content.slice(from, to)
        if (!runText.trim()) continue
        runs.push({ raw: runText, startMs: Number(timing[1]), endMs: Number(timing[1]) + Number(timing[2]) })
      }
    } else {
      let cursor = 0
      for (const timing of timings) {
        const runText = content.slice(cursor, timing.index)
        cursor = (timing.index ?? 0) + timing[0].length
        if (!runText.trim()) continue
        runs.push({ raw: runText, startMs: Number(timing[1]), endMs: Number(timing[1]) + Number(timing[2]) })
      }
    }
    if (!runs.length) continue
    const words = mergeRuns(runs)
    lines.push({
      timeMs: lineStart,
      text: joinedWords(words),
      words,
      sungUntilMs: lineStart + lineDuration,
      alignment: "start",
    })
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

export function parsePlainText(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const rawLine of stripHtml(decodeEntities(text)).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^\[(ti|ar|al|by|offset|re|ve):/i.test(line)) continue
    if (/^(lyrics|songwriters?|composers?|arrangers?|producers?)\s*:/i.test(line)) continue
    if (/^(lyrics not found|no lyrics found|not found|unavailable)$/i.test(line)) continue
    lines.push(lineAt(0, line))
  }
  return lines
}

export function normalizeLyrics(source: string, label: string, input: LyricLine[]): LyricsResult {
  let lines = input
    .map(cleanLine)
    .filter((line): line is LyricLine => Boolean(line))
    .sort((a, b) => a.timeMs - b.timeMs)
    .map(splitBackground)
  assignAlignment(lines)
  lines = insertGaps(lines)
  const wordSynced = lines.some((line) => line.words.length > 0)
  return {
    source,
    label,
    wordSynced,
    synced: lines.some((line) => line.timeMs > 0),
    lines,
  }
}

export function charsSungAt(word: LyricWord, positionMs: number): number {
  if (positionMs <= word.startMs) return 0
  if (positionMs >= word.endMs) return word.text.length
  if (!word.syllables.length) {
    return ((positionMs - word.startMs) / Math.max(1, word.endMs - word.startMs)) * word.text.length
  }
  for (const syllable of word.syllables) {
    if (positionMs < syllable.startMs) return syllable.startChar
    if (positionMs < syllable.endMs) {
      const progress = (positionMs - syllable.startMs) / Math.max(1, syllable.endMs - syllable.startMs)
      return syllable.startChar + progress * (syllable.endChar - syllable.startChar)
    }
  }
  return word.text.length
}

function cleanLine(line: LyricLine): LyricLine | null {
  if (!line || !Number.isFinite(line.timeMs)) return null
  const words = (line.words ?? [])
    .filter((word) => word && word.text.trim())
    .map((word) => {
      const startMs = Math.max(0, word.startMs)
      const endMs = Math.max(startMs, word.endMs || startMs)
      return {
        ...word,
        startMs,
        endMs,
        syllables: (word.syllables ?? []).map((syllable) => ({
          startMs: Math.max(startMs, syllable.startMs),
          endMs: Math.max(syllable.startMs, syllable.endMs),
          startChar: Math.max(0, Math.min(word.text.length, syllable.startChar)),
          endChar: Math.max(0, Math.min(word.text.length, syllable.endChar)),
        })),
      }
    })
  const text = (line.text || joinedWords(words)).trim()
  if (!text && !words.length && line.timeMs <= 0) return null
  return {
    timeMs: Math.max(0, line.timeMs),
    text,
    words,
    sungUntilMs: typeof line.sungUntilMs === "number" ? Math.max(line.timeMs, line.sungUntilMs) : null,
    background: line.background ? cleanLine(line.background) : null,
    alignment: line.alignment === "end" ? "end" : "start",
    voice: line.voice ?? null,
  }
}

function splitBackground(line: LyricLine): LyricLine {
  if (line.background) return line
  const match = /(\([^()]*\)|\[[^\[\]]*\])\s*$/.exec(line.text)
  if (!match || match.index <= 0) return line
  const lead = line.text.slice(0, match.index).trim()
  const background = match[0].trim()
  if (!lead || !/[a-z0-9\u00c0-\uffff]/i.test(background)) return line
  if (!line.words.length) {
    return {
      ...line,
      text: lead,
      background: {
        timeMs: line.timeMs,
        text: background,
        words: [],
        sungUntilMs: line.sungUntilMs ?? null,
        alignment: "start",
      },
    }
  }

  let cursor = 0
  let split = -1
  for (let index = 0; index < line.words.length; index++) {
    const word = line.words[index]
    const start = cursor
    const end = cursor + word.text.length
    if (start < match.index && end > match.index) return line
    if (start >= match.index) {
      split = index
      break
    }
    cursor = end + 1
  }
  if (split <= 0) return line
  const leadWords = line.words.slice(0, split)
  const backgroundWords = line.words.slice(split)
  if (!leadWords.length || !backgroundWords.length) return line
  return {
    ...line,
    text: lead,
    words: leadWords,
    background: {
      timeMs: backgroundWords[0].startMs,
      text: background,
      words: backgroundWords,
      sungUntilMs: backgroundWords.at(-1)?.endMs ?? line.sungUntilMs ?? null,
      alignment: "start",
    },
  }
}

function assignAlignment(lines: LyricLine[]): void {
  let turn: "start" | "end" = "start"
  let previousVoice: string | null = null
  for (const line of lines) {
    const voice = line.voice ?? null
    if (voice === "v1000") {
      line.alignment = "start"
      continue
    }
    if (voice && previousVoice && voice !== previousVoice) turn = turn === "start" ? "end" : "start"
    line.alignment = turn
    if (voice) previousVoice = voice
  }
  const placed = lines.filter((line) => line.voice !== "v1000")
  const ends = placed.filter((line) => line.alignment === "end").length
  if (placed.length >= 4 && ends / placed.length >= 0.85) {
    for (const line of placed) line.alignment = line.alignment === "end" ? "start" : "end"
  }
}

function insertGaps(lines: LyricLine[]): LyricLine[] {
  if (!lines.length) return lines
  const out: LyricLine[] = []
  if (lines[0].timeMs >= 4000) out.push(gap(0))
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    out.push(line)
    const next = lines[index + 1]
    if (!next || !line.text) continue
    const end = line.words.at(-1)?.endMs ?? line.sungUntilMs ?? null
    if (end === null || next.timeMs - end < 4000) continue
    if (next.timeMs <= end) continue
    out.push(gap(end))
  }
  return out
}

function gap(timeMs: number): LyricLine {
  return { timeMs, text: "", words: [], sungUntilMs: null, alignment: "start" }
}

function lineAt(timeMs: number, text: string, sungUntilMs: number | null = null): LyricLine {
  return { timeMs, text, words: [], sungUntilMs, alignment: "start" }
}

export function mergeRuns(runs: TimedRun[]): LyricWord[] {
  const words: LyricWord[] = []
  let current: LyricWord | null = null

  const flush = () => {
    if (current && current.text.trim()) words.push(current)
    current = null
  }

  const startWord = (run: TimedRun, text: string): LyricWord => ({
    text,
    startMs: run.startMs,
    endMs: run.endMs,
    syllables: [{ startMs: run.startMs, endMs: run.endMs, startChar: 0, endChar: text.length }],
  })

  for (const run of runs) {
    const raw = run.raw.replace(/\u00a0/g, " ")
    const content = raw.replace(/\s+/g, " ").trim()
    if (!content) {
      flush()
      continue
    }
    if (/^\s/.test(raw)) flush()
    const pieces = content.split(" ")
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]
      if (!piece) continue
      if (!current) current = startWord(run, piece)
      else {
        const previous = current.text.slice(-1)
        if (UNSPACED.test(previous) && UNSPACED.test(piece[0])) {
          flush()
          current = startWord(run, piece)
        } else {
          const startChar = current.text.length
          current.text += piece
          current.endMs = Math.max(current.endMs, run.endMs)
          current.syllables.push({
            startMs: run.startMs,
            endMs: run.endMs,
            startChar,
            endChar: current.text.length,
          })
        }
      }
      if (index < pieces.length - 1) flush()
    }
    if (/\s$/.test(raw)) flush()
  }
  flush()
  return words
}

function joinedWords(words: LyricWord[]): string {
  return words.map((word) => word.text).join(" ")
}

function nonEmpty(lines: LyricLine[]): LyricLine[] | null {
  return lines.some((line) => line.text.trim() || line.words.length) ? lines : null
}

function stampMs(match: RegExpMatchArray): number {
  const minutes = Number(match[1] ?? 0)
  const seconds = Number(match[2] ?? 0)
  const fraction = match[3] ?? ""
  const millis = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0
  return Math.max(0, minutes * 60_000 + seconds * 1000 + millis)
}

function parseTtmlTime(value: string | null): number | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d+(\.\d+)?ms$/i.test(text)) return Number(text.replace(/ms$/i, ""))
  if (/^\d+(\.\d+)?s$/i.test(text)) return Number(text.replace(/s$/i, "")) * 1000
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?(?:[.:](\d{1,3}))?$/.exec(text)
  if (!clock) return null
  const hours = clock[3] !== undefined ? Number(clock[1]) : 0
  const minutes = clock[3] !== undefined ? Number(clock[2]) : Number(clock[1])
  const seconds = clock[3] !== undefined ? Number(clock[3]) : Number(clock[2])
  const fraction = clock[4] ?? ""
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + Number(fraction.padEnd(3, "0").slice(0, 3))
}

function attr(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)
  return match?.[1] ?? null
}

function stripHtml(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x"
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}
