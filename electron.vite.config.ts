import fs from "node:fs"
import { resolve, sep } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import type { Plugin } from "vite"

/**
 * kuromoji ships its dictionary as `.dat.gz` and decompresses it itself.
 * Vite's dev server marks `.gz` files with `Content-Encoding: gzip`, so the
 * browser would decompress them first and kuromoji would then fail on the
 * already-decompressed bytes. Serve them raw in dev; the app:// protocol
 * already does this in production.
 */
function kuromojiDictionary(): Plugin {
  const directory = resolve(import.meta.dirname, "src/renderer/public/kuromoji/dict")
  return {
    name: "muzeec-kuromoji-dictionary",
    configureServer(server) {
      server.middlewares.use("/kuromoji/dict", (request, response, next) => {
        const name = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\/+/, "")
        const file = resolve(directory, name)
        if (!file.startsWith(directory + sep)) {
          next()
          return
        }
        fs.stat(file, (error, stat) => {
          if (error || !stat.isFile()) {
            next()
            return
          }
          response.statusCode = 200
          response.setHeader("Content-Type", "application/octet-stream")
          response.setHeader("Content-Length", stat.size)
          response.setHeader("Cache-Control", "no-cache")
          fs.createReadStream(file).pipe(response)
        })
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss(), kuromojiDictionary()],
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src/renderer"),
        "@shared": resolve(import.meta.dirname, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/renderer/index.html"),
      },
    },
  },
})
