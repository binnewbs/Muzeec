import { toRomaji } from "wanakana"

type KuromojiToken = {
  surface_form: string
  pronunciation?: string
  reading?: string
  pos?: string
  pos_detail_1?: string
}

export type JapaneseTokenizer = {
  tokenize: (text: string) => KuromojiToken[]
}

type KuromojiBuilder = {
  builder: (options: { dicPath: string }) => {
    build: (callback: (error: Error | null, tokenizer: JapaneseTokenizer) => void) => void
  }
}

declare global {
  interface Window {
    kuromoji?: KuromojiBuilder
  }
}

const SCRIPT_URL = "/kuromoji/kuromoji.js"
const DICT_PATH = "/kuromoji/dict"

const PUNCTUATION = /^[、。,.!?！？…‥「」『』（）()\[\]【】〜~・:：;；\-—–\s]+$/

/** Word-synced lyrics store gaps as spaces between single characters; join them for tokenization. */
const JOIN_SPACED_CJK =
  /(?<=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g

let tokenizerPromise: Promise<JapaneseTokenizer> | null = null

const LOAD_TIMEOUT_MS = 20_000

function loadScript(): Promise<void> {
  if (window.kuromoji) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Failed to load the Japanese dictionary script"))
    document.head.append(script)
  })
}

/** Loads kuromoji (IPADIC) from the bundled assets, once per session. */
export function loadJapaneseTokenizer(): Promise<JapaneseTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      await loadScript()
      const kuromoji = window.kuromoji
      if (!kuromoji) throw new Error("Japanese dictionary is unavailable")
      return await new Promise<JapaneseTokenizer>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out loading the Japanese dictionary")),
          LOAD_TIMEOUT_MS,
        )
        kuromoji.builder({ dicPath: DICT_PATH }).build((error, tokenizer) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(tokenizer)
        })
      })
    })().catch((error) => {
      // Allow a retry instead of caching the failure for the whole session.
      tokenizerPromise = null
      throw error
    })
  }
  return tokenizerPromise
}

function romanizePunctuation(surface: string): string {
  switch (surface) {
    case "、":
      return ", "
    case "。":
      return ". "
    case "！":
    case "!":
      return "! "
    case "？":
    case "?":
      return "? "
    case "…":
      return "… "
    case "「":
      return "“"
    case "」":
      return "”"
    default:
      return surface
  }
}

function joinsPrevious(token: KuromojiToken): boolean {
  if (token.pos === "助動詞" || token.pos_detail_1 === "接尾") return true
  if (token.pos === "動詞" && token.pos_detail_1 === "非自立") return true
  return token.pos === "助詞" && token.pos_detail_1 === "接続助詞"
}

/** Tokenizes Japanese text and converts each reading (or surface form) to romaji. */
export function romanizeJapanese(text: string, tokenizer: JapaneseTokenizer): string {
  if (!text.trim()) return text
  const source = text.replace(JOIN_SPACED_CJK, "")
  let output = ""
  let readingBuffer = ""

  const flush = () => {
    if (!readingBuffer) return
    const romaji = toRomaji(readingBuffer).trim()
    readingBuffer = ""
    if (!romaji) return
    if (!output) output = romaji
    else if (output.endsWith(" ") || output.endsWith("“") || output.endsWith("(")) output += romaji
    else output += ` ${romaji}`
  }

  for (const token of tokenizer.tokenize(source)) {
    const surface = token.surface_form
    if (!surface) continue
    if (!surface.trim()) {
      flush()
      continue
    }
    if (PUNCTUATION.test(surface)) {
      flush()
      output = output.replace(/\s+$/, "")
      output += romanizePunctuation(surface)
      continue
    }
    if (surface === "を") {
      flush()
      output += output ? " o" : "o"
      continue
    }
    const reading =
      token.pronunciation && token.pronunciation !== "*"
        ? token.pronunciation
        : token.reading && token.reading !== "*"
          ? token.reading
          : surface
    if (!readingBuffer) {
      readingBuffer = reading
    } else if (joinsPrevious(token)) {
      readingBuffer += reading
    } else {
      flush()
      readingBuffer = reading
    }
  }
  flush()
  return output.trim()
}
