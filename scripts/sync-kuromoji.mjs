import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(root, "node_modules/kuromoji")
const target = path.join(root, "src/renderer/public/kuromoji")

fs.mkdirSync(path.join(target, "dict"), { recursive: true })
fs.copyFileSync(path.join(source, "build/kuromoji.js"), path.join(target, "kuromoji.js"))
for (const file of fs.readdirSync(path.join(source, "dict"))) {
  if (!file.endsWith(".dat.gz")) continue
  fs.copyFileSync(path.join(source, "dict", file), path.join(target, "dict", file))
}

console.log("Synced kuromoji dictionary to src/renderer/public/kuromoji")
