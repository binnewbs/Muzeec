import { net, protocol, type Session } from "electron"
import { createReadStream } from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import { downloadsDir } from "./downloads.ts"

const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer")
const DOWNLOAD_PREFIX = "__downloads/"

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
    if (relative.startsWith(DOWNLOAD_PREFIX)) {
      return serveDownload(relative.slice(DOWNLOAD_PREFIX.length), request)
    }
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

const DOWNLOAD_TYPES: Record<string, string> = {
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

/**
 * Local downloads need Range support for seeking and CORS for the renderer's
 * Web Audio analyser. Files live outside app.asar under `userData/downloads`.
 */
async function serveDownload(relative: string, request: Request): Promise<Response> {
  const root = downloadsDir()
  const target = path.resolve(root, relative)
  if (!target.startsWith(root + path.sep)) return new Response("Forbidden", { status: 403 })

  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type": DOWNLOAD_TYPES[path.extname(target).slice(1).toLowerCase()] ?? "application/octet-stream",
  })

  let size: number
  try {
    const stat = await fsp.stat(target)
    if (!stat.isFile()) throw new Error("not a file")
    size = stat.size
  } catch {
    return new Response("Not found", { status: 404, headers })
  }

  const range = parseRange(request.headers.get("range"), size)
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(0, size - 1)
  headers.set("Content-Length", String(size === 0 ? 0 : end - start + 1))
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`)
  if (request.method === "HEAD" || size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const stream = createReadStream(target, { start, end })
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  })
}

function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size <= 0) return "invalid"
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return "invalid"
  if (!rawStart) {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return "invalid"
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid"
  return { start, end: Math.min(end, size - 1) }
}
