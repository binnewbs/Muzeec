import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  FrameDecoder,
  DiscordIpcClient,
  OP_FRAME,
  OP_HANDSHAKE,
  OP_PING,
  encodeFrame,
  socketPaths,
} from "../src/main/presence/discord-ipc.ts"
import { presenceActivity, truncate } from "../src/main/presence/activity.ts"
import type { PlayerState } from "../src/shared/types.ts"

const base: PlayerState = {
  playing: true,
  videoId: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  artist: "Rick Astley",
  album: "Whenever You Need Somebody",
  thumbnail: "https://lh3.googleusercontent.com/cover.jpg",
  duration: 213,
  position: 42,
}

test("truncate caps text without leaving a trailing space", () => {
  assert.equal(truncate("short", 10), "short")
  assert.equal(truncate("  padded  ", 10), "padded")
  assert.equal(truncate("abcdefghij", 5), "abcd…")
})

test("presenceActivity builds a listening card with a progress window", () => {
  const activity = presenceActivity(base, { now: 1_700_000_000_000 })

  assert.ok(activity)
  assert.equal(activity.type, 2)
  assert.equal(activity.details, "Never Gonna Give You Up")
  assert.equal(activity.state, "Rick Astley")
  assert.equal(activity.details_url, "https://music.youtube.com/watch?v=dQw4w9WgXcQ")
  assert.deepEqual(activity.timestamps, {
    start: 1_699_999_958,
    end: 1_700_000_171,
  })
  assert.equal(activity.assets.large_image, "https://lh3.googleusercontent.com/cover.jpg")
  assert.equal(activity.assets.large_text, "Whenever You Need Somebody")
  assert.equal(activity.assets.small_text, "Playing")
  assert.equal(activity.buttons?.[0]?.url, "https://music.youtube.com/watch?v=dQw4w9WgXcQ")
  assert.equal(activity.buttons?.length, 1)
})

test("pausing removes the progress window", () => {
  const activity = presenceActivity({ ...base, playing: false })

  assert.ok(activity)
  assert.equal(activity.timestamps, undefined)
  assert.equal(activity.assets.small_image, "paused")
  assert.equal(activity.assets.small_text, "Paused")
})

test("a missing or unsafe thumbnail falls back to the app asset", () => {
  for (const thumbnail of [null, "http://example.com/cover.jpg", ""]) {
    const activity = presenceActivity({ ...base, thumbnail })
    assert.ok(activity)
    assert.equal(activity.assets.large_image, "muzeec")
  }
})

test("long titles, artists and albums stay inside Discord's limits", () => {
  const activity = presenceActivity({
    ...base,
    title: "t".repeat(400),
    artist: "a".repeat(400),
    album: "b".repeat(400),
  })

  assert.ok(activity)
  assert.ok(activity.details.length <= 128)
  assert.ok(activity.state.length <= 128)
  assert.ok(activity.assets.large_text!.length <= 128)
})

test("an optional project URL adds a second button", () => {
  const activity = presenceActivity(base, { projectUrl: "https://github.com/example/muzeec" })

  assert.equal(activity?.buttons?.length, 2)
  assert.equal(activity?.buttons?.[1]?.label, "Get Muzeec")
})

test("no current track clears the presence", () => {
  assert.equal(presenceActivity({ ...base, videoId: null, title: "" }), null)
})

test("socketPaths covers Discord, Flatpak and Snap locations", () => {
  const windows = socketPaths("win32", {})
  assert.equal(windows.length, 10)
  assert.equal(windows[0], "\\\\?\\pipe\\discord-ipc-0")

  const linux = socketPaths("linux", {
    XDG_RUNTIME_DIR: "/run/user/1000",
    TMPDIR: "/tmp/custom",
  })
  assert.equal(linux[0], "/run/user/1000/discord-ipc-0")
  assert.ok(linux.includes("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0"))
  assert.ok(linux.includes("/run/user/1000/snap.discord/discord-ipc-0"))
  assert.ok(linux.includes("/tmp/custom/discord-ipc-0"))
})

test("FrameDecoder handles split and concatenated frames", () => {
  const first = encodeFrame(OP_FRAME, { cmd: "DISPATCH", evt: "READY" })
  const second = encodeFrame(OP_PING, {})

  const decoder = new FrameDecoder()
  assert.deepEqual(decoder.push(first.subarray(0, 3)), [])

  const frames = decoder.push(Buffer.concat([first.subarray(3), second]))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].op, OP_FRAME)
  assert.deepEqual(frames[0].data, { cmd: "DISPATCH", evt: "READY" })
  assert.equal(frames[1].op, OP_PING)
})

test("the IPC client handshakes, sets and clears an activity", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket fixture")
    return
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muzeec-discord-"))
  const socketPath = path.join(directory, "discord-ipc-0")
  const received: Array<{ cmd?: string; args?: Record<string, unknown> }> = []

  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder()
    socket.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      for (const frame of decoder.push(buffer)) {
        if (frame.op === OP_HANDSHAKE) {
          socket.write(
            encodeFrame(OP_FRAME, {
              cmd: "DISPATCH",
              evt: "READY",
              data: { v: 1, config: {}, user: { id: "1", username: "test" } },
            }),
          )
          continue
        }
        if (frame.op !== OP_FRAME) continue
        const payload = frame.data as { cmd?: string; nonce?: string; args?: Record<string, unknown> }
        received.push(payload)
        socket.write(encodeFrame(OP_FRAME, { cmd: payload.cmd, data: null, nonce: payload.nonce }))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  const client = new DiscordIpcClient("123456789", { paths: [socketPath] })
  t.after(() => {
    client.close()
    server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await client.connect()
  assert.equal(client.connected, true)

  const activity = presenceActivity(base)
  assert.ok(activity)
  await client.setActivity(activity)
  await client.setActivity(null)

  assert.equal(received.length, 2)
  assert.equal(received[0]?.cmd, "SET_ACTIVITY")
  assert.equal(received[0]?.args?.pid, process.pid)
  assert.deepEqual(received[0]?.args?.activity, activity)
  assert.equal(received[1]?.cmd, "SET_ACTIVITY")
  assert.equal(received[1]?.args?.activity, undefined)
})
