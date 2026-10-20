import { test } from "node:test"
import assert from "node:assert/strict"
import type { Track } from "../src/shared/types.ts"
import { nextInCycle } from "../src/renderer/player/sequence.ts"

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
