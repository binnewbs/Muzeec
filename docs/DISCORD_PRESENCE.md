# Discord Rich Presence

Muzeec publishes the current track to the Discord desktop client over its local
IPC socket. Nothing is sent to Discord's servers by Muzeec itself; the Discord
client then shows the card on the signed-in user's profile. No Discord account,
token, or OAuth flow is involved.

## Setup

1. Create an application at <https://discord.com/developers/applications>.
2. Copy its **Application ID** into `src/main/presence/config.ts` (or set
   `MUZEEC_DISCORD_CLIENT_ID` when running in development).
3. Optionally upload art assets under **Rich Presence → Art Assets**:
   - `muzeec` — fallback when a track has no artwork;
   - `playing` / `paused` — small badges.
4. Enable **Settings → Integrations → Discord Rich Presence**.

The Discord application's name is what appears on the card. Dynamic album art
uses the track's YouTube thumbnail as an external `large_image` URL; Discord
fetches that image, so Muzeec never downloads it.

## The card

```text
Listening to Muzeec
Title
Artist
0:42 ─────────────── 3:21
[Listen on YouTube Music]
```

- `details` is the title and `state` is the artist.
- `timestamps.start` / `timestamps.end` give Discord the progress bar. They are
  omitted while paused so the bar does not keep counting.
- `assets.large_image` is the thumbnail URL (or `muzeec`), and the small badge
  switches between `playing` and `paused`.
- One button opens `https://music.youtube.com/watch?v=<id>`. A second button
  appears only when `PROJECT_URL` is set in `config.ts`.

## Process and memory

The client lives in the Electron **main** process. It opens one local socket and
writes a small JSON frame only when the track, play/pause state, or seek
changes. There is no extra renderer, no image decoding, and no polling loop.

Costs:

- one socket and a handful of timers: well under 2 MB RSS in practice;
- updates are capped at one per 15 seconds, Discord's `SET_ACTIVITY` limit;
- when Discord is closed, connection attempts back off to once every 30 seconds
  (Discord also limits clients to a few connections per minute).

## Protocol

Discord's IPC framing is an 8-byte little-endian header followed by JSON:

| Field | Size | Meaning |
|---|---|---|
| op | 4 bytes | `0` handshake, `1` frame, `2` close, `3` ping, `4` pong |
| length | 4 bytes | JSON byte length |

The client sends `{"v":1,"client_id":"…"}` as opcode `0`, waits for the
`READY` dispatch, then sends `SET_ACTIVITY` frames. Replies are matched by
`nonce`; ping frames are answered with pong.

Socket paths:

- Windows: `\\?\pipe\discord-ipc-0` … `9`
- Linux/macOS: `$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP`, `/tmp`,
  plus the Flatpak and Snap sandbox paths when `$XDG_RUNTIME_DIR` is set.

## Privacy

Only the current track metadata and the YouTube Music link are sent, and only
to the local Discord client. The setting is off by default. Signing out of
YouTube does not affect presence because no account is linked.
