# A Multi-Provider Lyrics Engine

**A language-agnostic reference design for fetching, normalizing, caching and displaying timed lyrics in a music streaming app.**

This document describes an architecture that can be implemented in any client — Android, iOS, desktop, web, TV, or a backend service. It is deliberately independent of any particular codebase. Code samples are illustrative and written in TypeScript-like pseudocode unless a platform detail matters.

The goal is not merely "get some lyrics". The goal is to get **the right words for the exact recording that is playing**, with the finest timing available, quickly, without making the user wait on unreliable third parties.

---

## Table of contents

1. [What this engine solves](#1-what-this-engine-solves)
2. [Design principles](#2-design-principles)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Domain model](#4-domain-model)
5. [Provider contract](#5-provider-contract)
6. [Query preparation](#6-query-preparation)
7. [Recording identity: the ISRC prepass](#7-recording-identity-the-isrc-prepass)
8. [The lookup race](#8-the-lookup-race)
9. [Provider catalogue and protocols](#9-provider-catalogue-and-protocols)
10. [Matching rules and scoring](#10-matching-rules-and-scoring)
11. [Parsing and normalization](#11-parsing-and-normalization)
12. [Caching and persistence](#12-caching-and-persistence)
13. [Wiring lyrics to playback](#13-wiring-lyrics-to-playback)
14. [Settings and provider picker UI](#14-settings-and-provider-picker-ui)
15. [Offline and downloaded tracks](#15-offline-and-downloaded-tracks)
16. [Translation and romanization (optional)](#16-translation-and-romanization-optional)
17. [Platform notes](#17-platform-notes)
18. [Failure modes and observability](#18-failure-modes-and-observability)
19. [Security and legal](#19-security-and-legal)
20. [Testing strategy](#20-testing-strategy)
21. [Implementation roadmap](#21-implementation-roadmap)
22. [Appendix A: endpoint quick reference](#appendix-a-endpoint-quick-reference)
23. [Appendix B: wire-format examples](#appendix-b-wire-format-examples)
24. [Appendix C: default priority rationale](#appendix-c-default-priority-rationale)
25. [Appendix D: constants worth tuning](#appendix-d-constants-worth-tuning)

---

## 1. What this engine solves

A music player usually knows only a **platform track identifier** (for example a YouTube video id, a Spotify track id, or a local file). It does not know the recording's canonical metadata, and it has no lyrics.

Lyrics live in many unrelated catalogues:

- Apple Music's syllable-timed TTML, mirrored by several community hosts.
- QQ Music karaoke timings.
- Musixmatch rich-sync and line-synced subtitles.
- LRCLIB's community LRC.
- KuGou's Chinese catalogue.
- YouTube's own lyrics tab and timed captions.
- Plain-text web scrapes from Genius.
- Community databases keyed on the video id itself.

Each has different coverage, formats, authentication, reliability and legal standing. The engine's job is to hide that mess behind one stable operation:

```
getLyrics(trackDescriptor) -> LyricsResult | null
```

The hard parts are:

1. **Identity.** "Dracula" by Tame Impala exists as a single and an album cut with different words in places. A title+artist search cannot reliably distinguish them.
2. **Latency.** Asking ten providers sequentially can take a minute to discover that no one has the track.
3. **Priority vs. speed.** A low-priority provider may answer in 200 ms while a high-priority one is still thinking. Which answer should win?
4. **Timing granularity.** Word/syllable timing is dramatically better than line timing, which is better than plain text. But the finest source is often the least reliable.
5. **Format diversity.** TTML, LRC, enhanced LRC, QRC/YRC, JSON envelopes, HTML scrapes, plain text.
6. **Correctness.** Wrong lyrics scrolling in perfect sync with the right song is worse than showing no lyrics.
7. **Offline.** A downloaded track should not re-fetch its lyrics on every play.

---

## 2. Design principles

These are the rules that make the rest of the design coherent.

1. **Never optimize for "something came back". Optimize for "the right recording's words came back".**
   A miss is recoverable: the next provider gets a turn. A wrong match is not: the user sees confidently incorrect lyrics.

2. **Ask everyone at once; take answers in priority order.**
   Sequential fallback wastes one round trip per miss. Racing all providers costs only the slowest source that must be waited on.

3. **Let a word-timed answer win outright.**
   Line timing is a fallback, not a peer. A syllable-timed answer from a lower-priority source is usually a better experience than a line-synced answer from a higher one — but this must be a user setting, because some users prefer strict priority.

4. **Settle the recording before asking for words.**
   One small metadata search that returns an ISRC makes every subsequent request unambiguous. It is the highest-leverage request in the whole pipeline.

5. **Give every provider a hard deadline.**
   A lyric that arrives after the second chorus is useless. Fail fast, fall through.

6. **Cancel losers.**
   When a winner is chosen, no remaining request should keep consuming bandwidth, battery or the user's connection.

7. **Normalize once, at the boundary.**
   Every provider produces the same internal line/word/syllable model. The renderer never needs to know where the lyrics came from.

8. **Separate display concerns from timing concerns.**
   Background vocals, duet sides, instrumental gaps and translations are properties of the song, not of the provider. Normalize them consistently so switching providers does not make the panel flip inside out.

9. **Cache aggressively, invalidate precisely.**
   Lyrics are immutable for a given recording. Cache per-track results for hours, but invalidate when the user changes providers, grants a permission, or changes the search query.

10. **The user owns the provider list.**
    Every third-party service is contacted on the user's connection. Let them disable providers, reorder them and choose whether to prefer syllable timing.

---

## 3. Architecture at a glance

```
                        ┌─────────────────────────┐
                        │   Player / Track state   │
                        │  id, title, artist,      │
                        │  album, duration, ISRC?  │
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │   LyricsCoordinator     │
                        │  - query preparation    │
                        │  - ISRC prepass         │
                        │  - provider race        │
                        │  - selection policy     │
                        └────────────┬────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
      ┌───────────────┐      ┌───────────────┐      ┌───────────────┐
      │ Provider A    │      │ Provider B    │      │ Provider N    │
      │ (TTML)        │      │ (LRC)         │      │ (plain/scrape)│
      └───────┬───────┘      └───────┬───────┘      └───────┬───────┘
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │  Parser / normalizer     │
                        │  lines, words, syllables │
                        │  background, alignment   │
                        │  instrumental gaps       │
                        └────────────┬────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │  Result cache (12h)      │
                        └────────────┬────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │  Lyric renderer + clock  │
                        └─────────────────────────┘
```

The crucial separation is **fetch → normalize → render**. Providers never talk to the UI. The UI never parses a provider payload.

---

## 4. Domain model

A single internal representation is what makes multi-provider support tractable. Use something equivalent to the following.

### 4.1 Line

```ts
interface LyricLine {
  /** Start of the line in song milliseconds. 0 means "no timing" (plain text). */
  timeMs: number;

  /** The full line text, without word stamps. Empty string = instrumental gap. */
  text: string;

  /** Word-level timing. Empty for a line-synced or unsynced line. */
  words: LyricWord[];

  /** Optional explicit end of the sung line. */
  sungUntilMs?: number | null;

  /** The answering/backing vocal, drawn under the lead. Never nested. */
  background?: LyricLine | null;

  /** Which side of a duet panel the line belongs to. */
  alignment: "start" | "end";

  /** For a translation: the original line that drives its sweep and bloom. */
  timingSource?: LyricLine | null;
}
```

### 4.2 Word and syllable

```ts
interface LyricWord {
  startMs: number;
  endMs: number;
  /** The word exactly as it should be displayed, including punctuation. */
  text: string;
  /** Optional finer timing inside the word. Empty means the word is one unit. */
  syllables: LyricSyllable[];
}

interface LyricSyllable {
  startMs: number;
  endMs: number;
  /** Character range [startChar, endChar) within the word's text. */
  startChar: number;
  endChar: number;
}
```

Why keep both words and syllables? Because **word is the layout and animation unit**, while **syllable is the timing unit**. Apple's TTML splits "enough" into `e` + `nough`. The renderer should lay out one word, but sweep through two timed pieces. Spreading a wipe evenly across the whole word would run ahead of the first syllable and behind the second.

A useful helper computes how many characters of a word are "sung" at a given position:

```
charsSungAt(word, position):
  if position <= word.startMs: return 0
  if position >= word.endMs:   return word.text.length

  if word.syllables is empty:
    return (position - start) / (end - start) * text.length

  for each syllable:
    if position < syllable.startMs: return syllable.startChar
    if position < syllable.endMs:
      progress = (position - syllable.startMs) / (syllable.endMs - syllable.startMs)
      return syllable.startChar + progress * (syllable.endChar - syllable.startChar)

  return text.length
```

### 4.3 Invariants

Normalize every provider's output to these invariants:

- `lines` are sorted by `timeMs` ascending.
- A gap is `text === ""`; it has no words and no background.
- `background` is never itself a background (no nesting).
- `words`, when present, appear in `text` in order.
- Each word's syllables are in order, cover the word's characters contiguously, and have `startChar = 0` on the first and `endChar = text.length` on the last.
- A word-timed line has `words.length > 0`; a line-timed line has `words.length === 0` and `timeMs > 0`; an unsynced line has `timeMs === 0`.
- `timeMs` should be `<=` the first word's `startMs` when words exist (Apple occasionally stamps the paragraph slightly after the first span).

### 4.4 JSON shape

If lyrics cross a process or API boundary, send the normalized model, not the raw provider payload:

```json
{
  "source": "provider-id",
  "label": "Provider name",
  "wordSynced": true,
  "synced": true,
  "lines": [
    {
      "timeMs": 27395,
      "text": "I been tryna call",
      "words": [
        { "startMs": 27395, "endMs": 27549, "text": "I", "syllables": [] },
        { "startMs": 27549, "endMs": 27740, "text": "been", "syllables": [] }
      ],
      "sungUntilMs": null,
      "alignment": "start"
    }
  ]
}
```

---

## 5. Provider contract

A provider is a small adapter with metadata and one fetch method.

```ts
interface Provider {
  id: string;
  label: string;
  /** Can this provider return word-level timing? Used for selection policy and UI. */
  wordSynced: boolean;
  /** Hidden providers are never offered in settings or contacted. */
  hidden?: boolean;

  /**
   * Optional: identify the exact recording and return an ISRC plus any
   * pre-fetched document. Only providers with a recording index implement this.
   */
  identify?(query: Query): Promise<Identity | null>;

  /**
   * Fetch and parse lyrics. Return null for any miss.
   * Must never throw for ordinary network/parse failures.
   */
  fetch(query: Query, ctx: FetchContext): Promise<ParsedLyrics | null>;
}

interface Query {
  videoId?: string;           // platform track id, if the provider can use it
  title: string;              // cleaned for search
  artist: string;             // cleaned for search
  album?: string | null;
  durationMs: number;
  isrc?: string | null;       // known or discovered recording id
}

interface FetchContext {
  /** Fetch a URL with the engine's timeouts and headers. */
  get(url: string): Promise<string | null>;
  /** Deduplicated document fetch, shared across providers in one lookup. */
  sharedGet(url: string): Promise<string | null>;
  /** The identity prepass hit, when the provider is the one that produced it. */
  identity?: Identity | null;
  /** Abort signal; cancelled when another provider wins. */
  signal: AbortSignal;
}

interface ParsedLyrics {
  lines: LyricLine[];
  /** Optional raw TTML, if the provider supplied it and a renderer can use it. */
  ttml?: string;
}
```

Rules for provider implementations:

- **Never throw.** Catch everything and return `null`. A provider failure is a miss, not an app failure.
- **Never retry inside a provider.** The engine's fallback chain is the retry mechanism.
- **Do not sleep, poll or back off.** Keep the request short; the engine's timeout bounds it.
- **Do not perform UI work.** Return data only.
- **Do not trust timestamps.** Sort, clamp negatives and validate ordering in the normalizer.
- **One provider, one responsibility.** If a host exposes several catalogues (Apple, Spotify, Musixmatch), expose them as separate provider ids so users can enable them independently.

---

## 6. Query preparation

The platform's title is not the title any lyrics database indexed.

Example:

```
YouTube title:  "Dracula (feat. JENNIE) [Official Music Video]"
Catalog title:  "Dracula"
```

Asked verbatim, the search misses. The fix is a **single normalization pass**, applied before any provider is contacted, not inside each provider.

### 6.1 Title normalization

Remove only **credits and packaging** — things that are not part of the recording's name anywhere:

- Bracketed or unbracketed featured credits:
  `(feat. X)`, `[ft. X]`, `(with X)`, `feat. X ...`
- Upload labels:
  `(Official Video)`, `(Official Audio)`, `[Lyrics]`, `(Lyric Video)`,
  `(Music Video)`, `(Visualizer)`, `(HD)`, `(HQ)`, `(4K)`, `(Full Song)`,
  `(Official)`, `[MV]`.

Do **not** remove version markers:

- `(Remix)`, `(Acoustic)`, `(Live)`, `(Remastered 2011)`, `(Sped Up)`,
  `(Slowed + Reverb)`, `(Instrumental)`, `(Demo)`, `(Edit)`, `(Cover)`,
  `(Nightcore)`, `(Extended)`.

These name a *different recording*. Stripping them turns a search for one recording into a search for another — and returns confidently wrong words. A miss is recoverable; wrong words in sync are not.

Implementation:

```ts
const CREDITS = [
  /\s*[(\[]\s*(feat|ft|featuring|with)\b[^)\]]*[)\]]/gi,
  /\s+(feat|ft|featuring)\.?\s+.*$/gi,
  /\s*[(\[]\s*(official\s*)?(music\s*)?(video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m\/?v|hd|hq|4k|full\s*song)\s*[)\]]/gi,
  /\s*[(\[]\s*official\s*[)\]]/gi,
];

function forLyricsSearch(title: string): string {
  let name = title;
  for (const pattern of CREDITS) name = name.replace(pattern, " ");
  name = name.replace(/\s+/g, " ").trim().replace(/[,–—-]+$/, "").trim();
  // If the title was only packaging, keep the original rather than sending nothing.
  return name || title.trim();
}
```

### 6.2 Artist normalization

Auto-generated YouTube artist channels are named `"Artist - Topic"`. Strip that suffix:

```ts
function artistForLyricsSearch(artist: string): string {
  const cleaned = artist.replace(/\s*-\s*Topic$/i, "").trim();
  return cleaned || artist.trim();
}
```

Also worth normalizing for *matching* (not necessarily for sending):

- Unicode NFKD, strip combining marks (`ROSÉ` → `rose`).
- Lowercase.
- Replace punctuation with spaces.
- Collapse whitespace.
- Split multi-artist strings on `, & ; / and x with feat ft`.

### 6.3 Duration

Send duration in whole seconds when the API expects seconds, or milliseconds when it expects milliseconds. A zero/unknown duration should be omitted rather than sent as `0`.

Duration is one of the strongest disambiguators. Use it.

### 6.4 Album

Send it when available; it improves matching on providers that index albums. Do not require it.

### 6.5 Platform id

Some providers are keyed on the platform id itself (for example a video id). Those can skip name matching entirely and cannot return the wrong edit. Prefer them when available, but never make them the only source: their coverage is narrower.

---

## 7. Recording identity: the ISRC prepass

### 7.1 Why

Title + artist + duration is a *description*. An ISRC (`CC-XXX-YY-NNNNN`) names **one specific recording**. A single and its album cut can share a title, an artist and nearly a length, and still differ in the words. Only a recording identifier settles it.

### 7.2 The prepass

Before asking anyone for lyrics, make **one small search** against a provider that:

1. indexes recordings by ISRC,
2. returns the ISRC of whatever it matched,
3. returns a document URL that other providers can also use.

```ts
async function identify(query: Query): Promise<BiniHit | null> {
  const url = new URL("https://lyrics-api.binimum.org/");
  if (query.isrc) {
    url.searchParams.set("isrc", query.isrc);
  } else {
    url.searchParams.set("track", query.title);
    url.searchParams.set("artist", query.artist);
    if (query.album) url.searchParams.set("album", query.album);
    if (query.durationMs > 0) url.searchParams.set("duration", String(Math.round(query.durationMs / 1000)));
  }
  const body = await httpGet(url.toString());
  if (!body) return null;
  const json = JSON.parse(body);
  return json.results?.[0] ?? null;
}
```

Example response shape:

```json
{
  "total": 1,
  "source": "HIT-EXACT",
  "results": [
    {
      "track_name": "Dracula",
      "artist_name": "Tame Impala",
      "album_name": "Dracula",
      "duration": 205,
      "isrc": "AUUM72500001",
      "timing_type": "word",
      "lyrics_url": "https://lrc.red/s/AUUM72500001.ttml"
    }
  ]
}
```

### 7.3 Rules

- **Cap it at ~2.5 seconds.** Knowing the recording improves every match, but not knowing it only puts things back where they were. An empty panel because one host is slow is worse than a fuzzy match.
- **Skip it entirely if that provider is disabled.** A source the user turned off is not contacted, not even to help other sources.
- **Skip it if the caller already knows the ISRC** (for example from local file tags).
- **Remember the result per track id**, in memory, bounded (LRU ~100). A track asked about twice pays once.
- **Hand the ISRC to every provider that can use it.** Two categories:
  - Providers that can fetch *directly* by recording (e.g. `https://lrc.red/s/{ISRC}.ttml`).
  - Providers that can use it merely as a ranking hint alongside title/artist.
- **Hand the prepass hit to the same provider's lyric fetch**, so it does not search twice. The typical flow is: search → returns document URL → fetch document. The prepass already did the search; the lyric fetch should reuse the hit.

### 7.4 Fallback

If the prepass times out or misses:

- Continue with title/artist/duration only.
- Do not delay the race further.
- Providers with their own search still work; they are just slightly more ambiguous.

This is a deliberate **fail-open** design.

---

## 8. The lookup race

### 8.1 The core idea

Start **all enabled providers concurrently**. Consume their results **in priority order**, awaiting each in turn. This gives two properties at once:

- A miss on one provider does not cost a sequential round trip before the next is tried.
- A fast low-priority provider cannot preempt a slow high-priority one that is still pending.

It is not "first response wins". It is "highest-priority response wins, but everyone starts now".

### 8.2 Reference algorithm

```ts
const IDENTIFY_TIMEOUT_MS = 2500;

async function lookupLyrics(
  track: TrackDescriptor,
  settings: LyricsSettings,
  onSource?: (source: string, state: "pending" | "found" | "missing" | "cancelled") => void,
): Promise<LyricsResult | null> {
  const sequence = resolveSequence(settings); // enabled + ordered + visible
  if (sequence.length === 0) return null;

  const query: Query = {
    videoId: track.videoId,
    title: forLyricsSearch(track.title),
    artist: artistForLyricsSearch(track.artist),
    album: track.album,
    durationMs: track.durationMs,
    isrc: track.isrc ?? isrcCache.get(track.videoId) ?? null,
  };

  // 1. Identify the recording, unless we already know it.
  let hit: Identity | null = null;
  if (!query.isrc && sequence.some((id) => providers[id].identify)) {
    const identifier = sequence.map((id) => providers[id]).find((p) => p.identify)!;
    hit = await withTimeout(identifier.identify(query).catch(() => null), IDENTIFY_TIMEOUT_MS);
    if (hit?.isrc) {
      query.isrc = hit.isrc;
      rememberIsrc(track.videoId, hit.isrc);
    }
  }

  // 2. Shared document cache for this lookup.
  const documents = new Map<string, Promise<string | null>>();
  const sharedGet = (url: string) => {
    let pending = documents.get(url);
    if (!pending) {
      pending = httpGet(url).catch(() => null);
      documents.set(url, pending);
    }
    return pending;
  };

  // 3. Start every provider now. Genius is lazy: only started if reached.
  //    Providers must observe `signal`; otherwise their work keeps running.
  const controller = new AbortController();
  const signal = controller.signal;

  const jobs = sequence.map((id) => {
    const provider = providers[id];
    const start = id === "genius" ? null : run(provider);
    return { id, provider, start };
  });

  function run(provider: Provider): Promise<LyricsResult | null> {
    onSource?.(provider.id, "pending");
    return provider
      .fetch(query, { get: httpGet, sharedGet, identity: hit, signal })
      .then((parsed) => {
        const result = parsed && parsed.lines.some((l) => l.text.trim())
          ? normalize(provider.id, parsed)
          : null;
        onSource?.(provider.id, result ? "found" : "missing");
        return result;
      })
      .catch((error) => {
        onSource?.(provider.id, signal.aborted ? "cancelled" : "missing");
        return null;
      });
  }

  // 4. Consume in priority order.
  let lineSynced: LyricsResult | null = null;
  let plain: LyricsResult | null = null;

  try {
    for (const entry of jobs) {
      // Do not start a scrape if a timed answer already exists.
      if (entry.id === "genius" && (lineSynced || plain)) continue;

      const found = await (entry.start ?? run(entry.provider));
      if (!found) continue;

      // Word/syllable timing wins outright.
      if (found.wordSynced) return found;

      // Strict priority mode: the first timed answer wins.
      if (found.synced && !settings.preferSyllableTiming) return found;

      // Prefer-syllables mode: keep the first timed answer as fallback,
      // but keep looking for a word-timed one above it in priority order.
      if (found.synced) lineSynced ??= found;
      else plain ??= found;
    }
    return lineSynced ?? plain;
  } finally {
    // 5. Cancel every loser.
    controller.abort();
  }
}
```

A Kotlin coroutine implementation uses the same shape:

```kotlin
coroutineScope {
    val jobs = sequence.map { source ->
        source to async(Dispatchers.IO, start = if (source == GENIUS) LAZY else DEFAULT) {
            fetch(source, query)
        }
    }
    try {
        var lineSynced: Result? = null
        for ((source, job) in jobs) {
            if (lineSynced != null && source == GENIUS) continue
            val found = runCatching { job.await() }.getOrNull() ?: continue
            if (found.lines.any { it.isWordSynced }) return@coroutineScope found
            if (!preferSyllables && found.lines.any { it.timeMs > 0 }) return@coroutineScope found
            if (lineSynced == null) lineSynced = found
        }
        lineSynced
    } finally {
        jobs.forEach { it.second.cancel() }
    }
}
```

### 8.3 Selection policy in words

Given results arriving in priority order:

| Situation | Action |
|---|---|
| A provider returns word/syllable timing | Return it immediately. |
| A provider returns line timing, "prefer syllables" is off | Return it immediately (strict priority). |
| A provider returns line timing, "prefer syllables" is on | Remember it as fallback; continue looking for word timing. |
| A provider returns plain text only | Remember it as the last-resort fallback; continue. |
| No timed result ever arrives | Return the best plain result, or null. |
| All providers miss | Return null. |

The "prefer syllables" setting is a real trade-off:

- **Off:** predictable, honors the user's order strictly, fewer requests effectively matter.
- **On:** potentially better animation at the cost of waiting longer and querying lower-priority providers even after a usable line-synced answer exists.

### 8.4 Cancellation

When a winner is returned:

- Cancel every pending provider job.
- Cancel all shared document downloads started for this lookup.
- Do not report cancelled jobs as "not found"; report them as "not fetched" or "cancelled". A UI that says "not found" for a provider that was never allowed to finish is lying.

In structured-concurrency languages, the parent scope will not return until children finish, so cancellation is mandatory, not optional.

### 8.5 Shared document cache

Two providers often want the exact same file. The canonical case:

1. The prepass search returns a `lyricsUrl` pointing at `https://lrc.red/s/{ISRC}.ttml`.
2. The prepass provider fetches that URL.
3. The lrc.red provider, given the same ISRC, wants the same URL.

Without deduplication, that is two downloads for one document. Use a per-lookup `Map<url, Promise<string | null>>`:

- The download runs in the **lookup's** scope, not the asking provider's scope.
- If the asking provider loses the race and is cancelled, the shared download must not be cancelled with it — another provider may still be waiting on it.
- Cancel the whole map in the lookup's `finally`.

This is an ordinary case, not an edge case. Design for it from the start.

### 8.6 Timing budget

Recommended budget:

| Layer | Timeout |
|---|---|
| DNS + connect | 3 s |
| Ordinary provider call (total) | 6 s |
| Authenticated/back-end-resolving providers | 10–15 s |
| ISRC prepass | 2.5 s |
| Overall lookup (recommended addition) | 8–12 s |
| Scraper (Genius) | 8 s |

The overall deadline is important in an ordered race: if the top-priority provider is slow, everyone behind it waits for it. Per-call timeouts bound that, but a global deadline gives a hard upper bound and a predictable UI state.

A more latency-sensitive variant: after a grace period (say 2.5 s), allow a lower-priority timed result to win if the higher-priority job is still pending. This trades strict priority for responsiveness. Make it a setting or a product decision.

### 8.7 Why not first-response-wins?

Because provider priority encodes quality and reliability. A line-synced provider that answers in 150 ms should not beat a syllable-timed provider that answers in 400 ms. Users notice timing quality immediately.

### 8.8 Why not purely sequential?

A track with no lyrics anywhere and ten providers would pay ten full round trips. With 6 s timeouts, that is up to a minute of waiting to learn "nothing". Racing makes the cost roughly the slowest single provider, not the sum.

### 8.9 Mirror racing (nested race)

Some backends run on volunteer mirrors that come and go. For those, apply a second race **inside** the provider:

1. Try all known mirrors concurrently.
2. Take the first response with **usable lyrics**, not merely the first HTTP response. A mirror that 404s this track should not beat one that has it.
3. Remember the last good mirror and put it first next time. This avoids paying for the mirror race on every track.
4. Cancel the other mirror requests once a winner is found.

This pattern is reusable for any host with multiple equivalent endpoints.

---

## 9. Provider catalogue and protocols

The following providers are real, publicly reachable services used by production players. **They are unofficial and can change, rate-limit, geo-block or disappear without notice.** Treat every endpoint as best-effort, verify it before shipping, and respect each service's terms.

### 9.1 Recommended default order

Visible providers, best first:

| # | Provider id | What it carries | Word timing |
|---|---|---|---|
| 1 | `lrc-red` | Apple Music TTML by ISRC, direct | Yes |
| 2 | `bini` | Apple TTML, recording-indexed; source of ISRC | Yes |
| 3 | `better-lyrics` | Apple TTML, word-timed | Yes |
| 4 | `better-lyrics-portato` | QQ Music karaoke timings | Yes |
| 5 | `paxsenix` | Apple timings via keyless provider | Yes |
| 6 | `paxsenix-spotify` | Spotify lyrics, authenticated | No |
| 7 | `paxsenix-musixmatch` | Musixmatch timings, authenticated | Yes |
| 8 | `lyrics-plus` | Aggregated Apple/QQ/Musixmatch, mirrors | Yes |
| 9 | `unison` | Community-contributed | Often |
| 10 | `youtube-captions` | Platform captions for exact video | No |
| 11 | `youtube-music` | Platform Lyrics tab | No |
| 12 | `kugou` | Chinese catalogue, wide non-English coverage | No |
| 13 | `lrclib` | Community LRC, very reliable | No |
| 14 | `musixmatch` | Large licensed catalogue | Sometimes |
| 15 | `genius` | Scraped plain text, huge catalogue | No |

Hidden by default (kept in code but not offered):

| Provider id | Why hidden |
|---|---|
| `simpmusic` | Keyed on video id, geoblocks some regions, narrow coverage |
| `megalobiz` | Community LRC, thin and unreliable |

Rationale for the ordering is in [Appendix C](#appendix-c-default-priority-rationale).

### 9.2 Apple TTML family

These all return Apple Music's TTML (or a variant). They differ in matcher, hosting and index.

#### lrc.red

- Search: `GET https://lrc.red/search.json?q={title} {artist}`
- Document: `GET https://lrc.red/s/{ISRC}.ttml`
- No auth.
- Search response: `{ "hits": [{ "isrc", "title", "artist", "album", "year", "duration" }], "next" }`
- Matching is strict; see [§10.2](#102-lrc-red-strict-matching).
- Documents can be word-timed or line-timed (`lrc:timing="Line"`), so one TTML parser covers both.
- Ignore the document's own `<audio lyricOffset>`; the stamps are written against the release audio.

#### BiniLyrics

- Search/identify: `GET https://lyrics-api.binimum.org/?track={title}&artist={artist}&album={album}&duration={seconds}`
- Or by recording: `GET https://lyrics-api.binimum.org/?isrc={ISRC}`
- No auth.
- Response: `{ total, source, results: [{ track_name, artist_name, album_name, duration, isrc, timing_type, lyrics_url }] }`
- A miss is typically HTTP 404, not an empty result set.
- The `lyrics_url` usually points at lrc.red. Fetch it as a second request, or reuse the shared document cache.
- This is the recommended **ISRC prepass** provider.

#### BetterLyrics

- `GET https://lyrics-api.boidu.dev/getLyrics?s={title}&a={artist}&d={seconds}&al={album}`
- No auth.
- Returns Apple TTML or a JSON envelope containing it. Run the generic unwrapper.
- The newer Cloudflare-hosted API may require a Turnstile challenge; a native client cannot answer it. Use the original host.

#### BetterLyrics Portato

- `GET https://lyrics-api.boidu.dev/qq/getLyrics?s={title}&a={artist}&d={seconds}&al={album}`
- No auth.
- QQ Music karaoke timings through the same host.

#### PaxSenix (keyless Apple route)

- `GET https://lyrics.paxsenix.org/apple-music/lyrics?id={appleTrackId}&ttml=true`
- Apple catalogue search: `GET https://amp-api.music.apple.com/v1/catalog/us/search?term={title} {artist}&types=songs&limit=10&l=en-US`
- Apple search requires a bearer token. The common approach is to scrape it from the public Apple Music web player's JS bundle. Cache the token.
- Apple endpoints require `Origin: https://music.apple.com` and a `Referer`; without them they answer 403 even with a valid token.
- Score candidates before fetching lyrics. Do not take the first search hit.

#### PaxSenix authenticated routes

- Base: `https://api.paxsenix.org`
- Spotify search: `GET /spotify/search?q={title} {artist}`
- Spotify lyrics: `GET /lyrics/spotify?id={id}`
- Musixmatch: `GET /lyrics/musixmatch?t={title}&a={artist}&d={seconds}`
- Generic: `GET /lyrics/lrcget?q={title} {artist}`
- Requires a user-supplied API key as `Authorization: Bearer {key}`.
- The generic `/lyrics/lrcget` returns **candidate documents**, not one lyric. Parsing the array as one document concatenates every candidate and restarts timestamps at zero, producing repeated, unsyncable lines. Select one candidate first, then parse it.
- Authenticated routes may resolve against an upstream catalogue before answering; allow 15 s.

#### LyricsPlus

- `GET {mirror}/v2/lyrics/get?title={title}&artist={artist}&duration={seconds}&album={album}&isrc={isrc}`
- No auth.
- Response v2: `{ type, lyrics: [{ time, duration, text, syllabus: [{ time, duration, text }], element }], metadata: { agents } }`
- `syllabus` (sic) is the syllable array. Spacing inside syllable text encodes word boundaries: `"e"` followed by `"nough "` is one word. Do not split on syllables.
- `metadata.agents` maps voice ids/aliases to `person`, `group`, `other`; a line's `element.singer` names its voice.
- Hosted on volunteer mirrors. Race them and remember the last good one.

### 9.3 Community and platform providers

#### Unison

- `GET https://unison.boidu.dev/lyrics?song={title}&artist={artist}&album={album}&duration={seconds}`
- No auth.
- Response: `{ success, data: { lyrics, format: "ttml"|"lrc", syncType: "wordsync"|"linesync"|"plain", confidence, voteCount } }`
- Three shapes: TTML, enhanced/line LRC, plain text. Dispatch on `format`/`syncType`, and fall through if enhanced parsing finds no word stamps.
- Contributions are uneven. Do not reject low-confidence entries outright; the alternative is usually no lyrics at all.

#### SimpMusic (usually hidden)

- `GET https://api-lyrics.simpmusic.org/v1/{videoId}`
- No auth.
- Response: `{ success, data: [{ duration, richSyncLyrics, syncedLyrics, plainLyrics }] }`
- Keyed on the exact video id, so it cannot return the wrong edit.
- Geoblocks some regions with HTTP 403 and a textual body; treat as a miss and continue.
- Prefer `richSyncLyrics` (enhanced LRC), then `syncedLyrics`.
- Filter by duration; if several cuts exist, pick the closest within ~10 s.

#### LRCLIB

- Exact: `GET https://lrclib.net/api/get?track_name={title}&artist_name={artist}&duration={seconds}`
- Search: `GET https://lrclib.net/api/search?track_name={title}&artist_name={artist}`
- No auth; `User-Agent` identifying your app is polite and recommended.
- Exact response includes `syncedLyrics` and `plainLyrics`.
- Search returns an array; choose the hit with `syncedLyrics` whose duration is closest to the playing track.
- Line-synced only. Still one of the most reliable providers; keep it enabled.

#### KuGou

Three unauthenticated calls, chained:

1. Song search: `GET https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=8&showtype=0&keyword={keyword}`
   Response includes `data.info[].hash` and `duration`.
2. Lyrics search: `GET https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash={hash}`
   Or keyword fallback: `...&keyword={keyword}&duration={milliseconds}`
3. Download: `GET https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id={id}&accesskey={accesskey}`
   Response `content` is Base64-encoded LRC.

Matching rules:

- Filter song hits to within ~8 s of the playing duration; sort by closeness.
- Try hashes in order; fall back to keyword search.
- Strip leading/trailing songwriter/composer/arranger credit lines that carry real timestamps; otherwise they are sung as the first and last lines.

#### Musixmatch

- Base: `https://apic.musixmatch.com/ws/1.1`
- Endpoints: `track.search`, `track.subtitle.get`, `track.richsync.get`
- Requires a signed request (app id + rotating token/secret). The exact signing scheme is outside the scope of this document and changes periodically; harvest it from the public web client and cache tokens. Do not hardcode long-lived secrets.
- Prefer rich-sync when `hasrichsync != 0`; fall back to line-timed subtitles.
- Subtitle bodies use a custom mini-format; convert to LRC before parsing.
- Score candidates on title, artist and duration; reject poor ones.

#### Genius (last resort)

- Search: `GET https://genius.com/api/search/multi?q={query}`
- Fetch the selected song page HTML.
- Extract `div[data-lyrics-container=true]` (older pages: `div.lyrics`).
- Remove metadata, translation links, "You might also like", embed blocks; keep section headers like `[Verse 1]`.
- No timestamps. Every line gets `timeMs = 0`.
- Genius sits behind Cloudflare. Counter-intuitively, a plain `User-Agent` (your app name) often works where a browser-claiming UA is challenged, because a fake browser UA whose TLS fingerprint does not match is a bot signal. Measure, do not assume.
- Only contact this provider after every timed provider above it has missed.

#### YouTube Music and captions (platform-specific)

If your app owns a platform API, you can expose native lyrics:

- **Lyrics tab:** fetch the track's "next" response, find the Lyrics tab's `browseEndpoint`, browse it, and read the `musicDescriptionShelfRenderer.description` text. Plain lyrics only.
- **Transcript/captions:** fetch the transcript panel, read `transcriptCueRenderer.startOffsetMs` and `cue`. Line-timed captions, often noisy and punctuation-free.

These are valuable because they are keyed to the exact playing track, even though timing quality is lower. For non-platform apps, omit them.

---

## 10. Matching rules and scoring

### 10.1 The cardinal rule

**Reject rather than guess.** A provider's search rank is not a match. Every candidate must pass a minimum bar; if none does, return null and let the next provider try.

### 10.2 lrc.red strict matching

Given hits from a free-text search:

1. Normalize titles by removing bracketed sections and any ` - ...` suffix. This is the **core title**.
2. Extract the **version words** from the removed material, normalized: `live`, `remix`, `acoustic`, `unplugged`, `instrumental`, `karaoke`, `a cappella`, `demo`, `edit`, `cover`, `sped up`, `slowed`, `reverb`, `nightcore`, `lofi`, `orchestral`, `extended`, `version`.
3. A candidate passes only if:
   - core title equals the wanted core title,
   - version-word *sets* are equal (so "(Remastered 2011)" and "From 'Aashiqui 2'" are ignored, but "(Live)" is not),
   - at least one credited artist matches,
   - duration is within ~3 s when both are known.
4. Of the passing hits, pick the closest duration; the search rank breaks ties.

This is intentionally harsh. "Bohemian Rhapsody (Operatic Section / 2011 A Cappella Mix)" ranks above the actual song in a free-text search; strict matching rejects it.

### 10.3 Scoring model (PaxSenix-style)

If your provider returns a candidate list, score each candidate:

| Field | Exact | Partial | Miss |
|---|---:|---:|---:|
| Title | +20 | +10 (contains) | 0 |
| Artist | +15 | +5 (contains) | 0 |
| Duration | +10 (<3 s) | +5 (<10 s) | 0 |

- Require a minimum score (e.g. 10).
- Take the highest score; break ties by duration closeness.

### 10.4 Scoring model (Musixmatch-style)

| Field | Points |
|---|---:|
| Title exact | 80 |
| Title contains | 40 |
| Artist contains | 40 |
| Duration ≤2 s | 30 |
| Duration ≤5 s | 15 |
| Duration ≤10 s | 5 |
| Duration >10 s | −20 |

Take the highest score, but reject if the result is clearly implausible (e.g. duration penalty and no title match).

### 10.5 Duration tolerance

| Provider / context | Tolerance |
|---|---|
| lrc.red | 3 s |
| PaxSenix | 3 s for full points, 10 s partial |
| KuGou | 8 s |
| SimpMusic | 10 s |
| Musixmatch | graduated, penalty beyond 10 s |
| Generic fuzzy search | prefer closest; reject > 10–15 s |

Platform durations are often whole seconds, and editions can differ by a few seconds. Do not use zero tolerance; do not accept a 30 s difference.

### 10.6 Artist matching

- Split multi-artist strings on `, & ; / and x with feat ft`.
- Compare normalized tokens.
- Require **at least one** shared artist, not all of them. A search result may credit only the lead artist while the platform lists featured artists too.
- Handle "Artist - Topic" before comparison.

### 10.7 Title matching

- Compare normalized core titles.
- Ignore punctuation, case, accents and bracketed packaging.
- Do **not** ignore version words that name a different recording.
- If one title contains the other, treat it as a partial match only, not an exact one.

---

## 11. Parsing and normalization

All providers converge here. The output is always `LyricLine[]` with the invariants from §4.3.

### 11.1 TTML (Apple Music)

Apple's TTML is the richest common format.

```xml
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    itunes:timing="Word">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <ttm:agent type="other" xml:id="v2"/>
    </metadata>
  </head>
  <body>
    <div>
      <p begin="27.395" end="28.960" ttm:agent="v1">
        <span begin="27.395" end="27.549">I</span>
        <span begin="27.549" end="27.740">been</span>
        <span begin="27.740" end="28.070">tryna</span>
        <span begin="28.070" end="28.400">call</span>
      </p>
    </div>
  </body>
</tt>
```

Parsing rules:

1. One `<p>` = one line. `begin`/`end` are seconds, not milliseconds.
2. Each `<span>` = one syllable/run. `begin`/`end` are its own times.
3. **Adjacent spans with no whitespace between them are the same word.** `e` + `nough` = "enough". A space between spans separates words. This is the single most important rule in the format.
4. Skip spans with `ttm:role="x-translation"` or `x-roman`; they are alternate renderings of the same words and would duplicate the line.
5. Spans with `ttm:role="x-bg"` are the **background/answering vocal**. Collect them separately into `background`, not into the lead text.
6. A `<p>` with a timestamp but no spans is line-synced TTML. Use its `textContent` as the line text.
7. Read `ttm:agent` per paragraph for duet voices. Read `<ttm:agent xml:id type>` declarations from the head.
8. Ignore `<audio lyricOffset>`; it is written against a different master.
9. Harden the XML parser: disable DOCTYPE declarations, external entities and external parameter entities; enable secure processing where available. Lyrics come from third parties.
10. Sort paragraphs by `begin`.

Implementation caution: on Android, the DOM parser may file `ttm:agent` under its local name rather than the qualified name. Read the attribute by trying both the qualified name and any attribute whose node name/local name ends in the suffix. This exact difference is invisible on the JVM and breaks duet layout on-device.

### 11.2 LRC

```lrc
[00:27.39]I been tryna call
[00:31.83]I been on my own
```

Rules:

- Line stamp: `[mm:ss.xx]` or `[mm:ss.xxx]`. Two fraction digits = centiseconds; three = milliseconds.
- Metadata tags like `[ti:]`, `[ar:]`, `[al:]` have no timestamp; ignore them.
- A stamp with no text marks a gap. Keep it only if the silence is meaningful (see §11.9).
- Sort by time.
- Decode HTML entities if present.
- If no line has a timestamp, treat it as plain text (all lines `timeMs = 0`).

### 11.3 Enhanced LRC (A2)

```lrc
[00:27.39]<00:27.39>I <00:27.54>been <00:27.74>tryna <00:28.07>call
```

Rules:

- The line stamp is the line's start.
- Each `<mm:ss.xx>` stamps a word/syllable start.
- Only starts are written down: a word runs until the next stamp. The last word runs until the next line's start, or for a fixed tail (e.g. 800 ms) if it is the final line.
- Adjacent runs with no space between them are syllables of one word.
- A line may end with a bare stamp: it names no word, it states where the previous word stopped. Treat it as the line's end, not as an empty word.
- Decode entities (`&#x27;`, `&apos;`, `&amp;`, etc.) before display. Some providers serve rich sync HTML-escaped.
- If no line contains word stamps, return empty and let the caller fall back to plain LRC parsing.

### 11.4 QRC / YRC karaoke LRC

Two common shapes:

```
[31839,157]e(31839,157)nough(31996,533)
```

or suffix form:

```
[31839,157]e(31839,157)nough(31996,533)
```

Rules:

- Line header: `[startMs,durationMs]`.
- Word runs: `(startMs,durationMs)` before or after the text.
- Some files wrap the content in `LyricContent="..."`; extract and unescape it first.
- Only starts and durations are given; the word's end is `start + duration`.
- Spacing between runs encodes word boundaries exactly as in A2.
- Choose whichever of prefix/suffix parsing covers more characters (some files mix conventions).

### 11.5 JSON envelopes and plain text

Providers return many shapes:

- Raw TTML string.
- JSON with one of `ttml`, `lyrics`, `lrc`, `content`, `text`, `plainLyrics`, `syncedLyrics`, `line`, `lines`, `data`, `result`, `response`.
- Nested JSON-in-a-string.
- Markdown code fences.
- Error objects (`isError: true`, `ok: false`, non-empty `error`).
- Base64 content (KuGou).
- HTML-escaped TTML (`&lt;tt ...`).

A robust generic unwrapper:

1. Strip BOM and whitespace.
2. Strip Markdown code fences.
3. Try to parse as JSON.
4. If JSON:
   - Reject explicit error payloads.
   - Look through known content keys in order.
   - Recurse into string values that themselves parse as JSON.
   - Arrays: join extracted values with newlines.
5. If the result contains escaped TTML, unescape it.
6. Dispatch on content:
   - Contains `<tt` or the TTML namespace → TTML parser.
   - Matches karaoke LRC shape → QRC/YRC parser.
   - Otherwise → enhanced LRC, then plain LRC, then plain text.
7. Return null if no non-blank line survives.

Plain text handling:

- Trim each line.
- Drop empty lines.
- Drop metadata lines matching `[A-Za-z]+: ...`.
- Reject known error strings ("lyrics not found", "unavailable").
- Emit every line with `timeMs = 0`.

### 11.6 Merging syllables into words

All syllable-timed formats encode word boundaries the same way: **the space is left out between syllables of one word**.

Input runs:

```
("e", 31839–31996)
("nough ", 31996–32529)
```

Output word:

```
text: "enough"
startMs: 31839
endMs: 32529
syllables: [
  { startChar: 0, endChar: 1, startMs: 31839, endMs: 31996 },
  { startChar: 1, endChar: 6, startMs: 31996, endMs: 32529 }
]
```

Algorithm:

```
glue = spacingIsExplicit OR any run contains whitespace
current = ""
for each run:
  content = trim(run.raw)
  if content is empty: flush(); continue
  joins = glue
        AND current is not empty
        AND run.raw does not start with whitespace
        AND neither last char of current nor first char of content is from an unspaced script
  if not joins: flush()
  if current is empty: start = run.startMs
  append content to current
  record syllable [run.startMs, run.endMs, from, current.length]
  if not glue OR run.raw ends with whitespace: flush()
flush()
```

Special cases:

- **Han, kana, Hangul, Thai** are written without spaces. A missing space is not a word-boundary signal. Keep each run as its own word.
- **A line with no whitespace anywhere** is not stating word boundaries; keep runs as words unless the caller explicitly says the spacing was reconstructed (`spacingIsExplicit`).
- **Ephemeral whitespace-only runs** (a lone space, or the bare closing stamp in A2) terminate the current word.

### 11.7 Background vocals

Apple gives this structurally: `ttm:role="x-bg"`. Everyone else writes it as a bracket:

```
I'm foolishly patient (Foolishly patient)
```

Why split it out?

- The bracketed words are sung **over** the following line, not after the lead.
- If left inline, the active-line cursor advances when the lead stamp passes, and the bracket is cut off mid-phrase.
- Drawn as a separate `background` line, it keeps its own timings and renders underneath the lead.

Algorithm:

1. If the provider already marked a background (TTML `x-bg`), use it.
2. Otherwise find the last opening bracket `(` or `[` that starts a trailing parenthetical.
3. Split into `lead` (before) and `backing` (from the bracket).
4. Reject if the lead is empty or the backing has no letters/digits.
5. If the line has no word timings: both halves share the line's `timeMs` and `sungUntilMs`; they simply stack.
6. If the line has word timings: split at the word boundary corresponding to the bracket's character offset. The backing words become the background line with their own timings. If the bracket opens mid-word, leave the line alone.
7. Keep the parentheses in the text. They are what the provider published, and the smaller line already communicates "this is the answer".

Never nest backgrounds: a background line's own `background` is null.

### 11.8 Duet alignment

TTML assigns each paragraph a `ttm:agent`. Apple lays duet voices on opposite sides of the panel so call-and-response reads as two people.

Rules:

- Do not map one side per voice. **Alternate sides every time the voice changes.** This keeps a three-way song reading as a conversation instead of stacking two voices on one side.
- A line sung by the group (`type="group"`, or Apple's reserved `v1000`) belongs to neither side: put it on the start side and **do not disturb whose turn it is**.
- Apple's reserved ids: `v1000` = group, `v2000` = the other singer.
- A voice with no declaration is treated as a person.
- If **85% or more** of placed lines land on the right, flip the whole song. This happens when the song opens on the voice the alternation starts away from; the rule is technically correct but visually wrong.
- Apply the same algorithm to non-TTML providers that name voices (e.g. LyricsPlus `metadata.agents`). The side a line sits on is a property of the song; switching providers should not flip the panel.

### 11.9 Instrumental gaps

A gap is a line with `text = ""`. It tells the UI "no one is singing; do not leave the previous line lit".

Rules:

- Minimum gap: ~4 s. Shorter breaks are not worth interrupting the line for.
- Only insert a gap **when the previous line has a known end** (`words` or `sungUntilMs`). Without an end, the distance to the next stamp is the line's own slot, not evidence of silence; treating it as a gap puts a note after every line of a line-synced source.
- Gap timestamp: the previous line's `endMs`, not the next line's stamp. The note should appear the moment the vocal stops.
- Never place a gap at the same timestamp as a line; the active-line cursor takes the last line whose stamp has passed, so the gap would sit on top of the line and prevent it from lighting.
- If the first line starts at or after the minimum gap, insert a gap at 0 for the intro.
- A trailing bare stamp in LRC closes the last line; keep it.

### 11.10 Normalization order

Apply, in this order:

1. Parse to raw lines (with line and word timing).
2. Sort by `timeMs`.
3. Merge syllables into words.
4. Split background vocals.
5. Compute duet alignment.
6. Insert instrumental gaps.
7. Validate invariants; discard malformed lines rather than crashing.
8. Report `wordSynced = lines.some(l => l.words.length > 0)`.

---

## 12. Caching and persistence

Lyrics for a given recording are immutable. Cache at several levels.

### 12.1 L1: in-memory recording cache

- Key: platform track id.
- Value: ISRC.
- Bounded LRU (~100 entries), synchronized.
- Purpose: avoid repeating the 2.5 s identify request.
- Do not persist it. A wrong answer persisted is worse than one fuzzy match.

### 12.2 L2: result cache

- Key: `videoId | durationMs | title | artist | album? | onlyProvider? | providerSequence`.
  Include the settings that can change the answer. If the user reorders providers or picks a specific provider, the old result must not be served.
- Value: the normalized `LyricsResult`, including a null/miss marker.
- TTL: ~12 hours.
- In-memory (desktop/web) or a small disk cache (mobile) is fine.
- Cache **misses too**, but invalidate the whole cache when:
  - the user grants a host permission,
  - the user changes providers or order,
  - the app updates and new providers are added.

A null cached for 12 hours is a deliberate trade-off: it avoids hammering providers for tracks that have no lyrics. Provide a manual "retry" that bypasses/clears the cache.

### 12.3 L3: on-disk lyrics for downloaded tracks

If the app downloads audio, write lyrics into the file at download time:

- Standard container lyrics field: plain line-stamped LRC. Every other player reads it.
- App-private field (e.g. `APP_WORD_LYRICS`): enhanced A2 LRC with word timings. Other players ignore it; your app reads it back and preserves word-level animation offline.
- For segmented packages (HLS/DASH directories), write a `lyrics.lrc` sidecar next to the playlist.
- On playback, try local lyrics **first**, before any network lookup.
- Prefer the private word-timed field; fall back to the standard field.
- Never throw on a malformed or missing tag; fall back to the network.

LRC writer rules:

- Use `[mm:ss.xx]` with **two** fraction digits. It has the widest reader support.
- Format digits with ASCII, not locale-sensitive formatting. `String.format("%02d")` under an Arabic/Bengali/Indic locale can emit non-ASCII digits that no LRC parser matches.
- Do not wrap minutes at 99.
- Do not write `[ti:]`/`[ar:]`/`[al:]` headers; the container already carries them.
- For enhanced output, write one `<mm:ss.xx>` per syllable and **no space between syllables of a word**; write a space between words. Close each line with a bare stamp so the last word gets an end.
- Flatten background vocals back onto the lead line in the standard field. LRC cannot express "underneath"; giving the background its own stamp would add a line the song does not have.
- Keep enhanced LRC in a separate field so readers that do not implement A2 do not display angle-bracket noise.

### 12.4 Prefetch

Start the lookup for the next track shortly before it plays, if your player knows the queue. This hides the entire latency budget behind the current song. Guard against prefetching when the queue changes.

---

## 13. Wiring lyrics to playback

### 13.1 Active line selection

Given sorted lines and a playback position:

```
active = last line where line.timeMs <= position
```

This naturally handles gaps: the gap line becomes active at the moment the vocal stops, and the previous line stops being highlighted.

Do not recompute "the next line" by scanning from the start on every frame. Keep an index and advance it; reset on seek.

### 13.2 The steered clock

The naive approach — read `audio.currentTime` every frame and use it directly — produces visible stutter and back-and-forth movement because:

- platform position updates are coarse and irregular,
- different APIs report time at different moments,
- buffering and seeks create jumps,
- the UI frame clock and the audio clock drift.

Use a **steered clock** instead of a directly-set clock.

Properties:

1. **Date a reading by when it was taken, not when it was seen.** If the audio API returns a position but you only process it 40 ms later, carry it forward by 40 ms.
2. **Only an announced jump moves the lyrics backwards.** A seek, a track change or a loop is announced explicitly. Ordinary readings never rewind the display.
3. **Readings steer, they do not set.** The displayed position advances at the learned playback rate and closes the gap to the newest reading gradually, at most ~25% faster or ~50% slower than normal.
4. **Reject outliers.** A reading is accepted only if it is consistent with the current anchor within a tolerance. Two consecutive consistent outliers can replace the anchor; more than that forces a re-anchor.
5. **Learn the playback rate.** Estimate the ratio between song time and wall time over a window; clamp it to a sane range.
6. **Glide small corrections; snap large ones.** A correction over ~300 ms glides over ~260 ms; a discrepancy over ~2 s snaps.
7. **Hold when paused.** Stop the frame loop while paused and settle on the reported position.

Reference constants (tune to taste):

| Constant | Value | Meaning |
|---|---:|---|
| Outlier tolerance | 250 ms | Base acceptance window |
| Rate slack (settled) | 0.20 | Tolerance grows with elapsed time |
| Rate slack (unsettled) | 0.75 | Looser while learning |
| Max rejections | 2 | Then force re-anchor |
| Rate window | 4 s | Window for rate estimation |
| Min rate span | 900 ms | Minimum span for a full estimate |
| Min pair span | 300 ms | Minimum for a pairwise estimate |
| Rate clamp | 0.25–4.0 | Sane playback rates |
| Correction time | 600 ms | Time constant for closing error |
| Max slew | +25% | Never speed up more than this |
| Max slow | −50% | Never slow down more than this |
| Glide threshold | 300 ms | Error above which to glide |
| Glide duration | 260 ms | Glide length |
| Glide max | 2 s | Above this, snap |
| Lost | 3 s | Above this, snap immediately |

Example (pseudocode, with the constants from the table above):

```
state:
  displayedMs
  anchorAt, anchorMs      // newest believed reading, dated
  rate                    // learned song-time per wall-time
  lastNow
  glideStart, glideOffset
  suspectAt, suspectMs, rejections
  lastDiscontinuity, jumpPending

onFrame(now, reported, sampledAt, discontinuity):
  if discontinuity changed:
    if not first frame: jumpPending = true
    lastDiscontinuity = discontinuity

  if first frame:
    lastNow = now
    anchor(sampledAt or now, reported)
    displayedMs = targetAt(now)
    return displayedMs

  dt = max(0, now - lastNow)
  lastNow = now
  step = dt * rate
  target = targetAt(now)
  error = target - (displayedMs + step)

  // Advance, then close the gap.
  if error <= -LOST_MS or error >= LOST_MS:
    displayedMs = target                                  // snap: seek or lost
  else if error >= GLIDE_FROM_MS:
    startGlide(now, displayedMs - (target - step))        // small visible glide
    displayedMs = target + glideOffset * (1 - smoothstep(progress))
  else:
    closing = error * (dt / (dt + CORRECTION_MS))
    displayedMs += step + clamp(closing, -MAX_SLOW * step, +MAX_SLEW * step)

  // Take a new reading only if it is consistent with the anchor.
  if reading is new and sampledAt >= anchorAt:
    if jumpPending:
      jumpPending = false
      anchor(sampledAt, reported)
      jumpTo(now)                                         // announced seek
    else:
      expected = anchorMs + (sampledAt - anchorAt) * rate
      if abs(reported - expected) <= 250 + abs(sampledAt - anchorAt) * 0.2:
        anchor(sampledAt, reported)                       // consistent: steer
      else:
        // Outlier handling: accept two consecutive consistent outliers,
        // otherwise reject; after MAX_REJECTIONS, force a re-anchor.
        ...

  learnRate()                                             // from the anchor history
  return truncate(displayedMs)
```

The exact implementation can be simpler than the reference; the three properties that matter are **dated readings**, **no unannounced rewind**, and **steering rather than setting**.

### 13.3 Manual offset

Some releases are timed against a different master. Let the user adjust:

```
displayedPosition = max(0, playerPosition + offsetMs)
seekTarget = line.timeMs + offsetMs
```

- Positive offset delays lyrics.
- Negative offset advances them.
- Clamp the display clock at 0.
- Persist the offset per track if possible; otherwise per session.

### 13.4 Rendering the sweep

For word-synced lyrics:

- Lay out each word as a single unit.
- Compute the character count sung at the current position (see `charsSungAt`).
- Reveal characters up to that count.
- Optionally animate held words letter by letter: a word held longer than ~1 s can swell each letter in turn, staggered by ~9% of the word's duration, with the movement settling over ~700 ms. Skip this for scripts whose letters are not laid out independently (Han, kana, Hangul, RTL joined scripts) and for hyphenated words.
- Lift each word as it is sung, with a height proportional to how long it is held; settle it back after it ends. This is what makes the animation read as singing rather than a progress bar.

For line-synced lyrics:

- Highlight the whole line when `position >= line.timeMs` and until the next line starts.
- Optionally sweep the line over the distance to the next line, but do not pretend it is word timing.

For unsynced lyrics:

- Show all lines, no highlighting, scroll manually.

### 13.5 Track changes and generations

Every lookup belongs to a generation token. When the track changes:

- Increment the generation.
- Cancel the previous lookup.
- Ignore any late callbacks whose generation is stale.
- Clear the previous lyrics immediately, or keep them dimmed until the new result arrives (product decision).

This prevents the classic bug where track B briefly displays track A's lyrics.

---

## 14. Settings and provider picker UI

### 14.1 Settings schema

```json
{
  "lyricsEnabled": true,
  "lyricsSources": ["lrc-red", "bini", "better-lyrics", "lrclib"],
  "lyricsSourceOrder": ["lrc-red", "bini", "better-lyrics", "lyrics-plus", "lrclib"],
  "preferSyllableTiming": false,
  "offsetMs": 0,
  "paxsenixApiKey": "",
  "translationLanguage": null
}
```

Rules:

- Persist providers **by id/name**, not by position. Then the default order can change without scrambling a user's saved order.
- When a new provider is added, slot it in at its declared default position relative to the providers the user already has, not at the bottom.
- Hidden providers are never offered and never contacted, even if a stale saved setting names them.
- An empty set means "no lyrics", which is the same as the feature being off. Do not treat it as "all".

### 14.2 Provider picker state machine

Expose per-provider state to the UI:

```
NOT_FETCHED ──(lookup starts)──> FETCHING ──(found)──> FOUND
                                      │
                                      ├──(miss)──> NOT_FOUND
                                      └──(cancelled)──> NOT_FETCHED
```

- `FOUND`: select from memory; no network request.
- `FETCHING`: if the user taps it, remember the selection and apply the result when the automatic attempt completes.
- `NOT_FETCHED`: run a dedicated single-provider lookup.
- `NOT_FOUND`: inert; do not re-ask automatically.

This gives the user a manual override without re-running the whole race. It also makes failures legible: "this provider was asked and missed" versus "this provider was never asked".

### 14.3 Provider descriptions

Show users what each provider is good at:

- "Apple timings by recording, syllable by syllable"
- "The same Apple timings, matched on the recording itself"
- "QQ Music karaoke timings"
- "Word timing, on community mirrors"
- "Matched on the video, so never the wrong edit"
- "Whole lines, strong outside the English catalogue"
- "Plain text fallback, massive web catalogue"

The trade-offs are real and personal. Users may be in a region where a provider is blocked, or may not want to talk to a given host.

---

## 15. Offline and downloaded tracks

If the app supports downloads:

1. At download time, fetch lyrics once using the same engine.
2. Write them into the file or alongside it.
3. On playback, read local lyrics before any network call.
4. If local lyrics are absent or corrupt, fall back to the network.

Supported containers and tags:

| Container | Standard lyrics field | Private word-timed field |
|---|---|---|
| MP4/M4A | `©lyr` atom | custom freeform atom |
| FLAC | `LYRICS` Vorbis comment | custom `APP_WORD_LYRICS` |
| WebM/Opus | `LYRICS` tag | custom tag |
| HLS/DASH package | `lyrics.lrc` sidecar | same sidecar (enhanced) |

Cap reads: metadata regions are small in all containers, but a corrupt file can claim any length. Read at most a few megabytes (e.g. 8 MB) when searching for a tag. Cap writes (e.g. 64 KB).

Reading rules:

- Never throw. A missing tag is null.
- Try the private word-timed field first.
- Fall back to the standard field.
- Parse with the same LRC/A2 parser used online.
- Run the same background-vocal normalization so a downloaded track looks identical to a streamed one.

---

## 16. Translation and romanization (optional)

Translation is a separate concern from fetching, but users expect it.

### 16.1 Pipeline

1. **Flatten** the lyric lines into translation slots:
   - each lead line's text,
   - each background line's text,
   - section headers (optional, flagged so they can be left untranslated or translated differently).
2. **Batch** slots into requests of at most ~3,500 characters.
3. Run at most 2 requests in parallel; do not compete with playback for every connection.
4. Send **numbered markers** around each slot so the response can be mapped back positionally. A JSON array is not reliable across translation engines; private-use Unicode markers survive translation better than ASCII brackets.
5. Give each request a **12-second deadline**. If any batch fails or is malformed, discard the whole translation; keep the original lyrics on screen.
6. Detect the source language from the responses, weighted by text length.
7. If the source language equals the target, return a `SameLanguage` result; do not show a pointless translation.
8. **Rebuild** the lines:
   - Put translated text on the same lines.
   - Keep the original timing objects untouched.
   - For word-synced lines, attach the original line as `timingSource`, so the translated text's sweep and animation are driven by the original word timings. Word counts and order differ across languages; distributing timing by character proportion is wrong.
   - Keep line-synced lines line-synced.
9. Cache by a **SHA-256** of `track id + target language + source texts`. Use a bounded memory cache plus a compressed disk cache (e.g. gzip, 2 MB cap). Version the cache so a logic fix invalidates old answers.
10. Handle Latin-script source languages (Hindi/Urdu/Punjabi written in Latin): the translator may return phrases unchanged. If a significant portion survives untouched, use a transliteration service to restore the native script, translate that, and keep the retry only if it actually transforms more text.

### 16.2 Romanization

- Same batching and caching, different prompt/endpoint.
- If the input has no non-Latin letters, return `AlreadyRomanized`.
- If the output is identical to the input, treat it as a failure (for non-Latin input), not a success.
- Exclude the destination language from the cache key for romanization: changing the translation target does not change pronunciation.

### 16.3 UI behavior

- Keep the original lines in memory always.
- Toggle between original and translated without remounting the list.
- Carry the mode into the compact "current line" strip above the scrubber.
- If translation is unavailable, leave the original untouched and show a subtle error, not a blank panel.

---

## 17. Platform notes

### 17.1 Android / Kotlin

- Use `Dispatchers.IO` for all provider work.
- Use `async`/`Deferred` with `CoroutineStart.LAZY` for the scraper.
- Use `viewModelScope` or an application scope; cancel on track change.
- A shared OkHttp client with a short call timeout derived from the main client keeps the connection pool and DNS cache warm.
- DOM parsing is available but parser behavior differs between the JVM and Android's Expat-backed implementation; read namespaced attributes defensively.
- Persist settings with DataStore/SharedPreferences; persist caches in `cacheDir` so the OS can reclaim them.

### 17.2 iOS / Swift

- Use `async let` or a `TaskGroup` for the race; cancellation is cooperative.
- URLSession's `timeoutIntervalForRequest` and `timeoutIntervalForResource` map to connect/total deadlines.
- `XMLParser` is a pull parser; handle namespaces explicitly.
- Use `NSCache` for the in-memory result cache and file coordination for disk caches.

### 17.3 Desktop (JVM/native)

- The same engine works unchanged.
- Keep a 12-hour in-memory result cache keyed on track id + duration + title + artist + selected provider.
- Settings are often label-keyed in a preferences store; map labels back to provider ids carefully, and handle renamed providers.

### 17.4 Web

The web has one extra problem: **CORS**.

Measured categories (as of the reference implementation):

| Host type | CORS | Route |
|---|---|---|
| lrc.red, lyrics-api.binimum.org, lyrics.paxsenix.org, lrclib.net | `*` | direct `fetch` |
| Some LyricsPlus mirrors | `*` | direct |
| lyrics-api.boidu.dev, unison.boidu.dev | echoes localhost only | direct in dev, proxy in production |
| KuGou, Musixmatch, Genius, music.apple.com, amp-api, api.paxsenix.org | none | proxy / extension |

Options for non-CORS hosts:

1. **Server-side proxy** you control. Simplest and most reliable, but centralizes cost and legal exposure.
2. **Browser extension** with `optional_host_permissions` per lyric host:
   - The page asks the extension to fetch a URL.
   - The extension checks the host against an allow-list.
   - The extension requests permission only in response to a user click (Chrome requirement).
   - Until granted, return a distinct `permission` error, not a generic miss.
   - When the tab regains focus, re-query granted permissions; if a host was just allowed, clear the lyric cache and retry.
3. **User-supplied proxy URL** in settings.

Never silently pretend a CORS failure is "no lyrics". Surface a permission/action state so the user can fix it.

Other web details:

- Use a query library keyed on `[videoId, title, artist, selectedProvider, order, preferSyllables]`.
- Set `staleTime` to Infinity for the session; the result is immutable.
- Lazy-load the renderer and any heavy lyric component only when the panel opens.
- If rendering TTML, write our normalized lines into TTML for the renderer rather than letting the renderer contact its own providers. Otherwise its async load can finish after yours and overwrite the lyrics.

### 17.5 Backend service

If you centralize fetching server-side:

- Cache aggressively at the edge.
- Rate-limit per user/IP; the third parties are not yours.
- Do not log full lyrics (copyright) or API keys.
- Keep provider timeouts shorter than your own request timeout so you can return a partial/fallback result.
- Consider streaming the first result and updating later (`Server-Sent Events`), but most clients are better served by one race.

---

## 18. Failure modes and observability

### 18.1 Failure taxonomy

| Failure | Meaning | Handling |
|---|---|---|
| Timeout | Provider too slow | Miss; fall through |
| Connection error | DNS/TLS/network | Miss; count toward circuit breaker |
| HTTP 4xx | Bad request/geo-block/rate limit | Miss; distinguish 403 geo-block in logs |
| HTTP 5xx | Provider outage | Miss; back off that host |
| Empty body | No lyrics | Miss |
| Parse failure | Format changed | Miss; log parser name and payload hash (not payload) |
| Wrong match | Candidate failed matching | Miss; this is a success of the matcher |
| Permission denied (web) | Host not granted | Surface actionable state |
| Cancelled | Loser of the race | Do not report as "not found" |

### 18.2 Metrics worth collecting

- Lookup success rate per provider.
- p50/p95 latency per provider.
- Time to first usable result.
- Win rate by provider (which source actually supplied the lyrics).
- Word-synced vs line-synced vs plain distribution.
- Match rejection rate (candidates found but rejected).
- Cache hit rate.
- Parse failures per provider/version.

Do not log lyric text in production telemetry; log counts, durations and identifiers only.

### 18.3 Circuit breaker (recommended addition)

If a provider fails N times in a row, skip it for a cooldown (e.g. 10 minutes) instead of making every track wait for its timeout. Keep it per-host and reset on success. This is especially valuable for mirrors and scrapers.

### 18.4 User-visible states

- `loading`: skeleton or dimmed previous lyrics.
- `found`: render.
- `no-lyrics`: "No lyrics found" with a provider picker/retry.
- `feature-off`: hide the lyric strip entirely; do not show an error.
- `permission-needed` (web): "Allow access to {host}" button.

---

## 19. Security and legal

### 19.1 Security

- Treat every provider response as untrusted input.
- Harden XML parsing against XXE and entity expansion.
- Cap response sizes; a lyric document should never be tens of megabytes.
- Validate ISRC format (`^[A-Z]{2}[A-Z0-9]{3}\d{7}$`) before putting it in a URL path.
- Never interpolate raw user input into a URL without encoding.
- Do not execute HTML from scraped pages; parse text only.
- Store API keys in the platform keystore, not in plain preferences.
- Do not include third-party signing secrets in client code if you can avoid it; they rotate and they are not yours.

### 19.2 Legal and ethical

- These providers are third-party services. Respect their terms of service and robots directives.
- Identify your client with a truthful `User-Agent`; do not impersonate a browser unless the service requires it and you understand the trade-off.
- Cache lyrics; do not re-request the same track on every play.
- Do not redistribute lyrics or build a public lyrics database from fetched content without checking licensing.
- Lyrics are copyrighted. Displaying them to a user in a player is different from serving them as a public API.
- Provide a way for users to disable any provider, and honor it absolutely.
- Endpoints can disappear. Design the provider list as a plug-in surface, not a hard dependency.

---

## 20. Testing strategy

### 20.1 Fixtures

Capture one real response per provider and per format, and store them as fixtures:

```
fixtures/lyrics/lrc-red-search.json
fixtures/lyrics/lrc-red-document.ttml
fixtures/lyrics/bini-search.json
fixtures/lyrics/better-lyrics.json
fixtures/lyrics/lyrics-plus.json
fixtures/lyrics/lrclib-get.json
fixtures/lyrics/simpmusic.json
fixtures/lyrics/kugou-download.json
fixtures/lyrics/genius-search.json
fixtures/lyrics/genius-page.html
```

Use a well-known track that exists on every catalogue and has synced lyrics. Record the date and the exact request URL/headers next to each fixture.

### 20.2 Parser tests

- Golden tests: fixture → expected normalized lines.
- Invariant tests: sorted, non-overlapping syllables, background never nested, gaps never share a line's stamp.
- Edge cases: empty body, HTML error page, JSON error object, code-fenced JSON, escaped TTML, base64, CRLF, BOM, non-ASCII digits.
- Script cases: Han/kana/Thai without spaces, RTL, combining accents.

### 20.3 Race tests

Use fake providers with controlled delays:

- Lower-priority word-synced result beats higher-priority slow line-synced result.
- Higher-priority line-synced result wins when "prefer syllables" is off.
- "Prefer syllables" on waits for a word-synced lower-priority result and falls back to line-synced.
- Cancelled jobs are not reported as misses.
- The scraper is never started if a timed result exists.
- Shared document URL is fetched once.
- Stale generation callbacks are ignored.

### 20.4 Matching tests

- Single vs album cut with different words.
- "(Live)" vs studio: must reject.
- "(Remastered 2011)": must accept.
- "feat." in title: must strip.
- "(Official Video)": must strip.
- Artist with accents and " - Topic".
- Multi-artist strings.
- Duration off by 2 s: accept; off by 30 s: reject.

### 20.5 Clock tests

- Positive/negative offsets.
- Seek forward/backward.
- Paused playback.
- Duplicate and out-of-order readings.
- Rate drift.
- Track change mid-frame.

### 20.6 Manual verification

- A track with known syllable timing: verify the sweep matches the vocal within ~50 ms.
- A duet: verify sides alternate.
- A track with backing vocals: verify the bracket renders underneath and keeps its own timing.
- A track with a long instrumental: verify the gap appears at the vocal's end, not the next line's start.
- A downloaded track with the network off: verify lyrics still render.
- A provider miss: verify the next provider's result appears without a UI error.

---

## 21. Implementation roadmap

Build in this order. Each step is independently testable.

1. **Domain model and parsers.**
   - `LyricLine`, `LyricWord`, `LyricSyllable`.
   - TTML, LRC, enhanced LRC, karaoke LRC, plain text.
   - Syllable merging, background split, gaps.
   - Tests against fixtures. No network yet.

2. **One provider end-to-end.**
   - LRCLIB is the easiest: two endpoints, JSON, line-synced LRC.
   - Wire it to a fake track and render it.

3. **Query normalization and matching.**
   - Title/artist cleanup.
   - Duration and candidate scoring.
   - Negative-match tests.

4. **A word-timed provider.**
   - lrc.red or BetterLyrics.
   - Verify word/syllable sweep.

5. **The race.**
   - Two or three providers, concurrent start, priority-ordered await.
   - Cancellation and generation tokens.
   - Per-provider UI state.

6. **ISRC prepass.**
   - BiniLyrics identify.
   - In-memory LRU and shared document cache.
   - Verify the wrong-edit case.

7. **Settings and provider picker.**
   - Enable/disable, reorder, prefer syllables.
   - Manual single-provider lookup.

8. **Caching.**
   - Result cache with a key that includes settings.
   - Invalidation on provider changes.

9. **Renderer polish.**
   - Steered clock.
   - Offset control.
   - Duet sides, background vocals, gaps.
   - Translation/romanization if desired.

10. **Offline.**
    - Write tags at download time.
    - Read local first.
    - Sidecar for segmented packages.

11. **Hardening.**
    - Timeouts, circuit breaker, overall deadline.
    - Metrics and logging.
    - Permission/CORS UX on web.

12. **Add providers one at a time.**
    - Each addition is one adapter + one fixture + one test.
    - Never let a new provider destabilize the chain.

---

## Appendix A: endpoint quick reference

All endpoints are unofficial and may change. Verify before shipping.

| Provider | Request | Auth | Output |
|---|---|---|---|
| lrc.red search | `GET https://lrc.red/search.json?q={title} {artist}` | none | JSON hits |
| lrc.red document | `GET https://lrc.red/s/{ISRC}.ttml` | none | TTML |
| BiniLyrics identify | `GET https://lyrics-api.binimum.org/?track=&artist=&album=&duration=` | none | JSON hit with ISRC + lyrics URL |
| BiniLyrics by ISRC | `GET https://lyrics-api.binimum.org/?isrc={ISRC}` | none | JSON hit |
| BetterLyrics | `GET https://lyrics-api.boidu.dev/getLyrics?s=&a=&d=&al=` | none | TTML / JSON |
| BetterLyrics Portato | `GET https://lyrics-api.boidu.dev/qq/getLyrics?s=&a=&d=&al=` | none | TTML / JSON |
| PaxSenix Apple | `GET https://lyrics.paxsenix.org/apple-music/lyrics?id={id}&ttml=true` | none | JSON/TTML |
| Apple search | `GET https://amp-api.music.apple.com/v1/catalog/us/search?term=&types=songs&limit=10&l=en-US` | scraped bearer | JSON |
| PaxSenix Spotify search | `GET https://api.paxsenix.org/spotify/search?q=` | Bearer key | JSON |
| PaxSenix Spotify lyrics | `GET https://api.paxsenix.org/lyrics/spotify?id=` | Bearer key | JSON |
| PaxSenix Musixmatch | `GET https://api.paxsenix.org/lyrics/musixmatch?t=&a=&d=` | Bearer key | JSON |
| PaxSenix generic | `GET https://api.paxsenix.org/lyrics/lrcget?q=` | Bearer key | JSON candidates |
| LyricsPlus | `GET {mirror}/v2/lyrics/get?title=&artist=&duration=&album=&isrc=` | none | JSON |
| Unison | `GET https://unison.boidu.dev/lyrics?song=&artist=&album=&duration=` | none | JSON |
| SimpMusic | `GET https://api-lyrics.simpmusic.org/v1/{videoId}` | none | JSON |
| LRCLIB exact | `GET https://lrclib.net/api/get?track_name=&artist_name=&duration=` | none | JSON |
| LRCLIB search | `GET https://lrclib.net/api/search?track_name=&artist_name=` | none | JSON array |
| Musixmatch search | `GET https://apic.musixmatch.com/ws/1.1/track.search?...` | signed | JSON |
| Musixmatch subtitle | `GET https://apic.musixmatch.com/ws/1.1/track.subtitle.get?...` | signed | JSON |
| Musixmatch rich sync | `GET https://apic.musixmatch.com/ws/1.1/track.richsync.get?...` | signed | JSON |
| KuGou song search | `GET https://mobileservice.kugou.com/api/v3/search/song?...&keyword=` | none | JSON |
| KuGou lyrics search | `GET https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=` | none | JSON |
| KuGou download | `GET https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id=&accesskey=` | none | Base64 LRC |
| Genius search | `GET https://genius.com/api/search/multi?q=` | none | JSON |
| YouTube Music lyrics | platform InnerTube browse | platform | JSON |
| YouTube captions | platform InnerTube transcript | platform | JSON |

---

## Appendix B: wire-format examples

### B.1 Apple TTML (word-timed)

```xml
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    itunes:timing="Word">
  <body>
    <div>
      <p begin="27.395" end="28.960" ttm:agent="v1">
        <span begin="27.395" end="27.549">I</span>
        <span begin="27.549" end="27.740">been</span>
        <span begin="27.740" end="28.070">tryna</span>
        <span begin="28.070" end="28.400">call</span>
      </p>
    </div>
  </body>
</tt>
```

Syllable split:

```xml
<p begin="31.830" end="33.100">
  <span begin="31.830" end="31.987">e</span><span begin="31.987" end="32.520">nough</span>
</p>
```

The absence of whitespace between the two spans means one word: "enough".

Background vocal:

```xml
<p begin="40.000" end="43.000">
  <span begin="40.000" end="42.000">I'm foolishly patient</span>
  <span ttm:role="x-bg">
    <span begin="40.500" end="42.400">(Foolishly patient)</span>
  </span>
</p>
```

### B.2 Plain LRC

```lrc
[00:27.39]I been tryna call
[00:31.83]I been on my own
[00:36.10]
[00:40.00]I need you to know
```

### B.3 Enhanced (A2) LRC

```lrc
[00:27.39]<00:27.39>I <00:27.54>been <00:27.74>tryna <00:28.07>call<00:28.40>
[00:31.83]<00:31.83>I <00:32.10>been <00:32.40>on <00:32.60>my <00:32.80>own<00:33.20>
```

### B.4 QRC / YRC

```lrc
[31839,157]e(31839,157)nough(31996,533)
```

### B.5 BiniLyrics hit

```json
{
  "total": 1,
  "source": "HIT-EXACT",
  "results": [
    {
      "track_name": "Dracula",
      "artist_name": "Tame Impala",
      "album_name": "Dracula",
      "duration": 205,
      "isrc": "AUUM72500001",
      "timing_type": "word",
      "lyrics_url": "https://lrc.red/s/AUUM72500001.ttml"
    }
  ]
}
```

### B.6 LyricsPlus v2

```json
{
  "type": "lyrics",
  "lyrics": [
    {
      "time": 27390,
      "duration": 1570,
      "text": "I been tryna call",
      "syllabus": [
        { "time": 27390, "duration": 159, "text": "I " },
        { "time": 27549, "duration": 191, "text": "been " }
      ],
      "element": { "singer": "v1" }
    }
  ],
  "metadata": {
    "agents": {
      "v1": { "type": "person", "alias": "Lead" },
      "v2": { "type": "other", "alias": "Answer" }
    }
  }
}
```

### B.7 Unison entry

```json
{
  "success": true,
  "data": {
    "song": "Dracula",
    "artist": "Tame Impala",
    "lyrics": "[00:27.39]I been tryna call\n[00:31.83]I been on my own",
    "format": "lrc",
    "syncType": "linesync",
    "confidence": "high",
    "voteCount": 12
  }
}
```

### B.8 SimpMusic

```json
{
  "success": true,
  "data": [
    {
      "duration": 205,
      "richSyncLyrics": "[00:27.39]<00:27.39>I <00:27.54>been ...",
      "syncedLyrics": "[00:27.39]I been tryna call\n...",
      "plainLyrics": "I been tryna call\n..."
    }
  ]
}
```

---

## Appendix C: default priority rationale

Why the default order is what it is.

1. **lrc.red leads** because it is Apple's syllable timing filed by recording, with no middleman. A known ISRC costs one request and cannot return the wrong edit.
2. **BiniLyrics second** because it is the only provider that *reports* an ISRC and can be used as the prepass. It shares lrc.red's catalogue, so the two documents are often byte-identical, and the shared document cache makes the overlap nearly free.
3. **BetterLyrics third** because it is a second, independent host over the same Apple catalogue. If one host is having a bad day, the timing quality does not collapse.
4. **Portato fourth** because QQ Music karaoke timing covers a different catalogue (C-pop and beyond) with comparable granularity.
5. **PaxSenix fifth** as a keyless Apple route with a different matcher. Its authenticated Spotify/Musixmatch routes follow because they need a user key and have narrower coverage.
6. **LyricsPlus next** because it has the finest timing of any aggregator (Apple syllable splits, QQ, Musixmatch), but runs on volunteer mirrors and is the flakiest host. Putting it behind four stable hosts means a track rarely waits on a dead mirror.
7. **Unison** is contributed rather than licensed. It occasionally has a track no one else does, but coverage is thin. It sits low.
8. **Platform-native sources (YouTube captions/Lyrics tab)** are keyed to the exact playing video and always worth having as a fallback, but their timing is coarse or absent.
9. **KuGou** carries a lot outside the English catalogue and is line-synced only. It is high enough to catch regional tracks and low enough not to outrank word-timed sources.
10. **LRCLIB and Musixmatch** are line-synced but extremely reliable and broad. They are the dependable floor.
11. **Genius** is a plain-text scraper with a huge catalogue. It is last because it has no timing and is the most rate-limited. It also starts lazily so it is never contacted when a timed answer exists.

Hidden providers:

- **SimpMusic** is keyed to the exact video, which is excellent when it works, but it geoblocks entire regions and its coverage is narrow. Hidden avoids disappointing users who enable it expecting broad coverage; power users can still expose it.
- **Megalobiz** is community LRC with thin coverage and unstable hosting.

---

## Appendix D: constants worth tuning

| Constant | Reference value | Why |
|---|---:|---|
| Identify prepass timeout | 2.5 s | Fail-open; a slow metadata host must not empty the panel |
| Ordinary provider call timeout | 6 s | A lyric after the second chorus is useless |
| Connect timeout | 3 s | Fail fast on dead hosts |
| Authenticated provider timeout | 10–15 s | Backend may resolve against an upstream catalogue |
| Scraper timeout | 8 s | HTML fetch + parse |
| Overall lookup deadline (recommended) | 8–12 s | Hard upper bound for the ordered race |
| Result cache TTL | 12 h | Lyrics are immutable for a recording |
| ISRC cache size | 100 | Bounded, in-memory, LRU |
| Shared document cache | per lookup | Deduplicate identical URLs |
| Minimum instrumental gap | 4 s | Shorter breaks are not worth a note |
| lrc.red duration tolerance | 3 s | Reject different edits |
| KuGou duration tolerance | 8 s | Editions differ more |
| SimpMusic duration tolerance | 10 s | Multiple cuts per video |
| Duet flip threshold | 85% | Avoid flipping a genuine duet because of a chorus |
| A2 tail duration | 800 ms | Give the final word a sweep window |
| Translation batch size | 3,500 chars | Stay under endpoint limits |
| Translation parallel requests | 2 | Do not compete with playback |
| Translation timeout | 12 s | Long lyrics, short deadline |
| Translation disk cache cap | 2 MB | Bounded |
| Clock outlier tolerance | 250 ms | Accept normal reporting jitter |
| Clock max slew | +25% / −50% | Inaudible correction |
| Clock snap threshold | 2–3 s | Treat as a seek |
| Word letter animation threshold | ~1 s held | Only held words earn the treatment |
| Word rise/settle | ~700 ms | Natural lift |
| LRC fraction digits written | 2 | Widest reader support |

---

## Final checklist

- [ ] One internal line/word/syllable model with enforced invariants.
- [ ] Every provider returns normalized lines, never raw payloads, to the caller.
- [ ] Query normalization strips credits/packaging but preserves version words.
- [ ] ISRC prepass, capped at 2.5 s, skipped when its provider is disabled.
- [ ] All enabled providers started concurrently; answers consumed in priority order.
- [ ] Word-timed result wins; line-timed and plain are fallbacks.
- [ ] Scraper starts lazily.
- [ ] Losers are cancelled; cancelled ≠ not found.
- [ ] Shared document downloads are deduplicated and outlive individual providers.
- [ ] Per-provider and overall deadlines.
- [ ] Result cache key includes provider set/order/selection.
- [ ] Local/embedded lyrics tried before the network.
- [ ] Background vocals split out, never nested.
- [ ] Duet sides alternate on voice change, with the 85% flip.
- [ ] Gaps only where a line has a known end.
- [ ] Steered clock, dated readings, no unannounced rewind.
- [ ] Manual offset control.
- [ ] Provider picker with found/fetching/not-fetched/not-found states.
- [ ] Settings persist providers by id, not position.
- [ ] Download writes standard LRC + private word-timed LRC.
- [ ] Web handles CORS honestly (permission state, not a fake miss).
- [ ] XML parsing hardened; response sizes capped; ISRC validated.
- [ ] Fixtures and tests for every parser and every race policy.
- [ ] No lyric text in production telemetry.
