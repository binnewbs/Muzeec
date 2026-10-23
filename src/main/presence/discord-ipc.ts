import { randomUUID } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

export const OP_HANDSHAKE = 0
export const OP_FRAME = 1
export const OP_CLOSE = 2
export const OP_PING = 3
export const OP_PONG = 4

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const IPC_SLOTS = 10

export type DiscordFrame = { op: number; data: unknown }

export function encodeFrame(op: number, data: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(data), "utf8")
  const header = Buffer.allocUnsafe(8)
  header.writeUInt32LE(op, 0)
  header.writeUInt32LE(body.byteLength, 4)
  return Buffer.concat([header, body])
}

/** Incremental decoder; Discord frames can be split across socket reads. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): DiscordFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames: DiscordFrame[] = []

    while (this.buffer.length >= 8) {
      const op = this.buffer.readUInt32LE(0)
      const length = this.buffer.readUInt32LE(4)
      if (length > MAX_FRAME_BYTES) throw new Error("Discord IPC frame is too large")
      if (this.buffer.length < 8 + length) break

      const body = this.buffer.subarray(8, 8 + length)
      this.buffer = this.buffer.subarray(8 + length)

      let data: unknown = null
      if (length > 0) {
        try {
          data = JSON.parse(body.toString("utf8"))
        } catch {
          data = null
        }
      }
      frames.push({ op, data })
    }

    return frames
  }
}

/**
 * Discord looks for its local socket in the runtime directory first, then the
 * temporary directories. Flatpak and Snap installs expose it under a sandbox
 * path instead.
 */
export function socketPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    return Array.from({ length: IPC_SLOTS }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`)
  }

  const roots: string[] = []
  const addRoot = (value: string | undefined) => {
    if (value && !roots.includes(value)) roots.push(value)
  }
  addRoot(env.XDG_RUNTIME_DIR)
  addRoot(env.TMPDIR)
  addRoot(env.TMP)
  addRoot(env.TEMP)
  addRoot("/tmp")

  const paths: string[] = []
  for (const root of roots) {
    for (let index = 0; index < IPC_SLOTS; index++) {
      paths.push(path.join(root, `discord-ipc-${index}`))
    }
  }

  const runtime = env.XDG_RUNTIME_DIR?.trim()
  if (runtime) {
    for (const app of ["com.discordapp.Discord", "com.discordapp.DiscordCanary"]) {
      for (let index = 0; index < IPC_SLOTS; index++) {
        paths.push(path.join(runtime, "app", app, `discord-ipc-${index}`))
      }
    }
    for (let index = 0; index < IPC_SLOTS; index++) {
      paths.push(path.join(runtime, "snap.discord", `discord-ipc-${index}`))
    }
  }

  return [...new Set(paths)]
}

function openSocket(target: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.removeListener("connect", onConnect)
      socket.removeListener("error", onError)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        resolve(socket)
      }
    }

    const onConnect = () => finish()
    const onError = (error: Error) => finish(error)
    timer = setTimeout(() => finish(new Error("Connection timed out")), timeoutMs)
    timer.unref?.()
    socket.once("connect", onConnect)
    socket.once("error", onError)
  })
}

export type DiscordIpcOptions = {
  /** Overridable for tests. */
  paths?: string[]
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DiscordIpcClient {
  private socket: net.Socket | null = null
  private decoder = new FrameDecoder()
  private pending = new Map<string, PendingRequest>()
  private ready: { resolve: () => void; reject: (error: Error) => void } | null = null
  private readonly clientId: string
  private readonly paths: string[] | undefined
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor(clientId: string, options: DiscordIpcOptions = {}) {
    this.clientId = clientId
    this.paths = options.paths
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed)
  }

  async connect(): Promise<void> {
    if (this.connected) return

    const candidates = this.paths ?? socketPaths()
    // Unix sockets can be checked cheaply, which avoids waiting on ~100 paths
    // when Discord is not installed.
    const available =
      process.platform === "win32"
        ? candidates
        : candidates.filter((candidate) => fs.existsSync(candidate))

    let lastError: Error | null = null
    for (const candidate of available) {
      let socket: net.Socket
      try {
        socket = await openSocket(candidate, this.connectTimeoutMs)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }

      try {
        await this.attach(socket)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.fail(lastError)
      }
    }

    throw new Error(
      lastError ? `Discord IPC is unavailable: ${lastError.message}` : "Discord IPC socket not found",
    )
  }

  private attach(socket: net.Socket): Promise<void> {
    this.socket = socket
    this.decoder = new FrameDecoder()
    socket.on("data", (chunk: Buffer) => this.onData(chunk))
    socket.on("error", (error: Error) => this.fail(error))
    socket.on("close", () => this.fail(new Error("Discord IPC closed")))

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = null
        reject(new Error("Discord handshake timed out"))
      }, this.connectTimeoutMs)
      timer.unref?.()

      this.ready = {
        resolve: () => {
          clearTimeout(timer)
          this.ready = null
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          this.ready = null
          reject(error)
        },
      }

      socket.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.clientId }))
    })
  }

  private onData(chunk: Buffer): void {
    let frames: DiscordFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }

    for (const frame of frames) {
      if (frame.op === OP_PING) {
        this.socket?.write(encodeFrame(OP_PONG, frame.data ?? {}))
        continue
      }
      if (frame.op === OP_CLOSE) {
        this.fail(new Error("Discord closed the IPC connection"))
        return
      }
      if (frame.op !== OP_FRAME) continue

      const payload = frame.data as {
        cmd?: string
        evt?: string
        nonce?: string
        data?: unknown
      } | null
      if (!payload) continue

      if (payload.evt === "READY") {
        this.ready?.resolve()
        continue
      }

      if (payload.evt === "ERROR") {
        const nonce = payload.nonce
        const pending = nonce ? this.pending.get(nonce) : undefined
        if (pending && nonce) {
          this.pending.delete(nonce)
          clearTimeout(pending.timer)
          const error = payload.data as { code?: number; message?: string } | null
          pending.reject(new Error(error?.message || "Discord rejected the request"))
        }
        continue
      }

      const nonce = payload.nonce
      const pending = nonce ? this.pending.get(nonce) : undefined
      if (pending && nonce) {
        this.pending.delete(nonce)
        clearTimeout(pending.timer)
        pending.resolve(payload.data)
      }
    }
  }

  private fail(reason: Error): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      // Removing listeners first keeps the destroy-triggered close from
      // recursing into this method.
      socket.removeAllListeners()
      socket.destroy()
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()

    this.ready?.reject(reason)
    this.ready = null
  }

  request<T = unknown>(cmd: string, args: unknown): Promise<T> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error("Discord IPC is not connected"))

    const nonce = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce)
        reject(new Error(`Discord ${cmd} timed out`))
      }, this.requestTimeoutMs)
      timer.unref?.()

      this.pending.set(nonce, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      socket.write(encodeFrame(OP_FRAME, { cmd, args, nonce }))
    })
  }

  setActivity(activity: unknown | null): Promise<void> {
    const args = activity === null ? { pid: process.pid } : { pid: process.pid, activity }
    return this.request("SET_ACTIVITY", args).then(() => undefined)
  }

  close(): void {
    const socket = this.socket
    if (!socket) return

    try {
      socket.end(encodeFrame(OP_CLOSE, {}))
    } catch {
      // The socket may already be gone.
    }
    this.socket = null
    socket.removeAllListeners()
    socket.destroy()

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Discord IPC closed"))
    }
    this.pending.clear()

    this.ready?.reject(new Error("Discord IPC closed"))
    this.ready = null
  }
}
