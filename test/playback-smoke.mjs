import { app, BrowserWindow } from "electron"

process.env.NODE_ENV = "production"

await import("../out/main/index.js")

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const win = BrowserWindow.getAllWindows()[0]
  const result = await win.webContents.executeJavaScript(`(async () => {
    const search = await window.muzeec.search({ query: "lofi hip hop" })
    if (!search.ok) return { step: "search", error: search.error }
    const items = search.data.shelves.flatMap((shelf) => shelf.items)
    const track = items.find((item) => item.kind === "track")
    if (!track) return { step: "pick", error: "no track in search results" }
    const decision = await window.muzeec.player({ videoId: track.id })
    if (!decision.ok) return { step: "player", video: track.title, error: decision.error }
    const audio = new Audio(decision.data.url)
    const probe = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ event: "timeout" }), 10000)
      audio.addEventListener("canplay", () => { clearTimeout(timer); resolve({ event: "canplay", duration: audio.duration }) })
      audio.addEventListener("error", () => { clearTimeout(timer); resolve({ event: "error", code: audio.error?.code }) })
      audio.load()
    })
    return { step: "ok", video: track.title, client: decision.data.client, mimeType: decision.data.mimeType, probe }
  })()`)
  console.log("PLAYBACK", JSON.stringify(result, null, 2))
  app.exit(result.step === "ok" ? 0 : 1)
})
