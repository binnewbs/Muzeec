import { test } from "node:test"
import assert from "node:assert/strict"
import { fadeGain } from "../src/renderer/player/fade.ts"

test("fadeGain starts at zero at the hand-off point", () => {
  assert.equal(fadeGain(0, 0, 4), 0)
})

test("fadeGain climbs linearly and clamps to 1", () => {
  assert.ok(Math.abs(fadeGain(1, 0, 4) - 0.25) < 1e-9)
  assert.equal(fadeGain(4, 0, 4), 1)
  assert.equal(fadeGain(10, 0, 4), 1)
})

test("fadeGain ignores a seek backwards past the start", () => {
  assert.equal(fadeGain(5, 5, 4), 0)
  assert.equal(fadeGain(3, 5, 4), 0)
})

test("fadeGain treats a zero-length window as fully faded", () => {
  assert.equal(fadeGain(0, 0, 0), 1)
})
