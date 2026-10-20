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
