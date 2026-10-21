# Importing a Spotify Playlist URL into Another Music App

This is a portable design guide for the feature "paste a Spotify playlist link,
get a playlist in my app". It is deliberately independent of any particular
codebase: every step is described as a contract you can implement in your own
client, with pseudocode, request shapes, failure modes, and the parts that are
easy to get subtly wrong.

The short version:

```
paste URL
  -> validate + extract playlist id
  -> read playlist name and tracks (public embed page or Spotify Web API)
  -> translate each Spotify track into a neutral track model
  -> search your catalogue for the same recording
  -> score candidates and choose one, or mark the track unmatched
  -> create the playlist in your app / your target service
```

The hard parts are not the HTTP calls. They are **identity** (which Spotify
track is which track in your catalogue) and **failure semantics** (what the user
sees when 7 of 100 songs cannot be found).

---

## 1. What "translate" means here

"Translate" in this feature usually means two different things. Decide which
ones you need before writing code.

| Kind | Example | When you need it |
|---|---|---|
| **Metadata translation** | Spotify `{title, artist, album, duration_ms}` -> your app's `Track` model | Always |
| **Catalogue resolution** | Spotify "Blinding Lights" -> YouTube Music video id / Apple Music id / local file | Always, unless you only display Spotify data |
| **Script / language translation** | Japanese title `紅蓮華` -> romaji `Gurenge` for search | When source and target catalogues spell titles differently |
| **Lyrics translation** | English lyrics -> Indonesian lyrics | Unrelated to playlist import |

This guide covers the first three. It does **not** translate song titles into
another human language; that would change the search query and usually hurt
matching. What it does is normalize spelling, scripts, and packaging so the
same recording can be found.

### The neutral intermediate model

Do not pass Spotify's raw JSON through your app. Define one small model that
both the importer and the matcher understand:

```ts
interface ImportedTrack {
  sourceId: string;        // Spotify track id, for debugging/dedupe
  title: string;           // "Blinding Lights"
  artists: string[];       // ["The Weeknd"]
  album: string | null;    // "After Hours"
  durationMs: number | null;
  isrc: string | null;     // strongest cross-service identifier, when available
  artworkUrl: string | null;
  explicit: boolean | null;
}
```

Everything downstream (matching, storage, UI) reads this model, so swapping
Spotify for Apple Music or a CSV importer later only changes the reader.

---

## 2. Parse and validate the URL

### 2.1 Accepted forms

A Spotify playlist can arrive in several shapes:

```
https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123
https://open.spotify.com/intl-id/playlist/37i9dQZF1DXcBWIGoYBM5M
spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
```

A playlist id is **22 base-62 characters** (`A-Z`, `a-z`, `0-9`). That length
is a useful validation signal, not a guarantee. Treat it as a format check,
not as proof the playlist exists.

### 2.2 Rules

1. Trim surrounding whitespace.
2. Accept the `spotify:playlist:<id>` URI form directly.
3. Otherwise parse as a real URL; require scheme `http` or `https`.
4. Require the host to be exactly `spotify.com` or end with `.spotify.com`.
   Do not use `includes("spotify.com")`: `notspotify.com` would pass.
5. Split the path into non-empty segments.
6. Find the segment `playlist`; the next segment is the id. This naturally
   handles the `/intl-xx/` prefix and any future path prefix.
7. Validate the id against `^[A-Za-z0-9]{22}$`.
8. Reject `album`, `track`, `artist`, `user`, and `show` URLs with a clear
   message: "That isn't a Spotify playlist link."

### 2.3 Reference implementation

```ts
const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;

function isSpotifyHost(host: string): boolean {
  return host === "spotify.com" || host.endsWith(".spotify.com");
}

export function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("spotify:playlist:")) {
    const id = trimmed
      .slice("spotify:playlist:".length)
      .split("?")[0]
      .split("/")[0];
    return PLAYLIST_ID.test(id) ? id : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isSpotifyHost(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.indexOf("playlist");
  if (at === -1 || at + 1 >= segments.length) return null;

  const id = segments[at + 1];
  return PLAYLIST_ID.test(id) ? id : null;
}
```

### 2.4 Short links

`https://spotify.link/...` links (the ones the mobile share sheet produces)
do **not** contain the id. If you want to support them, resolve the redirect
first with a `HEAD`/`GET` that follows redirects, then re-run the parser.
Cap the redirect chain, and re-validate the final host. Many implementations
simply reject short links and tell the user to use "Copy link to playlist".

### 2.5 Security notes

- Never use the pasted string as a filesystem path, storage key, or SQL value.
- An id is safe to interpolate into a URL only after the format check.
- Do not send the user's cookies to a host you did not allowlist.
- If your backend fetches the URL for the client, treat it as SSRF input:
  allow only `https`, resolve DNS, block private/loopback/link-local ranges,
  and do not follow redirects to non-Spotify hosts.

---

## 3. Reading the playlist

For a public link, you have two practical options. They differ in
authentication, fragility, and how much data they return.

| Option | Auth | Playlist size | Stability | Best for |
|---|---|---|---|---|
| Public embed page | None | First 100 tracks; more with the page's anonymous token | Medium (HTML/GraphQL can change) | "Paste a public link" with zero sign-in |
| Official Spotify Web API | OAuth / client credentials | All public tracks; private with user auth | High (documented) | Any app that can accept OAuth and rate limits |

For a new app, **prefer the official Web API**. The embed page is useful when
you cannot ask the user to authorize, or when you want a paste-a-link flow with
no Spotify account.

> Reading a user's **signed-in** Spotify library (private playlists, Liked
> Songs, the full playlist list) is a different, undocumented route. It is not
> required for URL import and is covered separately in
> [SPOTIFY_WEB_PLAYER_SESSION.md](SPOTIFY_WEB_PLAYER_SESSION.md).

### 3.1 The public embed page (no sign-in)

Spotify's embed player is a server-rendered Next.js page. It contains the
playlist metadata and its first tracks as JSON inside a `<script>` tag.

**Request**

```http
GET https://open.spotify.com/embed/playlist/<playlistId>
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...
Accept-Language: en-US,en;q=0.9
```

No cookies and no token are required. A normal desktop browser user agent
avoids the mobile/consent variants.

**Parse**

Find this element:

```html
<script id="__NEXT_DATA__" type="application/json"> {...} </script>
```

Parse the JSON. In the observed shape, the playlist lives at one of:

```
props.pageProps.state.data.entity
props.pageProps.entity
```

and the tracks at one of:

```
entity.trackList
entity.tracks
```

Read defensively:

```ts
function parseEmbed(html: string): { name: string; tracks: ImportedTrack[]; token?: string } {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) throw new Error("Could not read the playlist page");

  const root = JSON.parse(match[1]);
  const props = root?.props?.pageProps;
  const entity =
    props?.state?.data?.entity ??
    props?.entity;
  if (!entity) throw new Error("Playlist is private, deleted, or the page changed");

  const name = entity.name ?? entity.title ?? "Imported Spotify Playlist";
  const list = entity.trackList ?? entity.tracks ?? [];
  const artworkUrl =
    entity.coverArt?.sources?.[0]?.url ??
    entity.images?.[0]?.url ??
    null;

  const tracks = list.flatMap((item: any): ImportedTrack[] => {
    const title = item.title ?? item.name;
    if (!title?.trim()) return [];
    if (item.entityType && item.entityType !== "track") return [];

    // The embed page gives one credit string, not an artists array.
    // It can contain commas inside a single artist's name, so keep it
    // whole here and let the matcher split on its own separators.
    const credit = item.subtitle ?? item.artists?.map((a: any) => a?.name).join(", ") ?? "";

    return [{
      sourceId: item.uri?.split(":").pop() ?? "",
      title: String(title).trim(),
      artists: credit ? [credit] : [],
      album: item.album?.name ?? null,
      durationMs:
        typeof item.duration === "number"
          ? item.duration
          : item.duration?.totalMilliseconds ?? null,
      isrc: item.isrc ?? null,
      artworkUrl,
      explicit: item.isExplicit ?? null,
    }];
  });

  // Present even for anonymous requests; short-lived.
  const token = props?.state?.settings?.session?.accessToken;

  return { name: String(name), tracks, token };
}
```

**Observed shapes** (verified against the live embed page; still read them
defensively, because this is not a contract):

```json
{
  "entity": {
    "type": "playlist",
    "name": "All Out 80s",
    "title": "All Out 80s",
    "subtitle": "Spotify",
    "coverArt": {
      "sources": [{ "url": "https://i.scdn.co/image/..." }]
    },
    "trackList": [
      {
        "uri": "spotify:track:2LlQb7Uoj1kKyGhlkBf9aC",
        "title": "Thriller",
        "subtitle": "Michael Jackson",
        "isExplicit": false,
        "duration": 358807,
        "isPlayable": true,
        "playabilityReason": "PLAYABLE",
        "entityType": "track",
        "audioPreview": { "url": "https://p.scdn.co/mp3-preview/..." }
      }
    ]
  }
}
```

Key differences from the official Web API:

- The embed page has **no per-track album**, **no per-track artwork**, and
  **no ISRC**. Artwork and owner are on the playlist entity.
- `duration` is a plain number of milliseconds, not
  `{ totalMilliseconds }`.
- Artist credits are a single `subtitle` string, not an array.
- `isPlayable` / `playabilityReason` tell you whether the row is region-locked
  or otherwise unavailable.
- `entityType` separates tracks from episodes.

If you need richer per-track metadata (album, artwork, ISRC), use the
official Web API instead of trying to infer it from the embed page. The
[signed-in web-player guide](SPOTIFY_WEB_PLAYER_SESSION.md) covers the
session-based route when OAuth is not an option.

**The 100-track cap**

The embed page lists at most the first 100 entries (verified: a playlist with
more tracks returns exactly 100). There are two honest options:

1. Import only the first 100 and tell the user the playlist was truncated.
2. Continue with the page's anonymous access token.

The token is at `props.pageProps.state.settings.session.accessToken`. It is
short-lived and may be absent. Use it for the web player's GraphQL endpoint:

```http
GET https://api-partner.spotify.com/pathfinder/v1/query
  ?operationName=fetchPlaylist
  &variables={"uri":"spotify:playlist:<id>","offset":100,"limit":100,"enableWatchFeedEntrypoint":false}
  &extensions={"persistedQuery":{"version":1,"sha256Hash":"<hash>"}}
Authorization: Bearer <anonymous access token>
App-platform: WebPlayer
Accept: application/json
```

Response (abridged):

```json
{
  "data": {
    "playlistV2": {
      "content": {
        "totalCount": 250,
        "items": [
          {
            "itemV2": {
              "data": {
                "__typename": "Track",
                "uri": "spotify:track:...",
                "name": "Song name",
                "artists": { "items": [{ "profile": { "name": "Artist" } }] },
                "albumOfTrack": {
                  "name": "Album",
                  "coverArt": { "sources": [{ "url": "...", "width": 640 }] }
                },
                "trackDuration": { "totalMilliseconds": 200000 }
              }
            }
          }
        ]
      }
    }
  }
}
```

Pagination rules:

- Start `offset` at the number of entries already read.
- Advance by the **raw number of entries returned**, not by the number of
  tracks you kept after filtering. Entries can be episodes, local files, or
  unavailable rows; using the filtered count either skips rows or loops.
- Do not assume the server honours `limit`. It may return fewer rows than you
  asked for (100 requested, 50 returned, for example). The response count is
  the truth.
- Stop when `items` is empty or `offset >= totalCount`.
- Treat a failed page as "stop paginating", not "throw away the first 100".
  Partial success is better than a failed import.

The `sha256Hash` is Spotify's persisted-query identifier. It **rotates** when
the web player is rebuilt. Hard-coded hashes eventually return
`PersistedQueryNotFound`. For a robust implementation, either:

- use the official Web API, or
- read the current hash out of the web player bundle at runtime, cache it for
  a few hours, and refresh once on `PersistedQueryNotFound`.

**When the embed page is not enough**

- Private playlists return no entity. Ask the user to make it public or sign in.
- Region-restricted tracks may appear as unavailable; keep them as unmatched
  rows rather than silently dropping them.
- Podcast episodes have no music track id. Filter by `__typename` or by the
  presence of a track URI.
- The HTML is not a contract. Keep a fixture and a test so a Spotify redesign
  fails loudly in CI instead of silently producing zero tracks.

### 3.2 The official Spotify Web API

If your app can ask the user to authorize, this is the stable route.

**Public playlists without user login**

Use the Client Credentials flow. It can read public playlist metadata and
tracks, but not a user's private library or Liked Songs.

```http
POST https://accounts.spotify.com/api/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...
```

```http
GET https://api.spotify.com/v1/playlists/<playlistId>
Authorization: Bearer <access_token>
```

**Private playlists and the user's library**

Use Authorization Code with PKCE. Request the scopes you actually need:
`playlist-read-private`, `playlist-read-collaborative`, and optionally
`user-library-read` for Liked Songs.

**Reading tracks**

```http
GET https://api.spotify.com/v1/playlists/<playlistId>/items?limit=100&offset=0&market=US
Authorization: Bearer <access_token>
```

`items` is the current name; older integrations use `/tracks`. Each entry has:

```
item.name
item.artists[].name
item.album.name
item.duration_ms
item.external_ids.isrc
item.album.images[]
item.explicit
item.type                 // "track" or "episode"
```

Pagination uses `limit` (max 100), `offset`, `next`, and `total`. Handle
`429` with `Retry-After`; do not retry in a tight loop. Check the current
Spotify documentation before coding, because field names and endpoint paths
do change.

**Why prefer this**

- Documented pagination and error semantics.
- Stable JSON shape with tests and versioning.
- No HTML scraping and no rotating TOTP secrets.
- Clear rate-limit headers.

**Why people avoid it**

- Requires a Spotify developer app and OAuth consent.
- Client secret cannot be shipped in a mobile app; you need a backend.
- Development-mode apps have user quotas until Spotify approves them.
- It still does not solve matching to your catalogue.

### 3.3 Recommendation

Use the official API if you can. Use the public embed page for a "no sign-in,
public links only" feature, and be explicit about the 100-track limit. If you
also need the user's private library or Liked Songs, see the separate
[signed-in web-player guide](SPOTIFY_WEB_PLAYER_SESSION.md) rather than mixing
that route into the public import flow.

---

## 4. Translate Spotify metadata into your model

### 4.1 Field mapping

The exact field names depend on which reader you use. Keep the neutral model
stable and put the differences in the reader.

| Neutral field | Public embed page | Official Web API |
|---|---|---|
| `sourceId` | tail of `item.uri` (`spotify:track:<id>`) | `item.id` / `item.uri` tail |
| `title` | `item.title` (fallback `item.name`) | `item.name` |
| `artists` | `item.subtitle` (one credit string) | `item.artists[].name` |
| `album` | not provided per track | `item.album.name` |
| `durationMs` | `item.duration` (number) | `item.duration_ms` |
| `isrc` | not provided | `item.external_ids.isrc` |
| `artworkUrl` | `entity.coverArt.sources[]` (playlist cover) | `item.album.images[]` (track cover) |
| `explicit` | `item.isExplicit` | `item.explicit` |
| playback state | `item.isPlayable`, `item.playabilityReason` | `item.is_playable`, restrictions |
| row type | `item.entityType` (`track`/`episode`) | `item.type` (`track`/`episode`) |

Notes:

- Preserve artist order; the first credit is usually the primary one.
- `0` or missing duration means "unknown", not "zero-length".
- Pick artwork by width, not by array position. Spotify lists sizes in no fixed
  order; a 64 px image can appear last.
- Keep `explicit` tri-state: `true`, `false`, or `null` when the reader did not
  say. Do not coerce unknown to `false`.
- Drop `episode` rows from a music import, or import them as a separate type.
- A single credit string from the embed page is fine; split it inside the
  matcher, where you can be careful about names that contain commas
  ("Tyler, The Creator").

### 4.2 Normalization before searching

Normalize both sides (Spotify and your catalogue) with the same function, so
the comparison is symmetric.

1. Unicode NFKC (folds full-width characters, compatibility forms).
2. Lowercase with a locale-independent operation.
3. Replace `&` with `and`.
4. Convert CJK brackets (`「」『』【】`) to ASCII parentheses.
5. Split artists on `, & / ; · | 、 ， × and x vs feat ft featuring with`.
6. Remove punctuation from words, but **keep letters and digits in any script**.
7. Drop joining words (`and`) and purely decorative words for the *core*
   comparison, while keeping them for display.

Do not transliterate the title for display. Transliterate only to build extra
search queries.

### 4.3 Title parsing (the part that decides matches)

A catalogue title is not just a title. It contains:

- **Identity**: the words of the recording's name.
- **Version markers**: `remix`, `live`, `acoustic`, `instrumental`, `sped up`,
  `slowed`, `nightcore`, `karaoke`, `demo`, `unplugged`, `extended`, `edit`.
  These mean "a different recording" and must match in both directions.
- **Packaging**: `(From "Some Film")`, `[Official Video]`, `(Remastered 2011)`,
  `- Single`, the label, the featured artist. These are noise for identity;
  they are at most a tie-breaker.

A proven algorithm:

1. Remove bracketed segments, innermost first, up to 3 passes.
2. Classify each removed segment:
   - If it contains a version word, add that word to `versions`.
   - Otherwise add its meaningful words to `context`.
   - Ignore neutral labels such as `Album Version`, `Radio Edit`,
     `Original Mix`, `Deluxe Version`.
3. Handle dash/pipe tails (`Song - From the Film`, `Artist - Title`):
   - If the head is just the credited artist, the tail is the title.
   - If the head is non-Latin and the tail is a Latin transliteration, use the
     tail as the searchable title but keep the head as context.
   - Otherwise the head is the title and the tail is packaging.
4. Remove `feat.` / `ft.` / `featuring` tails.
5. Drop trailing noise words (`official`, `video`, `audio`, `lyrics`, `full`,
   `song`, `hd`, `4k`).
6. Drop trailing take markers into `versions` (`Instrumental`, `Remix`).
7. Build the comparison key: lowercase letters and digits only, joined.
   For CJK, keep the character sequence and strip only punctuation/whitespace.

Examples:

| Raw title | Core | Versions | Context |
|---|---|---|---|
| `Paniyon Sa (From "Satyamev Jayate")` | `paniyonsa` | - | `satyamev`, `jayate` |
| `KALYANI (Remix)` | `kalyani` | `remix` | - |
| `Song - Official Audio` | `song` | - | `official`, `audio` |
| `紅蓮華 - Gurenge` | `gurenge` | - | `紅蓮華` |
| `コイコガレ - koikogare` | `koikogare` | - | `コイコガレ` |

### 4.4 Extra queries for script differences

Search often fails when the two catalogues file the same song in different
scripts. Build a small query list, best first:

1. `"<clean title> <primary artist>"`
2. `"<clean title>"` (drops a composer/actor credit that differs)
3. `"<transliteration>"` when the title is kana/romaji pair, or vice versa
4. `"<original script>"` when you can produce it

A simple romaji pass over katakana/hiragana is cheap and covers many Japanese
titles. Kanji needs a dictionary or a transliteration service; do not guess.

---

## 5. Match each track to your catalogue

### 5.1 Pipeline

```
for each imported track:
  queries = buildQueries(track)
  candidates = []
  for query in queries:
    candidates += searchCatalogue(query, filter = "songs only")
    if enough high-confidence candidates: break
  best = rank(candidates, target)
  if best is confident: emit best
  else: mark unmatched
```

Use a **songs-only** search filter when your catalogue offers one. A general
video search returns covers, lyric videos, karaoke, and hour-long loops.

### 5.2 Hard gates first, score second

Do not score everything and pick the top. First reject candidates that cannot
be the same recording, then rank the survivors.

Hard gates:

| Gate | Rule | Rationale |
|---|---|---|
| Title | Core strings equal, or each transliterates to the other, or one contains the other when both are longer than 3 characters | Punctuation and minor wording differences are common; short titles are too ambiguous for containment. |
| Version | `versions` sets must be equal | A live take must not stand in for the studio cut, in either direction. |
| Artist | At least one credited artist must share a whole-name run, unless an exact-duration override applies | Prevents a cover by a different singer from winning. |
| Duration | If both sides state one, the difference must be <= 30 s | Catches extended cuts, loops, snippets, and full-album uploads. |
| Explicit | If both sides state it, it must agree | Clean and explicit editions can otherwise be metadata-identical. |

Exact-duration override: if the credits genuinely disagree but the runtimes
are within ~2 seconds, allow the candidate with a penalty. This handles film
catalogues that credit the composer on one service and the singer on another.
Only allow it for audio, not for music videos whose runtime includes visuals.

### 5.3 Scoring

A simple, explainable score beats a black-box similarity metric. One working
weight table:

| Signal | Points |
|---|---|
| Base (all gates passed) | 100 |
| Artist exact set match | +25 |
| Artist shares at least one name | +10 |
| Duration within 3 s | +40 |
| Duration within 30 s | +15 |
| Album key exact | +35 |
| Explicit flag matches | +20 |
| A shared "context" word (film, edition) | +20 |
| Credits disagree, rescued by exact duration | -30 |

Choose the highest score. A genuine credit match always beats a
duration-only rescue. If several candidates tie, prefer the one whose album
matches, then the one with the fuller artist credit; if still tied, keep the
catalogue's original order rather than inventing confidence.

### 5.4 Fallback policy

Two policies are defensible, and they produce very different products:

- **Strict**: no confident match -> unmatched row. The user sees exactly what
  was not imported. This is safer for playback quality.
- **Optimistic**: no confident match -> take the first search result anyway.
  This imports more songs but sometimes imports a cover or a karaoke track.

The best UX is usually: use strict scoring, but show unmatched rows with a
"Search manually" action and a "Use first result" option. Never silently drop
a track.

### 5.5 Concurrency, caching, cancellation

- Run 4-8 searches in parallel. More will hit rate limits and make progress
  jumpy; fewer makes a 500-song playlist feel frozen.
- Cache match results by `(sourceId, targetCatalogue)` for the session. A
  playlist reopened should not re-search everything.
- Emit progress after each completed match, not after the whole playlist.
- Make cancellation real: if the user closes the dialog or leaves the page,
  stop issuing new searches and ignore late results.
- Deduplicate identical Spotify tracks before searching, then expand the
  result back into the original positions if the playlist is order-sensitive.

### 5.6 What the reference implementation does

There are two matching paths in this repository, and the difference matters:

- **Viewing a Spotify playlist** uses the full scorer described above:
  parse title, gate on versions, score artist/duration/album/explicit, and
  fall back to the first search hit only when nothing scores.
- **Pasting a URL to import** uses a simpler path: search `"title artist"`,
  take the first result in the songs filter, and mark it unmatched if the
  search returns nothing at all. It does not score candidates.

If you are building this feature from scratch, **use the scored path for the
import too**. The naive first-hit path is the main reason an import can bring
in a cover or a live version without anyone noticing. See the appendix for the
exact files.

---

## 6. Persist the imported playlist

### 6.1 Choose a destination

You have three possible destinations:

1. **Your own local library** (database/file). No target-service auth needed.
2. **The target service's playlist** (e.g. YouTube Music, Apple Music). Needs
   a signed-in account and a create-playlist API.
3. **Both**: try the service first, fall back to local, and tell the user
   which happened.

### 6.2 Creating a remote playlist

The generic shape is:

```
createPlaylist(title, privacy, videoIds)
```

Operational rules:

- Create the playlist with the first batch, then append the rest.
- Batch sizes are service-specific. Around 50 ids per write is a safe default;
  check your target's limit.
- Preserve source order across batches.
- If batch N fails, do not delete the playlist. Report "imported N of M" and
  offer a retry that appends only the missing ids.
- If the service rejects creation entirely, fall back to local storage (if you
  have one) and say so.
- Set privacy explicitly. "Private" is the least surprising default.
- Do not reuse an existing playlist title as an identity; titles are not unique.

### 6.3 Local storage schema

Keep it boring and versioned:

```json
{
  "version": 1,
  "playlists": [
    {
      "id": "imported-1750000000000",
      "title": "Road Trip",
      "source": "spotify",
      "sourcePlaylistId": "37i9dQZF1DXcBWIGoYBM5M",
      "importedAt": "2026-10-21T10:00:00Z",
      "tracks": [
        {
          "videoId": "dQw4w9WgXcQ",
          "title": "Song",
          "artist": "Artist",
          "album": "Album",
          "durationSec": 213,
          "thumbnailUrl": "https://...",
          "matchConfidence": 145
        }
      ],
      "unmatched": [
        { "title": "Song", "artist": "Artist", "reason": "no confident match" }
      ]
    }
  ]
}
```

Storing `unmatched` lets you offer a repair flow later. Storing
`sourcePlaylistId` lets you re-import or refresh.

### 6.4 Placeholder rows

If your UI opens a playlist before all matches are done, use explicit
placeholder ids rather than real-looking ones:

```
pending:<sourceId>   // still searching
missing:<sourceId>   // searched, nothing found
```

Your player should refuse to play these and show a clear state instead of a
generic playback error. This also prevents a placeholder from being written
into a remote playlist by mistake.

---

## 7. UX contract

A playlist import has more states than a normal form. Handle them explicitly.

| State | What the user sees | What you must not do |
|---|---|---|
| Invalid URL | Inline error on the field | Start a network request |
| Reading playlist | "Reading the Spotify playlist..." + spinner | Close the dialog and lose the work |
| Matching | "Matching songs 37 of 120" | Freeze with no progress |
| Partial success | Playlist created + "7 songs weren't found" with their titles | Drop the 7 silently |
| Empty playlist | "No songs in this playlist" | Create an empty playlist |
| Nothing matched | "None of those songs were found" | Create an empty playlist |
| Network error | The actual failure + Retry | Blame the user |
| Private playlist | "Make the playlist public, or sign in" | Retry forever |
| Token expired | "Sign in to Spotify again" | Loop on 401 |
| Cancelled | Nothing created | Leave a half-written playlist |

Additional details worth copying:

- Disable the Import button while a request is running.
- Block dismissing the dialog during matching, or cancel the work if dismissed.
- Keep the pasted link when an error occurs so the user can fix a typo.
- Show the final count on the created playlist card.
- If the destination is the user's account, ask for privacy (private /
  public / unlisted) only when signed in. A purely local playlist has no
  audience.
- Offer a manual search for unmatched tracks. That is where the real user
  value is: 90% automatic, 10% one-tap fix.

---

## 8. Edge cases and failure modes

| Situation | Detection | Handling |
|---|---|---|
| Private/deleted playlist | No entity in embed; `404`/`403` from API | Explain and stop; offer sign-in if supported |
| Empty playlist | `tracks.length === 0` | "No songs in this playlist"; do not create |
| >100 tracks on embed | `tracks.length >= 100` | Paginate with anonymous token, or warn about truncation |
| Podcast episodes / local files | `type === "episode"` or no track uri | Filter out and mention it |
| Region-blocked rows | Row present but no playable id | Keep as unmatched; do not fail the whole import |
| Duplicate tracks | Same `sourceId` repeated | Preserve order, or dedupe and tell the user |
| Rate limit | `429` + `Retry-After` | Back off, retry with jitter, cap attempts |
| Token expiry | `401` | Re-mint once, then ask for sign-in |
| Rotated query hash | `PersistedQueryNotFound` | Refresh hash once, retry once |
| HTML changed | `__NEXT_DATA__` missing | Fail with a clear "Spotify changed their page" message; keep fixtures |
| Different script | Search returns nothing | Try transliteration/original-script query |
| Cover/remix wins | Wrong artist/version | Use the hard gates, not just the top search hit |
| Duration mismatch | Target is a loop/extended cut | Reject beyond 30 s unless it is a known video |
| Offline | Network exception | Keep the input, offer retry |
| Huge playlist | 1000+ tracks | Stream rows, show progress, allow cancel, cache matches |

---

## 9. End-to-end pseudocode

```ts
async function importSpotifyPlaylist(
  rawUrl: string,
  target: MusicService,
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const playlistId = extractPlaylistId(rawUrl);
  if (!playlistId) throw new UserError("That isn't a Spotify playlist link.");

  const playlist = await readPublicPlaylist(playlistId); // §3.1 or §3.2
  if (playlist.tracks.length === 0) throw new UserError("No songs in this playlist.");

  const results: (Track | null)[] = new Array(playlist.tracks.length).fill(null);
  const unmatched: ImportedTrack[] = [];
  let done = 0;

  await mapWithConcurrency(playlist.tracks, 6, async (source, index) => {
    const match = await findBestMatch(source, target); // §5
    results[index] = match;
    if (!match) unmatched.push(source);
    onProgress(++done, playlist.tracks.length);
  });

  const matched = results.filter((t): t is Track => t !== null).slice();
  if (matched.length === 0) throw new UserError("None of those songs were found.");

  const playlistRef = await target.createPlaylist({
    title: playlist.name || "Imported Spotify Playlist",
    privacy: "private",
    trackIds: matched.map((t) => t.id),
    // Batch internally, preserving order.
  });

  return { playlistRef, matched, unmatched };
}
```

`mapWithConcurrency` should stop starting new work when a cancellation token is
set, and should let in-flight requests finish or be aborted.

---

## 10. Testing strategy

### 10.1 Unit tests that pay for themselves

**URL parser** — table-driven:

```
https://open.spotify.com/playlist/<id>          -> id
https://open.spotify.com/playlist/<id>?si=abc   -> id
https://open.spotify.com/intl-id/playlist/<id>  -> id
spotify:playlist:<id>                           -> id
https://open.spotify.com/album/<id>             -> null
https://notspotify.com/playlist/<id>            -> null
ftp://open.spotify.com/playlist/<id>            -> null
https://open.spotify.com/playlist/short         -> null
""                                              -> null
```

**Embed parser** — store a real HTML fixture (or just the extracted
`__NEXT_DATA__` JSON) and assert name, track count, and first/last track
fields. Add a second fixture where the entity is nested under
`state.data.entity`, and one where it is under `entity`.

**Pathfinder parser** — fixture for `fetchPlaylist`, a playlist with a
non-track entry, and a page where `items.length !== tracks.length`. Assert that
the offset advances by raw entries.

**Matcher** — golden cases:

- exact title + artist + duration -> matched
- same title, different artist -> rejected
- `Song (Live)` vs `Song` -> rejected in both directions
- `Song (Remix)` vs `Song (Remix)` -> matched
- `Song (From "Film")` vs `Song` -> matched
- `Artist - Song` upload convention -> matched
- kana vs romaji -> matched
- 31 s duration gap -> rejected; 3 s -> matched
- explicit vs clean -> rejected
- no matches -> unmatched, not first-hit

**Storage** — round-trip a playlist with unmatched rows and Unicode titles.

### 10.2 Integration tests

- Mock HTTP with recorded responses; never call Spotify in CI.
- Test 0, 1, 100, 101, and 500 tracks.
- Test a page that fails halfway; assert partial result and no crash.
- Test a missing anonymous token; assert the first 100 are kept.
- Test `PersistedQueryNotFound` then one successful hash refresh.
- Test cancellation mid-match.

### 10.3 Contract tests for the unofficial routes

Keep a small scheduled job (not on every CI run) that checks whether the embed
page still has `__NEXT_DATA__` and an anonymous access token, and whether the
known playlist hash still resolves. Alert when they change. Treat these as
smoke tests, not as a stability guarantee. The signed-in route has its own
contract checks in the [companion guide](SPOTIFY_WEB_PLAYER_SESSION.md).

---

## 11. Legal and operational notes

- The official Web API is the only contractual route. Scraping the embed page
  and calling `api-partner.spotify.com` with its anonymous token are
  undocumented and may violate Spotify's terms or break at any time.
- Ask before writing to the user's target account. Show the playlist title and
  count, and default to private.
- Respect rate limits and `Retry-After`. Do not parallelize so aggressively
  that you trigger a ban.
- Cache politely: playlist data changes, but re-fetching on every render is
  wasteful and abusive.
- Attribute the source in the UI ("Imported from Spotify") and keep the
  original playlist URL or id for troubleshooting and re-import.

---

## 12. Implementation checklist

- [ ] URL parser handles open.spotify.com, `/intl-xx/`, `?si=`, and `spotify:`
      URIs; rejects albums/tracks/other hosts and short links (or resolves
      them safely).
- [ ] Public playlist reader returns name, cover, ordered tracks, and a
      truncation flag.
- [ ] >100 tracks either paginates or warns; offset advances by raw entries.
- [ ] Track model carries title, artists, album, duration, ISRC when available,
      artwork, explicit, source id.
- [ ] Title parser separates identity, version markers, and packaging.
- [ ] Matcher hard-gates on title/version/artist/duration/explicit, scores the
      rest, and returns a confidence, not just a boolean.
- [ ] Unmatched tracks are surfaced, not dropped.
- [ ] Searches are bounded (4-8), cached, cancellable, and report progress.
- [ ] Playlist creation batches, preserves order, defaults to private, and
      falls back to local storage with an explicit message.
- [ ] Placeholder rows (`pending:`, `missing:`) are unplayable and never
      written to a remote playlist.
- [ ] Errors distinguish invalid input, private playlist, network failure,
      token expiry, and "Spotify changed their page".
- [ ] Fixtures and tests cover the parser, the matcher, and partial failures.
- [ ] The unofficial endpoints are behind a feature flag or clearly labelled
      as unstable, and the official API is used where possible.

---

## Appendix A: Minimal public-import flow (copyable)

If you only want the "public link, no sign-in, first 100 tracks" version, this
is the whole feature:

```ts
async function readPublicPlaylist(id: string) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Spotify returned ${res.status}`);

  const html = await res.text();
  const json = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  )?.[1];
  if (!json) throw new Error("Could not read the playlist page");

  const root = JSON.parse(json);
  const props = root?.props?.pageProps;
  const entity = props?.state?.data?.entity ?? props?.entity;
  if (!entity) throw new Error("Playlist is private or unavailable");

  const cover =
    entity.coverArt?.sources?.[0]?.url ??
    entity.images?.[0]?.url ??
    null;

  const tracks = (entity.trackList ?? entity.tracks ?? []).flatMap((item: any) => {
    const title = item.title ?? item.name;
    if (!title?.trim()) return [];
    if (item.entityType && item.entityType !== "track") return [];

    return [{
      sourceId: item.uri?.split(":").pop() ?? "",
      title: String(title).trim(),
      // One credit string; let the matcher split it.
      artists: item.subtitle
        ? [item.subtitle]
        : (item.artists?.map((a: any) => a?.name).filter(Boolean) ?? []),
      album: item.album?.name ?? null,
      durationMs:
        typeof item.duration === "number"
          ? item.duration
          : item.duration?.totalMilliseconds ?? null,
      isrc: item.isrc ?? null,
      artworkUrl: cover,
      explicit: item.isExplicit ?? null,
      playable: item.isPlayable ?? true,
    }];
  });

  return {
    name: String(entity.name ?? entity.title ?? "Imported Spotify Playlist"),
    cover,
    tracks,
    truncated: tracks.length >= 100,
    anonymousToken: props?.state?.settings?.session?.accessToken ?? null,
  };
}
```

Then pass each track through your matcher, and create the playlist with the
matched ids.

## Appendix B: How this repository implements it

This section is only a map for reading the reference code; the guide above is
the portable part.

| Step | Android / desktop (Kotlin) | Web |
|---|---|---|
| URL parsing | `shared/.../data/spotify/SpotifyImporter.kt` → `extractPlaylistId` | Not exposed as a paste-URL flow; the web app reads the signed-in library (see the companion guide) |
| Public playlist fetch | `SpotifyImporter.fetchPlaylistTracks` → embed page + `fetchRemainingTracks` | - |
| Track model | `SpotifyTrack` in `SpotifyLibrary.kt` | `SpotifyTrack` in `web/shared/src/bridge/protocol.ts` |
| Matching | `SpotifyImporter.matchTrack` + `TrackMatcher.kt`; URL import uses `resolveToSongs` (first hit) | `web/app/src/data/spotify/api.ts` `matchToYouTube` + `web/app/src/data/match/trackMatcher.ts` |
| Progress UI | `SpotifyImportAlert.kt`, `DesktopIntegrationsUi.kt` | `web/app/src/data/spotify/queries.ts` (`PlaylistJob`) |
| Persist | `MainViewModel.createPlaylistWithVideoIds`; `LocalPlaylistStore` | `web/app/src/pages/SpotifyPlaylistPage.tsx` → `createPlaylist` |

Notable observations from the reference implementation:

1. The **URL import** path takes the first search result for each track
   (`resolveToSongs`), while the **playlist browsing** path uses the scored
   matcher (`matchTrack`). The scored path is the better default for imports.
2. The embed path stops at 100 tracks and opportunistically continues with the
   page's anonymous token. If the token is missing, it keeps the first 100
   rather than failing.
3. Remote playlist creation batches at 50 tracks on Android and falls back to
   local storage if the account call fails. The user is told which destination
   won.
4. Unmatched tracks are listed by title and artist rather than silently
   dropped, which is the right default for trust.

The signed-in library reader (`SpotifyLibrary.kt`,
`web/extension/lib/spotify.ts`) is documented separately in
[SPOTIFY_WEB_PLAYER_SESSION.md](SPOTIFY_WEB_PLAYER_SESSION.md).
