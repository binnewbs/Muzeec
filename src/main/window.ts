import { BrowserWindow, dialog, shell } from "electron"
import path from "node:path"
import type { AuthState } from "../shared/types.ts"
import { YT_PARTITION } from "./youtube/session.ts"
import { authState, captureSession, type CapturedConfig } from "./youtube/auth.ts"

const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === "development"

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      partition: YT_PARTITION,
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  })

  win.once("ready-to-show", () => win.show())
  const sendMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send("sys:windowMaximized", win.isMaximized())
  }
  win.on("maximize", sendMaximized)
  win.on("unmaximize", sendMaximized)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  const load = isDev && devUrl ? win.loadURL(devUrl) : win.loadURL("app://muzeec/index.html")
  load.catch((error) => console.error("Failed to load renderer", error))

  return win
}

const CAPTURE = `(() => {
  if (!window.ytcfg || !window.ytcfg.get) return null;
  const get = (k) => {
    const v = window.ytcfg.get(k);
    return v === undefined || v === null || v === "" ? null : String(v);
  };
  return {
    loggedIn: String(window.ytcfg.get("LOGGED_IN")),
    authUser: get("SESSION_INDEX"),
    pageId: get("DELEGATED_SESSION_ID"),
    dataSyncId: get("DATASYNC_ID"),
    visitorData: get("VISITOR_DATA"),
    clientVersion: get("INNERTUBE_CLIENT_VERSION")
  };
})()`

/** Google sign-in runs in its own window with no Node access (DOC §7.2). */
export async function openLogin(parent: BrowserWindow): Promise<AuthState> {
  const authWin = new BrowserWindow({
    width: 520,
    height: 760,
    parent,
    modal: true,
    show: false,
    title: "Sign in to YouTube Music",
    webPreferences: {
      partition: YT_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  authWin.once("ready-to-show", () => authWin.show())

  return new Promise<AuthState>((resolve, reject) => {
    let settled = false
    let prompted = false
    let lastConfig: CapturedConfig | null = null

    const finish = async (config: CapturedConfig) => {
      if (settled) return
      settled = true
      try {
        await captureSession(config)
        authWin.destroy()
        resolve(await authState())
      } catch (error) {
        settled = false
        void dialog.showMessageBox(authWin, {
          type: "error",
          message: "Sign-in could not be completed",
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const inspect = async () => {
      if (settled || authWin.isDestroyed()) return
      const url = authWin.webContents.getURL()
      if (!url.startsWith("https://music.youtube.com")) return
      try {
        const config = (await authWin.webContents.executeJavaScript(CAPTURE)) as
          | (CapturedConfig & { loggedIn: string })
          | null
        if (!config || config.loggedIn !== "true" || !config.authUser) return
        lastConfig = config
        if (!prompted) {
          prompted = true
          const { response } = await dialog.showMessageBox(authWin, {
            type: "question",
            buttons: ["Continue", "Switch account"],
            defaultId: 0,
            cancelId: 1,
            message: "Signed in to YouTube Music",
            detail: "Use this account? Choose “Switch account” if you still need to pick a channel.",
          })
          if (response === 0) await finish(config)
          else prompted = false
        }
      } catch {
        // Page not ready; retry on the next tick.
      }
    }

    const timer = setInterval(() => void inspect(), 1500)
    authWin.webContents.on("did-navigate", () => void inspect())
    authWin.webContents.on("did-finish-load", () => void inspect())

    authWin.on("closed", () => {
      clearInterval(timer)
      if (settled) return
      settled = true
      if (lastConfig) {
        void captureSession(lastConfig).then(
          () => authState().then(resolve, reject),
          reject,
        )
      } else {
        reject(new Error("Sign-in cancelled"))
      }
    })

    void authWin.loadURL(
      "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&prompt=select_account&continue=https%3A%2F%2Fmusic.youtube.com%2F",
    )
  })
}
