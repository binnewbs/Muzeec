import type { PlayerState } from "../../shared/types.ts"
import { presenceActivity } from "./activity.ts"
import {
  DISCORD_CLIENT_ID,
  PROJECT_URL,
  RECONNECT_INTERVAL_MS,
  UPDATE_INTERVAL_MS,
} from "./config.ts"
import { DiscordIpcClient } from "./discord-ipc.ts"

let client: DiscordIpcClient | null = null
let enabled = false
let latest: PlayerState | null = null
let lastSentAt = 0
let lastPayload = ""
let updateTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let connecting: Promise<boolean> | null = null
let lastConnectAttempt = 0
let flushing = false

export function presenceAvailable(): boolean {
  return DISCORD_CLIENT_ID.length > 0
}

/** Called at startup and whenever the Settings toggle changes. */
export function configurePresence(next: boolean): void {
  const active = next && presenceAvailable()
  if (active === enabled) return

  enabled = active
  lastPayload = ""
  lastSentAt = 0

  if (!active) {
    stopTimers()
    disconnect()
    return
  }

  void ensureConnected().then((connected) => {
    if (connected) scheduleUpdate(0)
    else scheduleRetry()
  })
}

/** Called for every player-state report from the renderer. */
export function updatePresence(state: PlayerState): void {
  latest = state
  if (!enabled) return

  void ensureConnected().then((connected) => {
    if (connected) scheduleUpdate()
    else scheduleRetry()
  })
}

/** Clears the card and closes the socket on quit. */
export function destroyPresence(): void {
  enabled = false
  stopTimers()
  disconnect()
}

async function ensureConnected(): Promise<boolean> {
  if (!enabled || !presenceAvailable()) return false
  if (client?.connected) return true

  if (client) {
    client.close()
    client = null
  }
  if (connecting) return connecting
  // Avoid probing the socket on every seek/play event while Discord is closed.
  if (Date.now() - lastConnectAttempt < 10_000) return false
  lastConnectAttempt = Date.now()

  connecting = (async () => {
    const next = new DiscordIpcClient(DISCORD_CLIENT_ID)
    try {
      await next.connect()
      if (!enabled) {
        next.close()
        return false
      }
      client = next
      return true
    } catch {
      next.close()
      return false
    } finally {
      connecting = null
    }
  })()

  return connecting
}

function scheduleUpdate(delay?: number): void {
  if (!enabled) return
  if (updateTimer) clearTimeout(updateTimer)

  const wait = delay ?? Math.max(0, lastSentAt + UPDATE_INTERVAL_MS - Date.now())
  updateTimer = setTimeout(() => {
    updateTimer = null
    void flush()
  }, wait)
  updateTimer.unref?.()
}

async function flush(): Promise<void> {
  if (!enabled || !latest || flushing) return

  const activity = presenceActivity(latest, { projectUrl: PROJECT_URL })
  const serialized = JSON.stringify(activity)
  if (serialized === lastPayload) return

  flushing = true
  let sent = false
  try {
    if (!(await ensureConnected())) {
      scheduleRetry()
      return
    }
    const current = client
    if (!current) {
      scheduleRetry()
      return
    }
    await current.setActivity(activity)
    lastPayload = serialized
    lastSentAt = Date.now()
    sent = true
  } catch {
    const current = client
    client = null
    current?.close()
    scheduleRetry()
  } finally {
    flushing = false
    // A track change can land while a send is in flight. Publish it after the
    // rate-limit window instead of dropping it.
    if (sent && enabled && latest) {
      const pending = JSON.stringify(presenceActivity(latest, { projectUrl: PROJECT_URL }))
      if (pending !== lastPayload) scheduleUpdate()
    }
  }
}

function scheduleRetry(): void {
  if (!enabled || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!enabled) return
    void ensureConnected().then((connected) => {
      if (connected) scheduleUpdate(0)
      else scheduleRetry()
    })
  }, RECONNECT_INTERVAL_MS)
  retryTimer.unref?.()
}

function stopTimers(): void {
  if (updateTimer) {
    clearTimeout(updateTimer)
    updateTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function disconnect(): void {
  const current = client
  client = null
  if (!current) return
  // Best effort: the socket closing clears the card even if this never lands.
  void current.setActivity(null).catch(() => undefined).finally(() => current.close())
}
