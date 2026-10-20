import { app, BrowserWindow } from "electron"
import path from "node:path"
import { registerProtocolCsp } from "./protocol.ts"
import { installSessionRewriters, ytSession } from "./youtube/session.ts"
import { registerIpc } from "./ipc.ts"
import { createMainWindow } from "./window.ts"
import { createTray, destroyTray } from "./tray.ts"
import { flushHistory } from "./youtube/history.ts"

app.commandLine.appendSwitch("disable-features", "Translate,MediaRouter,OptimizationHints")
app.commandLine.appendSwitch("disable-component-update")
app.setName("Muzeec")

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let quitting = false

  app.on("before-quit", () => {
    quitting = true
  })

  app.on("second-instance", () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    if (process.platform === "darwin") {
      app.dock?.setIcon(path.join(import.meta.dirname, "../../resources/icon.png"))
    }
    installSessionRewriters()
    registerProtocolCsp(ytSession(), !app.isPackaged)
    registerIpc()
    mainWindow = createMainWindow()
    mainWindow.on("close", (event) => {
      // Keep playing in the tray; Quit from the tray menu sets the flag above.
      if (quitting) return
      event.preventDefault()
      mainWindow?.hide()
    })
    mainWindow.on("closed", () => {
      mainWindow = null
    })
    createTray(() => mainWindow)

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      }
    })
  })

  app.on("before-quit", () => {
    flushHistory()
    destroyTray()
  })
}
