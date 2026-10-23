import { app, Menu, Tray, nativeImage, globalShortcut, type BrowserWindow } from "electron"
import path from "node:path"
import type { PlayerState } from "../shared/types.ts"

let tray: Tray | null = null
let state: PlayerState = { playing: false, videoId: null, title: "Muzeec", artist: "" }
let lastKey = ""

function icon() {
  const file = path.join(import.meta.dirname, "../../resources/tray.png")
  const image = nativeImage.createFromPath(file)
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 })
}

function apply(): void {
  if (!tray) return
  tray.setToolTip(state.title ? `${state.title} — ${state.artist}` : "Muzeec")
  tray.setContextMenu(buildMenu())
}

export function updateTray(next: PlayerState): void {
  state = next
  // Presence reports include the playhead; do not rebuild the tray menu for
  // state that the tray cannot show.
  const key = `${state.playing}|${state.videoId ?? ""}|${state.title}|${state.artist}`
  if (key === lastKey) return
  lastKey = key
  apply()
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: state.title || "Nothing playing", enabled: false },
    { type: "separator" },
    { label: state.playing ? "Pause" : "Play", click: () => send("playpause") },
    { label: "Next", click: () => send("next") },
    { label: "Previous", click: () => send("previous") },
    { type: "separator" },
    { label: "Show Muzeec", click: () => show() },
    { label: "Quit", click: () => app.quit() },
  ])
}

let getWindow: (() => BrowserWindow | null) | null = null

function show(): void {
  const win = getWindow?.()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function send(action: "playpause" | "next" | "previous"): void {
  getWindow?.()?.webContents.send("sys:mediaKey", action)
}

export function createTray(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  tray = new Tray(icon())
  tray.on("click", show)
  apply()

  const shortcuts: Array<[string, "playpause" | "next" | "previous"]> = [
    ["MediaPlayPause", "playpause"],
    ["MediaNextTrack", "next"],
    ["MediaPreviousTrack", "previous"],
  ]
  for (const [accelerator, action] of shortcuts) {
    try {
      globalShortcut.register(accelerator, () => send(action))
    } catch {
      // Some Linux desktops reserve media keys; ignore.
    }
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  globalShortcut.unregisterAll()
}
