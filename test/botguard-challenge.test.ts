import assert from "node:assert/strict"
import test from "node:test"
import { parseChallenge, parseIntegrityToken } from "../src/main/youtube/botguard-challenge.ts"

const interpreter = "var botguard = {};"
const challenge = [
  "message-id",
  [null, interpreter],
  null,
  "interpreter-hash",
  "program-source",
  "botguardGlobal",
  null,
  "experiments-blob",
]

function scramble(value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value), "utf8")
  for (let index = 0; index < bytes.length; index++) bytes[index] = (bytes[index] - 97) & 0xff
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".")
}

test("parses a plain challenge array", () => {
  assert.deepEqual(parseChallenge([challenge]), {
    interpreterJavascript: interpreter,
    interpreterHash: "interpreter-hash",
    program: "program-source",
    globalName: "botguardGlobal",
    clientExperimentsStateBlob: "experiments-blob",
  })
})

test("parses a scrambled challenge response", () => {
  const parsed = parseChallenge([null, scramble(challenge)])
  assert.equal(parsed?.interpreterJavascript, interpreter)
  assert.equal(parsed?.program, "program-source")
  assert.equal(parsed?.globalName, "botguardGlobal")
})

test("rejects a challenge without an interpreter", () => {
  const withoutInterpreter = [...challenge]
  withoutInterpreter[1] = [null]
  assert.equal(parseChallenge([withoutInterpreter]), null)
  assert.equal(parseChallenge(null), null)
  assert.equal(parseChallenge([null, "not-base64-json"]), null)
})

test("parses an integrity token and its lifetime", () => {
  const raw = Buffer.from([1, 2, 3, 250, 251]).toString("base64url")
  const parsed = parseIntegrityToken([raw, 21_600])
  assert.deepEqual([...(parsed?.token ?? [])], [1, 2, 3, 250, 251])
  assert.equal(parsed?.ttlSeconds, 21_600)
})

test("defaults a missing lifetime and rejects an empty token", () => {
  const raw = Buffer.from([9, 8, 7]).toString("base64url")
  assert.equal(parseIntegrityToken([raw])?.ttlSeconds, 3600)
  assert.equal(parseIntegrityToken(["", 600]), null)
  assert.equal(parseIntegrityToken({ token: raw }), null)
})
