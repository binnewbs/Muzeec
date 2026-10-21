export const SPOTIFY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"

export const SPOTIFY_TIMEOUT_MS = 20_000

export class ImportCancelled extends Error {
  constructor() {
    super("Import cancelled")
    this.name = "ImportCancelled"
  }
}

export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** Fetch a Spotify URL with a bounded timeout and cancellation support. */
export async function spotifyFetch(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  if (isAborted(signal)) throw new ImportCancelled()
  const timeout = AbortSignal.timeout(SPOTIFY_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    return await fetch(url, {
      ...init,
      signal: combined,
      headers: {
        "User-Agent": SPOTIFY_UA,
        "Accept-Language": "en-US,en;q=0.9",
        ...init.headers,
      },
    })
  } catch (error) {
    if (isAborted(signal)) throw new ImportCancelled()
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Spotify took too long to respond. Try again.")
    }
    throw new Error("Could not reach Spotify. Check your connection and try again.")
  }
}
