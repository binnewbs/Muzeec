import { test } from "node:test"
import assert from "node:assert/strict"
import { sapisidHash } from "../src/main/youtube/sapisid.ts"

test("SAPISIDHASH matches the documented format", () => {
  assert.equal(
    sapisidHash("secret", "https://music.youtube.com", 1_700_000_000_000),
    "SAPISIDHASH 1700000000_d2a0deeb95ea263a68778d9e9ac8840dce59d800",
  )
})
