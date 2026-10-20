import { test } from "node:test"
import assert from "node:assert/strict"
import { hasRomanizableText, romanizeText } from "../src/renderer/lib/romanize.ts"
import { romanizeJapanese, type JapaneseTokenizer } from "../src/renderer/lib/japanese.ts"

test("Japanese kana becomes romaji and kanji is preserved", () => {
  assert.equal(romanizeText("こんにちは"), "konnichiha")
  assert.equal(romanizeText("東京の夜"), "東京no夜")
})

test("Korean Hangul becomes Revised Romanization", () => {
  assert.equal(romanizeText("안녕하세요"), "annyeonghaseyo")
  assert.equal(romanizeText("한국"), "hanguk")
  assert.equal(romanizeText("사랑해"), "saranghae")
})

test("Chinese Han becomes pinyin with tone marks", () => {
  assert.equal(romanizeText("你好"), "nǐ hǎo")
  assert.equal(romanizeText("月亮"), "yuè liàng")
})

test("Japanese kanji is read through the tokenizer", () => {
  const tokenizer: JapaneseTokenizer = {
    tokenize: () => [
      { surface_form: "透き通る", pronunciation: "スキトオル" },
      { surface_form: "花びら", pronunciation: "ハナビラ" },
      { surface_form: "に", pronunciation: "ニ" },
      { surface_form: "唇", pronunciation: "クチビル" },
      { surface_form: "を", pronunciation: "ヲ" },
      { surface_form: "、", pronunciation: "、" },
      { surface_form: "好き", pronunciation: "スキ" },
      { surface_form: "です", pronunciation: "デス" },
      { surface_form: "。", pronunciation: "。" },
    ],
  }
  assert.equal(
    romanizeJapanese("透き通る花びらに唇を、好きです。", tokenizer),
    "sukitooru hanabira ni kuchibiru o, suki desu.",
  )
})

test("spaced word-synced characters are joined before tokenizing", () => {
  let seen = ""
  const tokenizer: JapaneseTokenizer = {
    tokenize: (text) => {
      seen = text
      return [{ surface_form: "透き通る", pronunciation: "スキトオル" }]
    },
  }
  assert.equal(romanizeJapanese("透 き 通 る", tokenizer), "sukitooru")
  assert.equal(seen, "透き通る")
})

test("auxiliaries and conjunctive particles attach to the previous word", () => {
  const tokenizer: JapaneseTokenizer = {
    tokenize: () => [
      { surface_form: "寄せ", pronunciation: "ヨセ", pos: "動詞" },
      { surface_form: "て", pronunciation: "テ", pos: "助詞", pos_detail_1: "接続助詞" },
      { surface_form: "は", pronunciation: "ワ", pos: "助詞", pos_detail_1: "係助詞" },
      { surface_form: "向い", pronunciation: "ムイ", pos: "動詞" },
      { surface_form: "て", pronunciation: "テ", pos: "助詞", pos_detail_1: "接続助詞" },
      { surface_form: "持っ", pronunciation: "モッ", pos: "動詞" },
      { surface_form: "た", pronunciation: "タ", pos: "助動詞" },
    ],
  }
  assert.equal(romanizeJapanese("寄せては向いて持った", tokenizer), "yosete wa muite motta")
})

test("inflectional suffixes attach while non-independent nouns stay separate", () => {
  const tokenizer: JapaneseTokenizer = {
    tokenize: () => [
      { surface_form: "これ", pronunciation: "コレ", pos: "名詞", pos_detail_1: "代名詞" },
      { surface_form: "以上", pronunciation: "イジョー", pos: "名詞", pos_detail_1: "非自立" },
      { surface_form: "許さ", pronunciation: "ユルサ", pos: "動詞", pos_detail_1: "自立" },
      { surface_form: "れる", pronunciation: "レル", pos: "動詞", pos_detail_1: "接尾" },
    ],
  }
  assert.equal(romanizeJapanese("これ以上許される", tokenizer), "kore ijoo yurusareru")
})

test("only CJK scripts are romanizable", () => {
  assert.equal(hasRomanizableText("hello world"), false)
  assert.equal(hasRomanizableText("abc 123"), false)
  assert.equal(hasRomanizableText("안녕"), true)
  assert.equal(hasRomanizableText("こんにちは"), true)
  assert.equal(hasRomanizableText("你好"), true)
  assert.equal(romanizeText("hello world"), "hello world")
})
