import { test } from "node:test"
import assert from "node:assert/strict"
import { parseLyricsPayload, parseLrc, parseTtml, normalizeLyrics } from "../src/main/lyrics/parse.ts"
import { forLyricsSearch, artistForLyricsSearch, versionCompatible } from "../src/main/lyrics/matching.ts"

test("TTML merges adjacent syllables, keeps background vocals separate", () => {
  const lines = parseTtml(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
    <body><div>
      <p begin="1.0" end="2.0" ttm:agent="v1"><span begin="1.0" end="1.2">e</span><span begin="1.2" end="1.5">nough</span> <span begin="1.5" end="1.8" ttm:role="x-bg">(ooh)</span></p>
      <p begin="2.5" end="3.0" ttm:agent="v2">Second voice</p>
    </div></body>
  </tt>`)
  const parsed = normalizeLyrics("test", "Test", lines)
  assert.equal(parsed.lines[0].words[0].text, "enough")
  assert.equal(parsed.lines[0].background?.text, "(ooh)")
  assert.equal(parsed.lines[1].alignment, "end")
  assert.equal(parsed.wordSynced, true)
})

test("enhanced LRC merges syllables into words and keeps timestamps", () => {
  const lines = parseLrc("[00:01.00]<00:01.00>Hel<00:01.20>lo <00:01.50>world")
  const parsed = normalizeLyrics("test", "Test", lines)
  assert.equal(parsed.lines[0].words[0].text, "Hello")
  assert.equal(parsed.lines[0].words[1].text, "world")
  assert.equal(parsed.lines[0].words[0].startMs, 1000)
})

test("line-synced TTML stays line-synced", () => {
  const lines = parseTtml(
    `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.0" end="3.0">Just a line</p></div></body></tt>`,
  )
  const parsed = normalizeLyrics("test", "Test", lines)
  assert.equal(parsed.lines[0].words.length, 0)
  assert.equal(parsed.synced, true)
  assert.equal(parsed.wordSynced, false)
})

test("TTML handles nested spans without leaking closing tags", () => {
  const [line] = parseTtml(
    `<tt><body><div><p begin="1" end="5"><span begin="1" end="2">Family</span> <span begin="2" end="5">ties <span begin="3" end="4">(yeah)</span></span></p></div></body></tt>`,
  )
  assert.equal(line.text, "Family ties (yeah)")
  assert.deepEqual(
    line.words.map((word) => word.text),
    ["Family", "ties", "(yeah)"],
  )
  assert.ok(!line.text.includes("/span>"))
})

test("TTML keeps nested background vocals together", () => {
  const [line] = parseTtml(
    `<tt><body><div><p begin="6" end="8"><span ttm:role="x-bg" begin="6" end="8"><span begin="6" end="7">back</span> <span begin="7" end="8">ground</span></span></p></div></body></tt>`,
  )
  assert.equal(line.text, "")
  assert.equal(line.background?.text, "back ground")
  assert.deepEqual(
    line.background?.words.map((word) => word.text),
    ["back", "ground"],
  )
})

test("TTML ignores stray closing span tags", () => {
  const [line] = parseTtml(
    `<tt><body><div><p begin="1" end="2"><span begin="1" end="2">word</span></span></p></div></body></tt>`,
  )
  assert.equal(line.text, "word")
  assert.deepEqual(
    line.words.map((word) => word.text),
    ["word"],
  )
})

test("JSON envelopes are unwrapped before parsing", () => {
  const lines = parseLyricsPayload(JSON.stringify({ syncedLyrics: "[00:02.00]Hello\n[00:03.00]World" }))
  assert.equal(lines?.[0].text, "Hello")
  assert.equal(lines?.[1].timeMs, 3000)
})

test("lrc.red-style matching rejects a live edit", () => {
  assert.equal(versionCompatible("Get Lucky", "Get Lucky (Live)"), false)
  assert.equal(versionCompatible("Get Lucky", "Get Lucky (Remastered 2011)"), true)
})

test("query cleaning strips packaging but keeps versions", () => {
  assert.equal(forLyricsSearch("Get Lucky (feat. Pharrell) [Official Video]"), "Get Lucky")
  assert.equal(forLyricsSearch("Get Lucky (Live)"), "Get Lucky (Live)")
  assert.equal(artistForLyricsSearch("Daft Punk - Topic"), "Daft Punk")
})

test("instrumental gaps start when the previous line ends", () => {
  const lines = [
    {
      timeMs: 1000,
      text: "Singing",
      words: [{ startMs: 1000, endMs: 5000, text: "Singing", syllables: [] }],
      alignment: "start" as const,
      sungUntilMs: 5000,
    },
    {
      timeMs: 12_000,
      text: "Again",
      words: [],
      alignment: "start" as const,
      sungUntilMs: null,
    },
  ]
  const parsed = normalizeLyrics("test", "Test", lines)
  assert.equal(parsed.lines[1].text, "")
  assert.equal(parsed.lines[1].timeMs, 5000)
})
