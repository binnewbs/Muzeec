import { test } from "node:test"
import assert from "node:assert/strict"
import {
  addSearchHistory,
  normalizeSearchHistory,
  SEARCH_HISTORY_LIMIT,
} from "../src/shared/search-history.ts"

test("search history keeps newest first and de-dupes case-insensitively", () => {
  const history = ["Radiohead", "Björk", "Portishead"]
  const next = addSearchHistory(history, "  björk  ")
  assert.deepEqual(next, ["björk", "Radiohead", "Portishead"])

  const repeated = addSearchHistory(next, "RADIOHEAD")
  assert.deepEqual(repeated, ["RADIOHEAD", "björk", "Portishead"])
})

test("search history ignores short and empty terms", () => {
  assert.deepEqual(addSearchHistory(["one"], "a"), ["one"])
  assert.deepEqual(addSearchHistory(["one"], "   "), ["one"])
})

test("search history is capped", () => {
  const history = Array.from({ length: SEARCH_HISTORY_LIMIT }, (_, index) => `term ${index}`)
  const next = addSearchHistory(history, "newest")
  assert.equal(next.length, SEARCH_HISTORY_LIMIT)
  assert.equal(next[0], "newest")
  assert.equal(next.at(-1), `term ${SEARCH_HISTORY_LIMIT - 2}`)
})

test("stored search history is normalized and de-duped", () => {
  const stored = normalizeSearchHistory([
    "  Radiohead ",
    "radiohead",
    "",
    "x",
    42,
    "Portishead",
    ...Array.from({ length: SEARCH_HISTORY_LIMIT + 3 }, (_, index) => `term ${index}`),
  ])
  assert.equal(stored.length, SEARCH_HISTORY_LIMIT)
  assert.deepEqual(stored.slice(0, 2), ["Radiohead", "Portishead"])
  assert.equal(new Set(stored.map((term) => term.toLowerCase())).size, stored.length)
})

test("non-array settings values do not produce a history", () => {
  assert.deepEqual(normalizeSearchHistory("Radiohead"), [])
  assert.deepEqual(normalizeSearchHistory(null), [])
})
