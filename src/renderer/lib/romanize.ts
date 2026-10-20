import { pinyin } from "pinyin-pro"
import { toRomaji } from "wanakana"
import { loadJapaneseTokenizer, romanizeJapanese } from "./japanese.ts"

const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/
const HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const CHO = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
const JUNG = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
const JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]

/** True when the text contains a script the romanizer can convert. */
export function hasRomanizableText(text: string): boolean {
  return KANA.test(text) || HANGUL.test(text) || HAN.test(text)
}

/** Romanize Hangul syllables to Revised Romanization (pronunciation rules are approximate). */
function romanizeHangul(word: string): string {
  let out = ""
  for (const char of word) {
    const code = char.codePointAt(0) ?? 0
    const offset = code - 0xac00
    if (offset < 0 || offset > 11171) {
      out += char
      continue
    }
    out += CHO[Math.floor(offset / 588)] + JUNG[Math.floor((offset % 588) / 28)] + JONG[offset % 28]
  }
  return out
}

/**
 * Romanize a lyric line based on its dominant writing system:
 * kana → romaji, Hangul → Revised Romanization, Han → pinyin.
 * Kanji in Japanese lines are left untouched because readings need a dictionary.
 */
export function romanizeText(text: string): string {
  if (!text) return text
  if (KANA.test(text)) return toRomaji(text)
  if (HANGUL.test(text)) return text.replace(/[\uac00-\ud7a3]+/g, romanizeHangul)
  if (HAN.test(text)) return pinyin(text, { toneType: "symbol", type: "string" })
  return text
}

/**
 * Romanizes a whole song. If any line contains kana the song is treated as
 * Japanese, so kanji-only lines also get their readings from the tokenizer.
 */
export async function romanizeLines(lines: string[]): Promise<string[]> {
  if (!lines.some((line) => KANA.test(line))) return lines.map(romanizeText)
  try {
    const tokenizer = await loadJapaneseTokenizer()
    return lines.map((line) => romanizeJapanese(line, tokenizer))
  } catch (error) {
    console.warn("Japanese dictionary failed to load; romanizing kana only", error)
    return lines.map((line) => toRomaji(line))
  }
}
