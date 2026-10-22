import { test } from "node:test"
import assert from "node:assert/strict"
import type { Track } from "../src/shared/types.ts"
import { HISTORY_LIMIT, initialHistory, nextInCycle } from "../src/renderer/player/sequence.ts"

const track = (id: string): Track => ({
  kind: "track",
  id,
  videoId: id,
  title: id,
  subtitle: "",
  thumbnail: null,
})

const cycle = [track("a"), track("b"), track("c")]
const ids = (tracks: Track[]) => tracks.map((entry) => entry.videoId)

test("Loop All wraps an album/playlist from the last track", () => {
  const pass = nextInCycle(cycle, "c", false)
  assert.equal(pass?.track.videoId, "a")
  assert.deepEqual(ids(pass?.upcoming ?? []), ["b", "c"])
})

test("Loop All keeps the full sequence when starting mid-album", () => {
  const pass = nextInCycle(cycle, "b", false)
  assert.equal(pass?.track.videoId, "c")
  assert.deepEqual(ids(pass?.upcoming ?? []), ["a", "b"])
})

test("Loop All keeps every track once when shuffling", () => {
  const pass = nextInCycle(cycle, "c", true)
  assert.equal(pass?.track.videoId, "a")
  assert.deepEqual([...ids(pass?.upcoming ?? [])].sort(), ["b", "c"])
})

test("starting a collection mid-list seeds previous with the songs before it", () => {
  const history = initialHistory(cycle, 2)
  assert.deepEqual(ids(history), ["a", "b"])
  // pop() walks backwards: b, then a.
  assert.equal(history.pop()?.videoId, "b")
  assert.equal(history.pop()?.videoId, "a")
})

test("starting a collection at its first song leaves previous empty", () => {
  assert.deepEqual(initialHistory(cycle, 0), [])
})

test("previous history keeps only the most recent songs", () => {
  const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => track(String(index)))
  const history = initialHistory(many, many.length)
  assert.equal(history.length, HISTORY_LIMIT)
  assert.equal(history.at(-1)?.videoId, String(many.length - 1))
  assert.equal(history[0]?.videoId, String(many.length - HISTORY_LIMIT))
})
