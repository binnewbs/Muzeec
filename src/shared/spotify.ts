const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/

function isSpotifyHost(host: string): boolean {
  return host === "spotify.com" || host.endsWith(".spotify.com")
}

/** Extracts a Spotify playlist id from links and `spotify:playlist:` URIs. */
export function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (trimmed.startsWith("spotify:playlist:")) {
    const id = trimmed
      .slice("spotify:playlist:".length)
      .split("?")[0]
      .split("/")[0]
    return PLAYLIST_ID.test(id) ? id : null
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (!isSpotifyHost(url.hostname.toLowerCase())) return null

  const segments = url.pathname.split("/").filter(Boolean)
  const at = segments.indexOf("playlist")
  if (at === -1 || at + 1 >= segments.length) return null

  const id = segments[at + 1]
  return PLAYLIST_ID.test(id) ? id : null
}

/** True for the mobile share-sheet links that do not contain a playlist id. */
export function isSpotifyShortLink(input: string): boolean {
  try {
    const url = new URL(input.trim())
    return url.hostname.toLowerCase() === "spotify.link"
  } catch {
    return false
  }
}
