import { test } from "node:test"
import assert from "node:assert/strict"
import { integratedLoudness, normalizationGainDb, normalizationGain } from "../src/shared/loudness.ts"

test("reads BS.1770 integrated loudness from stream metadata", () => {
  assert.equal(integratedLoudness({ trackAbsoluteLoudnessLkfs: -10.86, loudnessDb: 3.14 }), -10.86)
  assert.ok(Math.abs((integratedLoudness({ loudnessDb: 3.14 }) ?? 0) + 10.86) < 1e-9)
  assert.equal(integratedLoudness({ perceptualLoudnessDb: -12.5 }), -12.5)
  assert.equal(integratedLoudness({ trackAbsoluteLoudnessLkfs: -14, loudnessDb: 0 }), -14)
  assert.equal(integratedLoudness({}), null)
  assert.equal(integratedLoudness({ trackAbsoluteLoudnessLkfs: null, loudnessDb: null }), null)
  assert.equal(integratedLoudness({ trackAbsoluteLoudnessLkfs: 5 }), null)
})

test("normalization targets -14 LUFS", () => {
  assert.equal(normalizationGainDb(-14), 0)
  assert.equal(normalizationGainDb(-10), -4)
  assert.equal(normalizationGainDb(-20), 6)
  assert.equal(normalizationGainDb(null), 0)
  assert.equal(normalizationGain(-14), 1)
  assert.ok(Math.abs(normalizationGain(-10) - 0.6309573444801932) < 1e-12)
})
