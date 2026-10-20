import { test } from "node:test"
import assert from "node:assert/strict"
import type { Track } from "../src/shared/types.ts"
import { useQueue } from "../src/renderer/lib/store/queue.ts"

const track = (id: string): Track => ({
  kind: "track",
  id,
  videoId: id,
  title: id,
  subtitle: "",
  thumbnail: null,
})

const ids = () => useQueue.getState().tracks.map((entry) => entry.videoId)

test("queue keeps only explicit additions and supports reorder/drain", () => {
  const queue = useQueue.getState()
  queue.clear()
  queue.append(track("a"))
  queue.append(track("b"))
  queue.addNext(track("c"))
  assert.deepEqual(ids(), ["c", "a", "b"])

  queue.move(0, 2)
  assert.deepEqual(ids(), ["a", "b", "c"])

  assert.equal(queue.takeNext()?.videoId, "a")
  assert.deepEqual(ids(), ["b", "c"])

  queue.remove(0)
  assert.deepEqual(ids(), ["c"])
  queue.clear()
  assert.deepEqual(ids(), [])
})

test("stepping back through history keeps the queue forward-consistent", () => {
  const queue = useQueue.getState()
  queue.clear()
  // Playlist [1,2,3,4], song 1 playing: the queue holds the upcoming songs.
  queue.replace([track("2"), track("3"), track("4")])
  assert.equal(queue.takeNext()?.videoId, "2")
  assert.equal(queue.takeNext()?.videoId, "3")
  assert.deepEqual(ids(), ["4"])

  // previous() from 3 to 2, then from 2 to 1.
  queue.prepend(track("3"))
  queue.prepend(track("2"))

  // next() must replay 2, not skip ahead to 4.
  assert.equal(queue.takeNext()?.videoId, "2")
  assert.equal(queue.takeNext()?.videoId, "3")
  assert.equal(queue.takeNext()?.videoId, "4")

  // Never duplicate a track that is already queued.
  queue.clear()
  queue.replace([track("a"), track("b")])
  queue.prepend(track("b"))
  assert.deepEqual(ids(), ["a", "b"])
  queue.clear()
})
