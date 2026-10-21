import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BOT_CHECK_MESSAGE,
  isBotCheck,
  isPermanent,
  pickFailureMessage,
  readableReason,
  type PlayerFailureReason,
} from "../src/main/youtube/player-failures.ts"

test("bot checks are detected whatever apostrophe YouTube sends", () => {
  assert.equal(isBotCheck("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot"), true)
  assert.equal(isBotCheck("LOGIN_REQUIRED", "Sign in to confirm you're not a bot"), true)
  assert.equal(isBotCheck("UNPLAYABLE", "Our systems have detected unusual traffic from your network."), true)
  assert.equal(isBotCheck("UNPLAYABLE", "Video unavailable"), false)
  assert.equal(isBotCheck("OK", "Sign in to confirm you’re not a bot"), false)
})

test("bot checks are not permanent verdicts", () => {
  assert.equal(isPermanent("Sign in to confirm you’re not a bot"), false)
  assert.equal(isPermanent("Video unavailable"), false)
  assert.equal(isPermanent("This video is not available in your country"), true)
  assert.equal(isPermanent("This video is private"), true)
})

test("readable reasons collapse whitespace", () => {
  assert.equal(readableReason("  Video\n\tunavailable  "), "Video unavailable")
})

test("a bot check outranks every other client failure", () => {
  const reasons: PlayerFailureReason[] = [
    { label: "WEB_REMIX", reason: "Video unavailable", kind: "playability" },
    { label: "MWEB", reason: "InnerTube player 404", kind: "request" },
    { label: "VISIONOS", reason: "Sign in to confirm you’re not a bot", kind: "bot" },
  ]
  assert.equal(pickFailureMessage(reasons), BOT_CHECK_MESSAGE)
})

test("the walk reports the most useful failure instead of the last one", () => {
  const reasons: PlayerFailureReason[] = [
    { label: "VISIONOS", reason: "no audio formats", kind: "formats" },
    { label: "WEB_REMIX", reason: "Video unavailable", kind: "playability" },
    { label: "MWEB", reason: "InnerTube player 404", kind: "request" },
  ]
  assert.equal(pickFailureMessage(reasons), "WEB_REMIX: Video unavailable")
  assert.equal(
    pickFailureMessage([{ label: "MWEB", reason: "InnerTube player 404", kind: "request" }]),
    "MWEB: InnerTube player 404",
  )
  assert.equal(pickFailureMessage([]), null)
})
