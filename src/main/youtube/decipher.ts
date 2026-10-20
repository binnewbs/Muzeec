import vm from "node:vm"
import { Platform, Player } from "youtubei.js"

let player: Player | null = null
let loading: Promise<Player> | null = null

/**
 * YouTube's player script is remote code. It runs inside a bare vm context with
 * no require/process, never in the UI renderer (PLAN §5). Move this to a
 * utilityProcess when the direct-URL path is no longer the only consumer.
 */
Platform.shim.eval = async (data: { output: string }) => {
  const sandbox = {
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  }
  return vm.runInContext(`(function(){\n${data.output}\n})()`, vm.createContext(sandbox), { timeout: 10_000 })
}

async function getPlayer(): Promise<Player> {
  loading ??= Player.create(undefined)
  player = await loading
  return player
}

/** Decipher signatureCipher/cipher and apply the n transform (DOC §9.3). */
export async function decipher(cipher: string, _signatureTimestamp: number): Promise<string | null> {
  try {
    const instance = await getPlayer()
    return await instance.decipher(cipher)
  } catch (error) {
    console.error("decipher failed", error instanceof Error ? error.message : error)
    return null
  }
}
