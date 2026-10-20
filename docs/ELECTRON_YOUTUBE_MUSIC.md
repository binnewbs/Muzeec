# Building a YouTube Music desktop client with Electron

A practical architecture for an Electron app that signs in with a Google/YouTube session, fetches YouTube Music metadata, resolves audio streams, plays them, and writes plays back to the account's history.

This document is standalone. It assumes a new project, not any existing codebase.

---

## 1. What you are building

A desktop music player with:

- YouTube Music browse, search, album, artist, and playlist pages.
- Audio playback from YouTube's streams.
- Google account sign-in using the user's own YouTube Music session.
- Library, likes, playlists, subscriptions, and listening history synced to that account.
- Optional queue, crossfade, media keys, tray, and offline cache.

The hard parts are not React or Electron. They are:

1. Reproducing a valid YouTube client identity.
2. Signing authenticated requests with Google cookies.
3. Resolving stream URLs that actually serve audio.
4. Minting BotGuard/PO tokens so streams are not cut off.
5. Keeping the UI fast while YouTube changes its client versions and player scripts.

Plan for all five from the start.

---

## 2. Why Electron is the right shell

YouTube playback assumes a Chromium-like browser:

- Media Source Extensions (MSE)
- Web Audio
- `HTMLAudioElement`
- `fetch`
- `WebAssembly`
- JavaScript player scripts
- BotGuard's interpreter JavaScript

Electron bundles Chromium on every platform, so playback behavior is consistent. Tauri uses the operating system webview (WebView2, WKWebView, WebKitGTK), which varies in codec and MSE support. That matters most on Linux, where WebKitGTK can fail on streams that work in Chromium.

Electron also gives you:

- A real cookie jar: `session.cookies`.
- Request header rewriting: `session.webRequest`.
- Response header rewriting for CORS: `session.webRequest.onHeadersReceived`.
- Main-process HTTP with no CORS restrictions.
- A hidden or sandboxed `BrowserWindow` for BotGuard if needed.
- Node APIs for downloads, SQLite, cache, and native modules.

The tradeoff is binary size and RAM. For a music player, that is usually acceptable.

---

## 3. Process architecture

Use three layers.

```
main process
  - Google session and cookies
  - InnerTube HTTP requests
  - SAPISIDHASH signing
  - account and channel selection
  - BotGuard GenerateIT request
  - downloads, cache, database
  - window, tray, media keys, updates

preload
  - typed IPC bridge only
  - no raw cookies or tokens exposed to the page

renderer
  - React UI
  - youtubei.js or your own InnerTube parser
  - Shaka Player
  - googlevideo SABR adapter
  - BotGuard interpreter (or a hidden worker window)
  - queue and player state
```

The renderer should never receive:

- the `Cookie` header,
- the SAPISID signing secret,
- a long-lived auth token.

It should receive only results: browse JSON, player JSON, resolved URLs, and auth status.

---

## 4. Recommended project layout

```
src/
  main/
    index.ts
    protocol.ts
    window.ts
    ipc.ts
    youtube/
      session.ts
      auth.ts
      sapisid.ts
      innertube.ts
      player.ts
      botguard.ts
      headers.ts
      probe.ts
    storage/
      settings.ts
      cache.ts
  preload/
    index.ts
  renderer/
    main.tsx
    App.tsx
    player/
      engine.ts
      shaka.ts
      sabr.ts
      queue.ts
    pages/
```

Use `electron-vite`, Electron Forge, or a Vite + Electron setup. The important boundary is main/preload/renderer, not the bundler.

Suggested dependencies:

```
electron
electron-vite or @electron-forge/cli
react
react-dom
zustand
youtubei.js
googlevideo
shaka-player
bgutils-js
electron-updater
better-sqlite3        (optional, local cache)
keytar or safeStorage (credential storage)
```

---

## 5. Serving the UI: do not use file://

`file://` has awkward origin, CORS, and storage behavior. Register a custom scheme instead.

Before `app.whenReady()`:

```ts
import { protocol } from 'electron';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
```

After ready:

```ts
import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

protocol.handle('app', (request) => {
  const url = new URL(request.url);
  const filePath = path.join(__dirname, '../renderer', url.pathname);
  return net.fetch(pathToFileURL(filePath).toString());
});
```

Load:

```ts
win.loadURL('app://musicapp/index.html');
```

Set `base: './'` in Vite so assets resolve under the custom scheme. Handle deep links in React Router with hash routing, or make the protocol handler fall back to `index.html` for unknown paths.

The resulting origin is `app://musicapp`. It is stable across launches, which matters for storage and for any local backend you add later.

---

## 6. Network model

Use two different paths.

### 6.1 Authenticated YouTube API calls: main process

All InnerTube calls go through IPC to the main process.

Why:

- No CORS.
- Cookies stay in the main process.
- You can set `Origin`, `Referer`, and `X-Origin` exactly.
- You can sign with SAPISIDHASH without exposing the secret.
- You can retry and log without browser restrictions.

The renderer calls something like:

```ts
window.musicapp.youtube.browse({ browseId, params });
window.musicapp.youtube.search({ query });
window.musicapp.youtube.player({ videoId, client });
```

The preload exposes typed methods:

```ts
contextBridge.exposeInMainWorld('musicapp', {
  youtube: {
    authState: () => ipcRenderer.invoke('yt:authState'),
    login: () => ipcRenderer.invoke('yt:login'),
    logout: () => ipcRenderer.invoke('yt:logout'),
    browse: (input) => ipcRenderer.invoke('yt:browse', input),
    search: (input) => ipcRenderer.invoke('yt:search', input),
    player: (input) => ipcRenderer.invoke('yt:player', input),
    history: (input) => ipcRenderer.invoke('yt:history', input),
  },
});
```

### 6.2 Media bytes: renderer

Audio should come from `googlevideo.com` directly to the renderer. Do not proxy audio through your server or main process unless you have a specific reason.

The renderer needs two things:

1. Request headers that match the client that minted the URL.
2. CORS response headers so Shaka can read the bytes.

Attach a session-level header rewriter:

```ts
import { session } from 'electron';

const yt = session.fromPartition('persist:youtube');

yt.webRequest.onBeforeSendHeaders(
  {
    urls: [
      '*://*.googlevideo.com/*',
      '*://music.youtube.com/youtubei/*',
      '*://www.youtube.com/youtubei/*',
    ],
  },
  (details, callback) => {
    const headers = { ...details.requestHeaders };
    const url = new URL(details.url);

    if (url.hostname.endsWith('googlevideo.com')) {
      // VISIONOS direct URLs are refused if a web Origin is attached.
      if (url.searchParams.get('c') === 'VISIONOS') {
        delete headers.Origin;
        delete headers.Referer;
      } else {
        headers.Origin = 'https://www.youtube.com';
        headers.Referer = 'https://www.youtube.com/';
      }
      headers['User-Agent'] = CHROME_USER_AGENT;
    }

    callback({ requestHeaders: headers });
  },
);
```

And response headers:

```ts
yt.webRequest.onHeadersReceived(
  { urls: ['*://*.googlevideo.com/*'] },
  (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Access-Control-Allow-Origin'] = ['*'];
    responseHeaders['Access-Control-Expose-Headers'] = ['*'];
    callback({ responseHeaders });
  },
);
```

If the renderer uses a different session from the one where you attached the rules, the rules will not apply. Keep the UI window, login window, and media requests on the same persistent partition, or attach the same rules to both sessions.

### 6.3 If you keep `youtubei.js` in the renderer

`youtubei.js` expects a `fetch` function. Give it a custom fetch that sends YouTube hosts through IPC and everything else through normal `fetch`:

```ts
async function ytFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : input.toString());

  if (url.hostname === 'music.youtube.com' || url.hostname === 'www.youtube.com') {
    const body = init?.body ?? (request ? await request.text() : undefined);
    return window.musicapp.youtube.fetch({
      url: url.toString(),
      method: init?.method ?? request?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers ?? request?.headers)),
      body: typeof body === 'string' ? body : undefined,
    });
  }

  return fetch(input, init);
}
```

`youtubei.js` also runs YouTube's player script to decipher signature and `n` parameters. That uses `new Function` or a JS VM. In Electron, this interacts with your Content Security Policy. Either:

- allow `'unsafe-eval'` for your local `app://` origin, or
- run the player-script decoder in a sandboxed hidden window or utility process.

Do not load remote HTML into the same renderer that has Node access.

---

## 7. Authentication

### 7.1 The credential model

There is no official YouTube Music API. Authentication is a Google web session, represented by cookies.

The signing cookies, in preference order:

```
SAPISID
__Secure-3PAPISID
__Secure-1PAPISID
```

The request signature:

```
timestamp = Math.floor(Date.now() / 1000)
digest    = SHA1(`${timestamp} ${SAPISID} ${origin}`)
header    = `SAPISIDHASH ${timestamp}_${hexDigest}`
```

TypeScript with Web Crypto:

```ts
async function sapisidHash(secret: string, origin: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = new TextEncoder().encode(`${timestamp} ${secret} ${origin}`);
  const digest = await crypto.subtle.digest('SHA-1', data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `SAPISIDHASH ${timestamp}_${hex}`;
}
```

Signed requests carry:

```
Cookie: <session cookies>
Authorization: SAPISIDHASH <timestamp>_<hash>
X-Goog-AuthUser: <account index>
X-Origin: https://music.youtube.com
X-Goog-PageId: <brand channel id, optional>
```

And, depending on the endpoint, the body carries:

```jsonc
"context": {
  "user": {
    "onBehalfOfUser": "<DELEGATED_SESSION_ID>"
  }
}
```

### 7.2 Embedded sign-in window

The most reliable approach is to let the user sign in to Google's real page.

Create a `BrowserWindow` with a persistent partition:

```ts
const authWin = new BrowserWindow({
  width: 520,
  height: 720,
  parent: mainWindow,
  modal: true,
  webPreferences: {
    partition: 'persist:youtube',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  },
});

await authWin.loadURL(
  'https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&prompt=select_account&continue=https%3A%2F%2Fmusic.youtube.com%2F',
);
```

After navigation reaches `https://music.youtube.com`, read the session from the same partition:

```ts
const cookies = await session
  .fromPartition('persist:youtube')
  .cookies.get({ url: 'https://music.youtube.com' });

const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
```

Then read the live page's config:

```ts
const config = await authWin.webContents.executeJavaScript(`
  (() => {
    if (!window.ytcfg || !window.ytcfg.get) return null;
    const get = (k) => {
      const v = window.ytcfg.get(k);
      return v === undefined || v === null || v === '' ? null : String(v);
    };
    return {
      loggedIn: String(!!window.ytcfg.get('LOGGED_IN')),
      pageId: get('DELEGATED_SESSION_ID'),
      dataSyncId: get('DATASYNC_ID'),
      authUser: get('SESSION_INDEX'),
      visitorData: get('VISITOR_DATA'),
      clientVersion: get('INNERTUBE_CLIENT_VERSION')
    };
  })()
`);
```

Reject the capture unless:

- `loggedIn === 'true'`,
- the cookie header contains a real signing cookie name.

Check cookie names exactly. `__Secure-3PAPISID` contains the substring `SAPISID`; a naive `includes('SAPISID')` check gives a false positive.

The window should stay open until the user confirms. Multi-account users need time to choose a personal or brand channel on the YouTube Music page.

### 7.3 Reading the account scope

A cookie is not an account. One Google login can hold several accounts, each with brand channels.

Read these from the `music.youtube.com` shell or from the live page's `ytcfg`:

| Key | Use |
|---|---|
| `LOGGED_IN` | Must be true before trusting any id |
| `SESSION_INDEX` | `X-Goog-AuthUser` |
| `DELEGATED_SESSION_ID` | `X-Goog-PageId` and `context.user.onBehalfOfUser` for a brand channel |
| `DATASYNC_ID` | Local account keys; not an InnerTube auth field |
| `VISITOR_DATA` | `X-Goog-Visitor-Id` |
| `INNERTUBE_CLIENT_VERSION` | WEB_REMIX client version |

Never guess `DELEGATED_SESSION_ID`. A value Google cannot tie to the cookie is answered with `401` on every request.

If the shell says it is signed out, ignore its `DATASYNC_ID`. Keep only its client version.

### 7.4 Account and channel switching

Two approaches:

1. **Use YouTube Music's own account switcher.**
   - Open `https://music.youtube.com/` in a window with the saved cookies.
   - Let the user switch to the desired channel using the avatar menu.
   - Read `ytcfg` again and save the new `pageId` / `dataSyncId` / `authUser`.

2. **Enumerate accounts programmatically.**
   - For `X-Goog-AuthUser` indices `0..9`, POST to `account/account_menu`.
   - A signed-in index returns an `activeAccountHeaderRenderer`.
   - For each login, POST to `account/accounts_list` to list brand channels.
   - Each channel carries a `pageIdToken` and `datasyncIdToken`; use those rather than constructing ids.

Not every index is signed in, and live indices need not be contiguous.

### 7.5 Cookie import from installed browsers

This is optional but valuable.

- Firefox: read `moz_cookies` from `cookies.sqlite`.
- Chromium: read `cookies` from the profile's `Cookies` SQLite database.

Chromium cookies are encrypted:

- Windows: DPAPI master key from `Local State`.
- macOS: Keychain.
- Linux: GNOME Keyring / KWallet.

This is platform-specific work and can break when browsers change their storage. An embedded sign-in is more predictable.

### 7.6 Storing the session

You have two choices:

1. **Let Chromium persist the login** in `persist:youtube`. You do not need to store the cookie yourself. `session.cookies` reads it when needed.
2. **Store a cookie snapshot** if you want multiple saved accounts. Encrypt it with Electron's `safeStorage`.

If you store it:

```ts
import { safeStorage } from 'electron';

const sealed = safeStorage.encryptString(cookieHeader);
const plain = safeStorage.decryptString(sealed);
```

`safeStorage` is not a hardware-backed vault on every platform. Treat the cookie as a full account credential. Do not log it, put it in crash reports, or send it to the renderer.

### 7.7 Sign-out

Clear:

- the saved cookie snapshot,
- the `persist:youtube` cookies for Google/YouTube hosts,
- the session scope,
- cached player responses,
- client exclusions,
- BotGuard tokens.

If the WebView or auth window keeps its Google cookies, the next sign-in is silently recognized as the account that just signed out.

---

## 8. Fetching metadata

### 8.1 Bootstrapping the client

All metadata requests go to:

```
POST https://music.youtube.com/youtubei/v1/{endpoint}
```

Use the WEB_REMIX client:

```jsonc
{
  "context": {
    "client": {
      "clientName": "WEB_REMIX",
      "clientVersion": "1.2025...",
      "hl": "en",
      "gl": "US",
      "visitorData": "..."
    },
    "user": {
      "lockedSafetyMode": false,
      "onBehalfOfUser": "..."
    },
    "request": { "useSsl": true }
  }
}
```

Headers:

```
Content-Type: application/json
X-Origin: https://music.youtube.com
Origin: https://music.youtube.com
Referer: https://music.youtube.com/
X-YouTube-Client-Name: 67
X-YouTube-Client-Version: <live>
X-Goog-Visitor-Id: <visitorData>
Cookie: <when signed in>
Authorization: SAPISIDHASH <...>
X-Goog-AuthUser: <index>
X-Goog-PageId: <brand channel, optional>
```

### 8.2 Client version and visitor data

Do not hardcode the client version permanently. Read it from the YouTube Music shell:

```ts
const html = await fetch('https://music.youtube.com/', {
  headers: { Cookie: cookieHeader },
}).then((r) => r.text());

const clientVersion = /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1];
const visitorData = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(html)?.[1];
```

Visitor data is mandatory for reliable playback. Without it, Google may:

- answer `LOGIN_REQUIRED` / "Sign in to confirm you're not a bot", or
- return URLs that serve one byte and then reject real reads with `403`.

If the shell has no visitor data, fetch an anonymous one from:

```
GET https://www.youtube.com/sw.js_data
```

Parse the anti-hijacking prefix and search nested arrays for a value shaped like:

```regex
Cg[A-Za-z0-9_%-]{40,}
```

A visitor data value from a signed-in page is better than an anonymous one. Do not overwrite it with an anonymous value.

### 8.3 Endpoints

| Endpoint | Purpose |
|---|---|
| `browse` | Home, library, album, artist, playlist |
| `browse` + continuation | Paged lists |
| `search` | Search results |
| `music/get_search_suggestions` | Typeahead suggestions |
| `next` | Radio / autoplay (`RDAMVM<videoId>`) |
| `player` | Stream metadata and playback tracking |
| `account/account_menu` | Signed-in profile |
| `account/accounts_list` | Brand channels |
| `get_transcript` | Timed captions |
| `like/like`, `like/dislike`, `like/removelike` | Ratings and saves |
| `playlist/create`, `playlist/delete` | Playlist lifecycle |
| `browse/edit_playlist` | Add/remove/move/rename playlist items |
| `feedback` | Library add/remove token |
| `subscription/subscribe`, `subscription/unsubscribe` | Artist subscriptions |

Search deliberately anonymous:

- Regular search should omit the cookie if you do not want every query in the account's YouTube Music search history.
- Typeahead must be anonymous because it fires on every debounced keystroke.

### 8.4 Parsing

InnerTube returns shelf renderers, not a stable public schema. Write a tolerant parser:

- Search recursively for known renderer keys rather than assuming a fixed path.
- Treat missing fields as absent, not fatal.
- Log unknown renderer names so a YouTube change is visible.
- Cache parsed pages, not raw HTTP responses, if you need speed.

Do not use a lenient JSON parser that turns a wrong envelope into an empty list. Fail visibly in development.

---

## 9. Resolving streams

### 9.1 The player request

```
POST https://music.youtube.com/youtubei/v1/player
```

Body:

```jsonc
{
  "videoId": "...",
  "contentCheckOk": true,
  "racyCheckOk": true,
  "playbackContext": {
    "contentPlaybackContext": {
      "signatureTimestamp": 12345
    }
  }
}
```

The response contains:

- `streamingData.adaptiveFormats` — direct media URLs.
- `streamingData.serverAbrStreamingUrl` — SABR.
- `playabilityStatus` — OK, or a reason the track is unavailable.

Do not assume every `playabilityStatus: OK` response is playable. Check that there is:

- a `serverAbrStreamingUrl`, or
- at least one adaptive audio format with a direct URL.

### 9.2 Client identities

YouTube answers different clients differently. A track refused to one may play on another.

Useful web clients:

```
VISIONOS
YTMUSIC   (WEB_REMIX)
WEB
MWEB
```

Observed behavior:

- `VISIONOS` often returns direct audio URLs.
- `YTMUSIC`, `WEB`, and `MWEB` often return SABR.
- Signed-in playback should try the web clients first, because they accept the SAPISIDHASH session and are more likely to serve age-restricted tracks.

Walk clients until one returns a playable response. Exclude a client for that track for about 10 minutes after a refusal.

Permanent refusals:

- age restriction
- region restriction
- private video
- terminated channel
- premium-only
- removed video

Cache those verdicts for about 10 minutes. Otherwise every retry layer will re-walk every client and hammer YouTube.

### 9.3 Direct URLs

A direct URL can be:

- `url`
- `signatureCipher`
- `cipher`

The last two require applying YouTube's player JavaScript:

- decipher the signature,
- transform the `n` parameter.

`youtubei.js` can do this with a player-script evaluator. If you write your own client, you must fetch `/s/player/<id>/...`, extract the relevant functions, and run them.

For BotGuard clients, append the token:

```
https://...googlevideo.com/...&pot=<video-bound token>
```

### 9.4 SABR

SABR is YouTube's server-controlled streaming protocol. Use `googlevideo`'s SABR adapter with Shaka.

At a high level:

```ts
import { SabrStreamingAdapter } from 'googlevideo/sabr-streaming-adapter';
import { buildSabrFormat } from 'googlevideo/utils';

const adapter = new SabrStreamingAdapter({
  playerAdapter: shakaAdapter,
  clientInfo: {
    osName: sessionClient.osName,
    osVersion: sessionClient.osVersion,
    clientName: Number(clientNameId),
    clientVersion: sessionClient.clientVersion,
  },
});

adapter.onMintPoToken(async () => {
  return videoBoundToken ?? coldStartToken;
});

adapter.onReloadPlayerResponse(async (reloadContext) => {
  const response = await requestPlayer(videoId, client, reloadContext);
  adapter.setStreamingURL(await decipher(response.streamingData.serverAbrStreamingUrl));
  adapter.setUstreamerConfig(response.playerConfig...videoPlaybackUstreamerConfig);
});

adapter.attach(shakaPlayer);
adapter.setStreamingURL(await decipher(streamingData.serverAbrStreamingUrl));
adapter.setUstreamerConfig(ustreamerConfig);
adapter.setServerAbrFormats(streamingData.adaptiveFormats.map(buildSabrFormat));

await shakaPlayer.load(sabrDashManifest);
```

Important SABR details:

- The SABR URL must be deciphered if it is ciphered.
- The ustreamer config comes from the player response.
- The adapter needs a small player adapter that speaks to Shaka.
- Do not let Shaka blindly retry a failed SABR request. The request body is built once and becomes stale. Restart streaming with a fresh request instead.
- The server may ask for a fresh player response mid-stream. Handle `onReloadPlayerResponse`.

### 9.5 BotGuard and PO tokens

PO tokens are required for reliable streaming. Without them, googlevideo may cut a stream after roughly 70 seconds or refuse ranges past the first megabyte.

The flow:

1. Request a BotGuard challenge:

   ```
   POST https://www.youtube.com/api/jnn/v1/Create
   ```

2. Parse the challenge and load its interpreter JavaScript.
3. Create a BotGuard client from `bgutils-js`.
4. Take a snapshot with `webPoSignalOutput`.
5. Request an integrity token:

   ```
   POST https://www.youtube.com/api/jnn/v1/GenerateIT
   ```

   This request must carry YouTube's own `Origin`. A token minted for another origin is rejected. Do this from the main process, or from the extension-equivalent layer, so you can set the header.

6. Create a `WebPoMinter` from the integrity token and signal output.
7. Mint tokens:

```ts
const visitorToken = await minter.mintAsWebsafeString(visitorData);
const videoToken = await minter.mintAsWebsafeString(videoId);
```

Use:

- visitor-bound token in `serviceIntegrityDimensions.poToken` on the player request.
- video-bound token as `pot` on media URLs, or via the SABR `onMintPoToken` callback.

A cold-start token can be used immediately while the real token is minted in the background. That keeps a track from waiting on BotGuard.

BotGuard needs a real JavaScript environment. In Electron, run it in:

- the renderer, if your CSP allows it, or
- a hidden sandboxed `BrowserWindow` with no Node access.

Do not run untrusted YouTube JavaScript in a window with `nodeIntegration: true`.

### 9.6 Media request headers

`googlevideo` encodes the minting client in the URL as `c=` and `cver=`. The request that fetches the bytes must look like that client.

Examples:

| URL client | Headers |
|---|---|
| `VISIONOS` | no `Origin`, no `Referer`, matching User-Agent |
| `WEB_REMIX` | `Origin: https://music.youtube.com`, matching Referer |
| `WEB` / `MWEB` | `Origin: https://www.youtube.com`, matching Referer |
| `ANDROID` / `IOS` | matching native User-Agent |

A mismatch is enough for googlevideo to throttle the stream or return `403`.

Implement a mapping from URL to headers, and use the same map for:

- the probe request,
- the real Shaka media request.

### 9.7 Probe before playback

Do not hand a freshly minted URL straight to the player.

Send a `Range` request:

1. Start past 1 MiB when the file is large enough.
2. Use the exact media headers.
3. Reject `403`, `404`, `410`.
4. Require `Content-Type` to start with `audio/`.
5. Require at least 16 KiB of the body to actually arrive.

Some URLs serve the first megabyte and then refuse everything after it. Without this probe, that failure appears as a track that spins forever.

If a URL is refused during playback, invalidate it and exclude the client that minted it for that track.

### 9.8 Fallback strategy

At minimum:

1. Try the best client.
2. Probe the URL.
3. Try the next client.
4. Cache the unplayable verdict if the reason is permanent.
5. Re-resolve after a mid-playback refusal.

You can add a server-side extractor such as yt-dlp as a last resort, but treat it as a separate subsystem. It has its own update cycle, dependencies, and failure modes.

---

## 10. Playback in the renderer

### 10.1 Shaka

Use Shaka Player for:

- direct DASH manifests,
- SABR manifests,
- byte-range media requests,
- seeking and buffering.

Configure it for audio only:

```ts
player.configure({
  manifest: {
    disableVideo: true,
    disableText: true,
    disableThumbnails: true,
  },
  abr: { enabled: false },
  preferredAudioCodecs: ['opus', 'mp4a'],
  streaming: {
    bufferingGoal: 120,
    rebufferingGoal: 0.01,
    bufferBehind: 300,
  },
});
```

Prefer Opus (usually itag 251), then AAC (itag 140). Avoid DRC renditions when selecting the highest bitrate.

### 10.2 Audio graph

For a polished player:

- Route one or two `<audio>` elements through a Web Audio graph.
- Use the graph for volume, crossfade, and optional EQ.
- Keep a second engine ready for crossfade.
- Use `AudioContext.outputLatency` plus `baseLatency` when reporting the real playback position.

### 10.3 Media Session

Use the Media Session API for:

- metadata,
- artwork,
- play/pause,
- next/previous,
- seek,
- position state.

Electron's Chromium may surface this to the operating system. If you need full Linux MPRIS or Windows SMTC behavior, add a native module or a small helper process. Test on each target OS; do not assume Chromium's media session covers every desktop control surface.

### 10.4 Background playback

- Keep the player alive when the window is hidden.
- Use `powerSaveBlocker.start('prevent-app-suspension')` while playing.
- Use `globalShortcut` for media keys if the OS integration is insufficient, but be aware that global shortcuts can steal keys from other apps.
- Add a tray menu with play/pause/next and quit.

---

## 11. Syncing with the account

### 11.1 Library, likes, and playlists

These are live YouTube operations, not a local mirror.

Reads:

- `browse` for library shelves.
- `account/account_menu` for the active profile.
- `account/accounts_list` for channels.

Writes:

- `like/like`, `like/dislike`, `like/removelike`
- `like/like` / `like/removelike` with a playlist target to save or unsave an album/playlist
- `playlist/create`, `playlist/delete`
- `browse/edit_playlist` for add, remove, move, rename
- `feedback` with YouTube's own token to add/remove a library item
- `subscription/subscribe` / `subscription/unsubscribe`

Check the response body, not only the HTTP status. Innertube can answer `200` with an `error` object when it refuses a write.

### 11.2 Playback history

To make the account's home feed reflect what the app played, register plays with YouTube's stats endpoints.

One play is three pings, all with the same client-playback-nonce (`cpn`):

1. `videostatsPlaybackUrl` when the track becomes audible.
2. `atrUrl` a few seconds in.
3. `videostatsWatchtimeUrl` every ~30 seconds, and once more at the end with `final=1`.

The tracking URLs come from a `player` request made with the cookie, read from `playbackTracking`.

The `player` request must include a current `signatureTimestamp`. Without it, YouTube Music may answer `200` with `UNPLAYABLE` and omit `playbackTracking`.

Stats requests carry:

```
Cookie
Authorization: SAPISIDHASH ...
X-Goog-AuthUser
X-Goog-PageId (when a brand channel)
X-Goog-Visitor-Id
X-Origin: https://music.youtube.com
Origin: https://music.youtube.com
Referer: https://music.youtube.com/
User-Agent: Chrome
```

Plus web-client query parameters:

```
c=WEB_REMIX
cver=<live version>
cplayer=UNIPLAYER
cbr=Chrome
cos=Windows
hl=<language>
cr=<region>
```

Rules:

- A play needs the playback ping. No playback ping, no history entry.
- A play with no watchtime looks like a skip.
- The same `cpn` must be used for all three pings.
- A new `cpn` for every play.
- Flush watchtime when the queue changes, not only when a track ends.
- Send a final watchtime ping even if that position was already reported.
- Treat all of this as best effort; never block playback on a history ping.

### 11.3 What does not sync

Unless you build it explicitly, these stay local:

- downloads and offline files,
- playback position,
- local queue,
- local listening statistics,
- app settings.

Do not describe local state as "synced" unless you actually write it to the account or a server.

---

## 12. Error handling

Classify failures early.

Permanent:

- age-restricted
- region-restricted
- private
- terminated channel
- premium-only
- removed
- paid content

Temporary:

- network timeout
- shaped watch page
- SABR pacing
- transient `403` from one client
- stale player config
- PoToken timeout
- dead connection from a pool

Cache permanent verdicts for a few minutes. Retry temporary failures with backoff, but do not let several layers retry the same permanent failure independently.

Log:

- video id,
- client identity,
- HTTP status,
- player status/reason,
- whether the request was signed in,
- time spent per step.

A single failed track should produce a readable reason, not a generic "playback error".

---

## 13. Security

Use:

```ts
webPreferences: {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  preload: path.join(__dirname, 'preload.js'),
}
```

Rules:

- Never expose `fs`, `child_process`, cookies, or arbitrary HTTP to the renderer.
- Validate every IPC argument.
- Keep the renderer on a local `app://` origin.
- Do not load remote pages into the privileged renderer.
- Use a strict Content Security Policy.
- If the player-script evaluator needs `eval`, isolate it in a sandboxed window or utility process instead of weakening the whole app.
- Encrypt stored credentials with `safeStorage`.
- Do not log cookies, SAPISID, or PO tokens.
- Do not disable `webSecurity`.
- Do not proxy audio through a remote server. It costs bandwidth and makes every user's traffic originate from your IP, which YouTube blocks.

---

## 14. Packaging and updates

- Use Electron Forge or electron-builder.
- Sign and notarize macOS builds.
- Sign Windows builds; unsigned installers trigger SmartScreen.
- Ship `.dmg`, `.exe`/`.msi`, `.AppImage`/`.deb`/`.rpm` as appropriate.
- Use `electron-updater` or Forge's updater.
- Keep the app's Chromium/Electron version current; YouTube's web client changes.
- Test playback on each target OS, not only the build host.

---

## 15. Build order

Do not start with UI polish.

1. **Auth shell**
   - Login window.
   - Cookie read.
   - `ytcfg` read.
   - Auth state persisted.
   - Sign-out clears everything.

2. **InnerTube metadata**
   - Visitor data.
   - Live client version.
   - `browse` and `search`.
   - Tolerant parser.

3. **Stream resolution**
   - Player request.
   - Client walk.
   - Direct URLs.
   - Player-script deciphering.
   - Probe.

4. **Playback**
   - Shaka with audio only.
   - Basic queue.
   - Error recovery.

5. **PO tokens**
   - BotGuard.
   - Visitor-bound and video-bound tokens.
   - Renewal and cold-start behavior.

6. **SABR**
   - `googlevideo` adapter.
   - Reload callback.
   - Mid-stream recovery.

7. **Account sync**
   - Likes.
   - Playlists.
   - Library.
   - History pings.

8. **Desktop polish**
   - Tray.
   - Media keys.
   - Background playback.
   - Crossfade.
   - Auto-update.

9. **Optional**
   - Downloads.
   - Local library.
   - Lyrics.
   - Discord presence.
   - Scrobbling.

---

## 16. Common mistakes

- Hardcoding `INNERTUBE_CLIENT_VERSION`.
- Omitting visitor data.
- Treating `playabilityStatus: OK` as proof of playable audio.
- Sending `DATASYNC_ID` as `onBehalfOfUser`; it must be `DELEGATED_SESSION_ID`.
- Checking `includes('SAPISID')` instead of exact cookie names.
- Sending `Origin: app://...` to YouTube endpoints.
- Attaching a web `Origin` to VISIONOS direct URLs.
- Using the wrong User-Agent for the URL's `c=` client.
- Using a fresh `cpn` for each history ping.
- Forgetting the final watchtime ping.
- Retrying a permanent unplayable verdict at every layer.
- Running remote YouTube JavaScript in a renderer with Node access.
- Proxying audio through a server.
- Assuming Electron's system webview and Chromium codecs are identical across OSes. They are the same because Electron bundles Chromium; do not replace it with a system webview.

---

## 17. Legal note

YouTube's official API does not provide YouTube Music streaming. Everything described here uses YouTube's private InnerTube API, cookie-authenticated web sessions, and BotGuard tokens. This is against YouTube's Terms of Service. Endpoints, client versions, player scripts, and token requirements change without notice.

If you build this, expect maintenance. The fallback clients, live client version, PO token renewal, URL probing, and permanent-failure cache are not optional polish; they are how the system survives upstream changes.
