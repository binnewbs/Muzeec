import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LyricLine, LyricWord, LyricsResult } from "@shared/types"
import { LanguagesIcon, RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { usePlayer } from "@/lib/store/player"
import { useSettings } from "@/lib/store/settings"
import { engine } from "@/player/engine"

const CJK = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/

export function LyricsPanel() {
  const current = usePlayer((state) => state.current)
  const playing = usePlayer((state) => state.status === "playing")
  const settings = useSettings((state) => state.settings)
  const update = useSettings((state) => state.update)
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [position, setPosition] = useState(() => engine.currentTime * 1000)
  const rows = useRef<Array<HTMLDivElement | null>>([])
  const sourcesKey = settings.lyricsSources.join(",")
  const wordSynced = Boolean(result?.wordSynced)
  const romanize = settings.lyricsRomanize
  const [romanizedLines, setRomanizedLines] = useState<string[] | null>(null)
  const [romanizing, setRomanizing] = useState(false)
  const hasCjk = useMemo(() => (result?.lines ?? []).some((line) => CJK.test(line.text)), [result])

  // Keep the romanizer (and the Japanese dictionary) out of the main bundle until they are needed.
  useEffect(() => {
    if (!romanize || !result) {
      setRomanizedLines(null)
      setRomanizing(false)
      return
    }
    let alive = true
    setRomanizing(true)
    void import("@/lib/romanize")
      .then((module) => module.romanizeLines(result.lines.map((line) => line.text)))
      .then((lines) => {
        if (alive) setRomanizedLines(lines)
      })
      .catch(() => {
        if (alive) setRomanizedLines(null)
      })
      .finally(() => {
        if (alive) setRomanizing(false)
      })
    return () => {
      alive = false
    }
  }, [romanize, result])

  // Line highlighting only needs the engine's 4 Hz ticker, not a render loop.
  useEffect(() => {
    const sync = () => setPosition(engine.currentTime * 1000)
    sync()
    return engine.subscribe(sync)
  }, [])

  // Word-level sweep needs frame precision, but only while a word-synced song plays.
  useEffect(() => {
    if (!playing || !wordSynced) return
    let frame = 0
    const tick = () => {
      setPosition(engine.currentTime * 1000)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, wordSynced])

  const registerRow = useCallback((index: number, node: HTMLDivElement | null) => {
    rows.current[index] = node
  }, [])

  useEffect(() => {
    if (!settings.lyricsEnabled || !current) {
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const artist =
      current.artists?.map((entry) => entry.name).join(", ") ||
      current.subtitle.split(" • ")[0] ||
      "Unknown artist"
    const durationMs = Math.round((current.duration ?? engine.duration ?? 0) * 1000)

    setLoading(true)
    setError(null)
    setResult(null)
    void unwrap(
      api.lyrics({
        videoId: current.videoId,
        title: current.title,
        artist,
        album: current.album?.name ?? null,
        durationMs,
        retry: retry > 0,
      }),
    )
      .then((data) => {
        if (!cancelled) setResult(data)
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [current?.videoId, current?.title, current?.subtitle, current?.album?.name, settings.lyricsEnabled, sourcesKey, settings.lyricsPreferSyllableTiming, retry])

  const offset = settings.lyricsOffsetMs
  const activeIndex = useMemo(() => {
    if (!result?.synced) return -1
    const target = position + offset
    let index = -1
    for (let cursor = 0; cursor < result.lines.length; cursor++) {
      if (result.lines[cursor].timeMs <= target) index = cursor
      else break
    }
    return index
  }, [result, position, offset])

  useEffect(() => {
    if (activeIndex < 0) return
    rows.current[activeIndex]?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [activeIndex])

  const seekTo = useCallback(
    (line: LyricLine) => {
      if (!result?.synced || line.timeMs <= 0) return
      engine.seek(Math.max(0, (line.timeMs - offset) / 1000))
    },
    [result?.synced, offset],
  )

  const nudge = (delta: number) => {
    void update({ lyricsOffsetMs: Math.max(-5000, Math.min(5000, offset + delta)) })
  }

  if (!settings.lyricsEnabled) {
    return <p className="px-6 py-4 text-sm text-muted-foreground">Lyrics are disabled in settings.</p>
  }
  if (!current) {
    return <p className="px-6 py-4 text-sm text-muted-foreground">Play a song to see its lyrics.</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        {result ? <Badge variant="secondary">{result.label}</Badge> : null}
        {result ? (
          <Badge variant="outline">{result.wordSynced ? "Word sync" : result.synced ? "Line sync" : "Plain"}</Badge>
        ) : null}
        {hasCjk ? (
          <Button
            variant={romanize ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={romanize}
            aria-label="Romanize lyrics"
            disabled={romanizing}
            onClick={() => void update({ lyricsRomanize: !romanize })}
          >
            {romanizing ? <Spinner data-icon="inline-start" /> : <LanguagesIcon data-icon="inline-start" />}
            Romanize
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Lyrics earlier" onClick={() => nudge(-500)}>
            −0.5s
          </Button>
          <Button variant="ghost" size="sm" aria-label="Reset lyric offset" onClick={() => void update({ lyricsOffsetMs: 0 })}>
            {offset === 0 ? "0.0s" : `${offset > 0 ? "+" : ""}${(offset / 1000).toFixed(1)}s`}
          </Button>
          <Button variant="ghost" size="sm" aria-label="Lyrics later" onClick={() => nudge(500)}>
            +0.5s
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh lyrics"
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-6">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Spinner />
              Finding lyrics…
            </div>
          ) : error ? (
            <p className="py-4 text-sm text-destructive">{error}</p>
          ) : result ? (
            <div className="flex flex-col gap-4 pb-[35vh]">
              {result.lines.map((line, index) => (
                <LyricLineRow
                  key={`${line.timeMs}-${index}`}
                  index={index}
                  line={line}
                  active={index === activeIndex}
                  plain={!result.synced}
                  position={index === activeIndex ? position + offset : 0}
                  onSeek={seekTo}
                  registerRow={registerRow}
                  romanized={romanizedLines?.[index] ?? null}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 py-4">
              <p className="text-sm text-muted-foreground">No lyrics found for this track.</p>
              <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                Try again
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

const LyricLineRow = memo(function LyricLineRow({
  index,
  line,
  active,
  plain,
  position,
  onSeek,
  registerRow,
  romanized,
}: {
  index: number
  line: LyricLine
  active: boolean
  plain: boolean
  position: number
  onSeek: (line: LyricLine) => void
  registerRow: (index: number, node: HTMLDivElement | null) => void
  romanized: string | null
}) {
  // Stable ref callback: keeps parent re-renders from detaching/reattaching every row.
  const setRef = useCallback((node: HTMLDivElement | null) => registerRow(index, node), [registerRow, index])
  return (
    <div ref={setRef}>
      <LyricRow line={line} active={active} plain={plain} position={position} onSeek={onSeek} romanized={romanized} />
    </div>
  )
})

const LyricRow = memo(function LyricRow({
  line,
  active,
  plain,
  position,
  onSeek,
  romanized,
}: {
  line: LyricLine
  active: boolean
  plain: boolean
  position: number
  onSeek: (line: LyricLine) => void
  romanized: string | null
}) {
  const clickable = line.timeMs > 0
  const showRomanized = Boolean(romanized && romanized !== line.text)
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg px-2 py-1.5 transition-colors ${
        clickable ? "cursor-pointer hover:bg-muted/50" : ""
      } ${line.alignment === "end" ? "items-end text-right" : "items-start text-left"}`}
      onClick={() => clickable && onSeek(line)}
    >
      <div
        className={`flex flex-wrap gap-x-[0.28em] text-xl font-medium leading-snug ${
          line.text
            ? active
              ? "text-foreground"
              : plain
                ? "text-foreground/80"
                : "text-muted-foreground/55"
            : "text-muted-foreground/25"
        }`}
      >
        {!line.text ? (
          <span aria-label="Instrumental">♪</span>
        ) : active && line.words.length ? (
          line.words.map((word, index) => <SweepWord key={`${word.startMs}-${index}`} word={word} position={position} />)
        ) : (
          <span>{line.text}</span>
        )}
      </div>
      {showRomanized ? (
        <div className={`text-sm leading-snug ${active ? "text-muted-foreground" : "text-muted-foreground/45"}`}>
          {romanized}
        </div>
      ) : null}
      {line.background ? (
        <div
          className={`flex flex-wrap gap-x-[0.28em] text-sm leading-snug ${
            active ? "text-muted-foreground" : "text-muted-foreground/45"
          }`}
        >
          {active && line.background.words.length ? (
            line.background.words.map((word, index) => (
              <SweepWord key={`${word.startMs}-${index}`} word={word} position={position} />
            ))
          ) : (
            <span>{line.background.text}</span>
          )}
        </div>
      ) : null}
    </div>
  )
})

function SweepWord({ word, position }: { word: LyricWord; position: number }) {
  const sung = charsSungAt(word, position)
  const percent = word.text.length ? Math.max(0, Math.min(100, (sung / word.text.length) * 100)) : 0
  return (
    <span
      style={{
        backgroundImage: `linear-gradient(90deg, var(--foreground) ${percent}%, var(--muted-foreground) ${percent}%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
      }}
    >
      {word.text}
    </span>
  )
}

function charsSungAt(word: LyricWord, positionMs: number): number {
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
