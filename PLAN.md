# Muzeec — Implementation Plan

Personal YouTube Music desktop client. Electron + React + shadcn/ui.
Streaming, auth, and account-sync logic: `docs/ELECTRON_YOUTUBE_MUSIC.md` (referenced below as **DOC**).

Constraints: low RAM, smooth UI, no jank. Every decision below bends to that.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron (current stable) | DOC §2: bundled Chromium = consistent MSE/WebAudio/codec behavior |
| Bundler | `electron-vite` | one config, HMR renderer, main/preload build, no Forge boilerplate |
| UI | React 19 + TypeScript | — |
| Components | shadcn/ui, preset `b1VlIttI` | see §3 |
| Styles | Tailwind v4 | shipped by shadcn preset |
| State | Zustand | small, no provider tree, selector granularity |
| Streaming | Shaka Player (audio-only) | DOC §10.1 |
| SABR | `googlevideo` adapters | DOC §9.4 |
| InnerTube | custom main-process client | DOC §8, §6.1 — keep renderer token-free |
| PO tokens | `bgutils-js` + cold-start path | DOC §9.5 |
| Cache | `better-sqlite3` (main only) | parsed metadata + verdicts |
| Secrets | Electron `safeStorage` | DOC §7.6 |

Explicitly rejected: Tauri (DOC §2 — system webview codec drift), Next.js (no SSR need), Redux (bundle + boilerplate), Electron Forge (electron-vite is smaller).

---

## 2. Non-goals for v1

Ship in this order; do NOT build the second column until the first is verified working.

| v1 | Later |
|---|---|
| Auth, browse, search, player, queue | Downloads / offline |
| Likes, playlists, library, history pings | Lyrics, EQ, crossfade |
| Tray + media keys | Discord presence, scrobbling |
| Home / Explore / Library / Search / Album / Artist / Playlist / Settings | Local library mirror |

---

## 3. shadcn/ui setup

Preset `b1VlIttI` resolves to: **style `luma`**, theme/baseColor `neutral`, chart `neutral`, icons `lucide`, font `inter`, radius `default`, menuAccent `subtle`. Do not decode this by hand — the CLI is the source of truth.

### 3.1 Scaffold

Two-step, because shadcn has no Electron template:

```bash
# 1. Renderer skeleton from the Vite template with our preset.
npx shadcn@latest init --preset b1VlIttI --template vite --name muzeec --no-monorepo -y

# 2. Graft Electron around it (electron-vite layout, §4).
```

Then, inside the project, treat `src/renderer` as the shadcn app root: `components.json` points `tailwind.css` at the renderer global CSS, `aliases.ui` at `@/components/ui`.

If instead initializing into an already-existing electron-vite tree:

```bash
npx shadcn@latest apply b1VlIttI      # theme + font, existing project
```

### 3.2 Component manifest

Add in one batch once the shell renders (`npx shadcn@latest add <list>`):

```
sidebar button card input scroll-area tabs tooltip dropdown-menu context-menu
slider dialog sheet avatar badge skeleton separator empty sonner command
toggle-group breadcrumb alert progress
```

Rationale per surface: `sidebar` = left nav; `scroll-area` = every list viewport; `slider` = seek + volume; `dropdown-menu`/`context-menu` = track actions; `command` in `dialog` = ⌘K palette; `sonner` = toasts (Radix base); `empty` = no-results states; `avatar` = account menu; `skeleton`/`spinner` = loading.

Rules enforced when writing UI (from the installed skill):

- `className` = layout only. Colors via semantic tokens (`bg-background`, `text-muted-foreground`). No `dark:` overrides, no raw `bg-blue-500`.
- No `space-x-*` / `space-y-*`. Use `flex … gap-*`.
- `size-*` when equal. `truncate`, not the three-utility version.
- Icons: `data-icon="inline-start|inline-end"` on the child icon inside `Button`. No `size-4` on icons inside components.
- `FieldGroup`/`Field` for any form (Settings), `ToggleGroup` for 2–5 option toggles (e.g. audio quality).
- Items live inside their Group (`SelectItem`→`SelectGroup`, `CommandItem`→`CommandGroup`, `DropdownMenuItem`→`DropdownMenuGroup`).
- Overlays always have a Title (`DialogTitle`/`SheetTitle`, `sr-only` if hidden). `Dialog`/`Sheet` carry their own z-index — never add `z-*`.
- Empty states = `Empty`. Callouts = `Alert`. Separators = `Separator`. Loading = `Skeleton`/`Spinner`. Styled spans = `Badge`.
- After any `shadcn add`, read the emitted files, fix hardcoded imports to the project `@/` alias, swap any non-lucide icons to `lucide-react`.

### 3.3 Surfaces

- **App shell** — `Sidebar` (Home, Explore, Library, Search) + persistent bottom Player bar + main `ScrollArea`.
- **Auth** — own `BrowserWindow`, not a route. On success the main window renders the shell (DOC §7.2).
- **Player bar** — art, title/artist, prev/play/next, seek `Slider`, volume, queue `Sheet`, like `Button`.
- **Settings** — `Tabs` + `Card` + `Switch`/`Select`, credential + audio-quality + cache controls only.

Performance note: rendering lives behind the shadcn primitives, so styling is static classes. Do not add per-frame style recomputation to them (§9).

---

## 4. Repo layout

```
src/
  main/
    index.ts            app lifecycle, single-instance, protocol
    protocol.ts         app:// scheme (DOC §5)
    window.ts           main window + auth window
    tray.ts             tray + media keys (DOC §10.4)
    ipc.ts              typed channel registry, arg validation
    youtube/
      session.ts        persist:youtube partition, header rewriters
      auth.ts           login window, cookie + ytcfg capture
      sapisid.ts        SAPISIDHASH (DOC §7.1)
      innertube.ts      request client, X-Origin/Origin/Referer, auth scope
      client.ts         live client version + visitorData (DOC §8.2)
      player.ts         player request, client walk, verdict cache
      decipher.ts       signature/n transform (isolated)
      botguard.ts       Create/GenerateIT + minter (DOC §9.5)
      history.ts        3-ping play tracking (DOC §11.2)
    storage/
      settings.ts       app config
      cache.ts          better-sqlite3: parsed pages, permanent verdicts, client exclusions
  preload/index.ts      contextBridge only
  renderer/
    main.tsx App.tsx
    player/  engine.ts shaka.ts sabr.ts queue.ts mediaSession.ts
    pages/   home explore library search album artist playlist settings
    lib/     ipc.ts (typed wrapper) store/ query/
    components/ui/       (shadcn)
```

---

## 5. Process & security boundaries

DOC §3, §13. Non-negotiable:

- Renderer receives **results only** — browse/search/player JSON, resolved URLs, auth status. Never `Cookie`, SAPISID, or PO tokens.
- `webPreferences`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, explicit preload. Never `webSecurity: false`.
- Renderer origin is `app://muzeec` (DOC §5) — stable for storage, no `file://`.
- No remote HTML in the privileged renderer. Google sign-in and BotGuard run in separate windows with no Node access.
- Validate every IPC argument in main. No `fs`, `child_process`, or arbitrary URL fetch exposed.
- Strict CSP on `app://`. `eval`/`new Function` (player decipher, BotGuard interpreter) is confined to a sandboxed window or `utilityProcess` — never the main UI renderer.
- No audio proxying through any server (DOC §13).
- Auth cookies stay in `persist:youtube`. `safeStorage` only if multi-account snapshots are added later (DOC §7.6).
- Sign-out clears cookies, scope, cached player responses, client exclusions, PO tokens (DOC §7.7).

### 5.1 IPC surface (preload)

```
yt:authState  yt:login  yt:logout
yt:browse     yt:search  yt:player  yt:history   (DOC §6.1)
yt:like  yt:playlist.*  yt:subscribe  yt:feedback (DOC §11.1)
sys:playerState  sys:mediaKey  sys:settings
```

`yt:player` returns the playable decision (direct URL or SABR descriptor) **plus** headers the URL expects — the renderer never computes them.

### 5.2 Network model (main only for API)

Main handles all `music.youtube.com/youtubei/*` (DOC §6.1): sets `Origin`/`X-Origin`/`Referer` exactly, signs with SAPISIDHASH, retries with backoff.

Media bytes go renderer ⇄ `googlevideo.com` directly (DOC §6.2). Header rewriters on the shared `persist:youtube` session:

- request: match the URL's `c=` client (VISIONOS = strip `Origin`/`Referer`; else set per-client; correct UA) (DOC §9.6),
- response: `Access-Control-Allow-Origin: *` + `Expose-Headers: *` so Shaka reads bytes (DOC §6.2).

Search stays anonymous; typeahead always anonymous (DOC §8.3).

---

## 6. State & data flow

- **Zustand stores**: `auth`, `library` (likes/playlists), `browse` (per-route cached pages), `queue`, `player`. Kept separate so a queue change never re-renders the sidebar.
- **Server data**: thin query layer (TanStack Query or a hand-rolled `useIpcQuery`) with `staleTime` + dedupe. Browse pages cached both in SQLite (main) and in-memory.
- **Renderer never fetches YouTube directly** except media bytes.
- Tolerant parser (DOC §8.4): recursive renderer-key search, missing field = absent, log unknown renderers, fail loudly in dev — no lenient JSON that silently yields an empty list.

---

## 7. Stream resolution & playback

Implement exactly per DOC §9 and §10.

- Player request carries current `signatureTimestamp` (DOC §9.1, §11.2).
- Client walk order for signed-in: `WEB_REMIX` → `WEB` → `MWEB` → `VISIONOS` (DOC §9.2). Exclude a client for a track ~10 min after refusal; cache permanent verdicts ~10 min (age/region/private/terminated/premium/removed).
- Direct URLs may be `url` / `signatureCipher` / `cipher`; decipher + `n` transform in the isolated worker (DOC §9.3).
- `serverAbrStreamingUrl` → `googlevideo` SABR adapter + Shaka; handle `onReloadPlayerResponse`; do not let Shaka blindly retry a stale SABR body (DOC §9.4).
- BotGuard: Create → interpreter → snapshot → GenerateIT (with YouTube `Origin`) → `WebPoMinter`. Visitor token into `serviceIntegrityDimensions.poToken`; video token as `pot` / via `onMintPoToken`. Cold-start token first so a track never waits on BotGuard (DOC §9.5).
- **Probe every URL before handing to Shaka**: `Range` past 1 MiB, exact media headers, reject 403/404/410, require `audio/*` + ≥16 KiB body (DOC §9.7). Refusal ⇒ invalidate URL + exclude that client for the track.
- Fallback ladder (DOC §9.8): best client → probe → next client → cache permanent verdict → re-resolve on mid-playback refusal. yt-dlp only if ever needed, as a separate subsystem.

Playback (DOC §10): Shaka configured `disableVideo/Text/Thumbnails`, `abr.enabled=false`, `preferredAudioCodecs=['opus','mp4a']` (prefer 251 then 140). Single `<audio>` in a Web Audio graph. Media Session for OS controls; `powerSaveBlocker.start('prevent-app-suspension')` while playing; tray + `globalShortcut` media keys.

Error model (DOC §12): classify permanent vs temporary up front, cache permanent, backoff temporary, log videoId/client/status/playerStatus/signed-in/timings. One readable reason per failed track, never a generic "playback error".

---

## 8. Account sync (DOC §11)

Live YouTube operations, not a local mirror:

- Reads: `browse` library shelves, `account/account_menu`, `account/accounts_list`.
- Writes: `like/like|dislike|removelike`, `playlist/create|delete`, `browse/edit_playlist`, `feedback`, `subscription/subscribe|unsubscribe`. Check the response **body** for an `error` object, not just HTTP 200.
- History = 3 pings sharing one `cpn`: playback ping (audible) → `atrUrl` (~few s) → watchtime every ~30 s + final `final=1`. Flush watchtime on queue change. New `cpn` per play. Best-effort — never block playback (DOC §11.2).
- Anything local (downloads, position, queue, settings) is **not** described as synced (DOC §11.3).

---

## 9. Performance & RAM budget

Targets: idle RSS < ~250 MB, playing < ~450 MB, UI interaction ≥ 60 fps, no audio-thread stalls.

**Process/Chromium**

- One renderer window. Do not create a second window except: the Google auth window (transient, closed after login) and the BotGuard/decipher sandbox window (lazily created, reused, closed when idle).
- Shared `persist:youtube` session — one only. Duplicate sessions duplicate caches and RAM.
- Electron flags: keep GPU rasterization for the UI, `--disable-features=CalculateNativeWinOcclusion` off by default, disable unused Chromium services (translate, spellcheck) in `app.commandLine`. Do not blanket-disable GPU — jank cost exceeds the RAM saved.
- `backgroundThrottling: true` on the main window; audio keeps playing via the player engine regardless.
- Decipher/BotGuard in `utilityProcess` where possible — cheaper than a full renderer and no window surface.

**Renderer**

- React 19 + Zustand selectors; no context provider wrapping the tree.
- Route-level `lazy()` code splitting. Player bar and sidebar are the only always-mounted UI.
- **Long lists virtualized** (TanStack Virtual) — Cap: implement virtualization on first list over ~100 rows. This is the single biggest DOM/RAM lever.
- **No per-frame React updates.** Playback position lives in a ref; the seek bar subscribes at ~4 Hz (rAF-throttled), not per frame. Volume/drag use direct DOM/`transform`, not state.
- Images: `loading="lazy"`, fixed dimensions to avoid layout shift, cap thumbnail decode size.
- Avoid re-parsing: cache **parsed** pages, not raw JSON (DOC §8.4).
- No `useEffect` waterfalls on route entry; queries fire from the store layer.

**Player**

- Audio-only Shaka config (§7) — never decode video.
- `bufferingGoal` 120 / `bufferBehind` 300; keep memory bounded on long sessions, cap buffer on lower-RAM machines via a Settings toggle.
- One Web Audio graph, one `<audio>`. Crossfade (later) adds a second engine only while fading.
- SABR body rebuilt on restart, not retried stale (DOC §9.4) — avoids retry storms that spike CPU/network.

**Main**

- `better-sqlite3` synchronous, WAL, one connection, indexed by key. Cache parsed pages + verdicts + client exclusions.
- Player requests deduped in-flight (one per videoId); client walk capped.
- History pings queued and batched; never on the playback critical path.

---

## 10. Build order

Follow DOC §15, UI after the engine works.

1. **Shell** — electron-vite project, `app://` protocol, window, preload bridge, shadcn init with preset `b1VlIttI`, render a blank shell with `Sidebar` + `ScrollArea`.
2. **Auth** — login window, cookie read (exact cookie names, not `includes`), `ytcfg` capture, auth state persisted, sign-out clears all (DOC §7).
3. **Metadata** — visitorData + live client version, `browse`/`search`, tolerant parser, SQLite cache (DOC §8).
4. **Resolution** — player request, client walk, decipher, probe (DOC §9.1–9.3, 9.6–9.8).
5. **Playback** — Shaka audio-only, queue store, player bar UI, error recovery (DOC §10).
6. **PO tokens** — BotGuard, cold-start + video-bound, renewal (DOC §9.5).
7. **SABR** — `googlevideo` adapter, reload callback, mid-stream recovery (DOC §9.4).
8. **Account sync** — likes, playlists, library, subscriptions, history pings (DOC §11).
9. **Desktop** — tray, media keys, background playback, Settings (Tabs + Card), auto-update (DOC §10.4, §14).
10. **Later** — downloads, lyrics, crossfade, EQ, presence, scrobbling.

---

## 11. Verification

- **Per phase**: manual smoke + a small assert-based self-check or one test file for non-trivial logic (client walk order, SAPISIDHASH output, history cpn reuse, verdict-cache TTL). No test framework sprawl.
- **Playback matrix**: signed-in and signed-out; direct URL track and SABR track; one age-restricted, one region-locked, one premium-only — each must fail with a readable reason, not a spinner.
- **RAM**: measure RSS idle and after 30 min playback with the queue cycling. Watch for renderer leaks in the position ticker and list virtualization.
- **UI**: typecheck clean, no console errors, no horizontal overflow, dark + light, keyboard nav on sidebar/player/dialogs, focus trapped in overlays.
- **OS**: test playback on each target OS (DOC §14), tray + media-key behavior per platform (DOC §10.3/§10.4).
- **Security review**: grep the renderer bundle for cookie/SAPISID/token leakage; confirm CSP; confirm no `webSecurity:false`; confirm no remote page in the privileged renderer.

---

## 12. Risks

- Upstream churn is the dominant risk (DOC §17). The live client version, client walk, PO tokens, probing, and verdict cache are survival features, not polish.
- ToS: this uses private InnerTube + the user's own session. Personal use only; expect maintenance.
- SABR/Shaka integration is the highest-effort unknown — build the direct-URL path first (§10 step 4–5) so playback works before SABR lands.
- BotGuard needs a real JS env; isolate it early (§9 step 6) so CSP decisions don't leak into the UI renderer later.
