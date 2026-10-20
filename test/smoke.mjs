import { app, BrowserWindow } from "electron"

process.env.NODE_ENV = "production"

const errors = []
app.on("browser-window-created", (_event, win) => {
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })
  win.webContents.on("did-fail-load", (_e, code, desc) => errors.push(`load failed ${code} ${desc}`))
})

await import("../out/main/index.js")

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log("SMOKE no window")
    app.exit(1)
    return
  }
  try {
    const info = await win.webContents.executeJavaScript(`({
      url: location.href,
      hasBridge: typeof window.muzeec === "object",
      text: document.body.innerText.slice(0, 400),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dark: document.documentElement.classList.contains("dark")
    })`)
    console.log("SMOKE", JSON.stringify(info, null, 2))
    console.log("SMOKE errors", JSON.stringify(errors, null, 2))
    app.exit(errors.length ? 2 : 0)
  } catch (error) {
    console.log("SMOKE failed", error)
    app.exit(1)
  }
})
