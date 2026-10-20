import { net, protocol, type Session } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"

const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer")

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

/** app:// is registered per session: the UI window uses the persist:youtube partition (DOC §5, §6.2). */
export function registerProtocolCsp(sess: Session, dev: boolean): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'" + (dev ? " 'unsafe-inline'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.googleusercontent.com https://*.ggpht.com https://*.ytimg.com https://*.gstatic.com",
    "media-src 'self' blob: https://*.googlevideo.com",
    "connect-src 'self' blob: https://*.googlevideo.com" + (dev ? " ws://localhost:* http://localhost:*" : ""),
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ")

  sess.protocol.handle("app", async (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html"
    const resolved = path.resolve(RENDERER_ROOT, relative)
    // Path traversal guard.
    const target = resolved.startsWith(RENDERER_ROOT + path.sep) ? resolved : path.join(RENDERER_ROOT, "index.html")
    try {
      const response = await net.fetch(pathToFileURL(target).toString(), { headers: request.headers })
      const headers = new Headers(response.headers)
      headers.set("Content-Security-Policy", csp)
      // Vite fingerprints everything under assets/, so it can be cached forever.
      headers.set(
        "Cache-Control",
        relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      )
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      console.error("app:// fetch failed", target, error)
      return new Response("Not found", { status: 404 })
    }
  })
}
