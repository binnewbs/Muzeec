import { test } from "node:test"
import assert from "node:assert/strict"
import type { SpotifyTrack } from "../src/shared/types.ts"
import { extractPlaylistId, isSpotifyShortLink } from "../src/shared/spotify.ts"
import { parseEmbedPlaylist } from "../src/main/spotify/embed.ts"
import { extractPlaylistHash, parsePlaylistPage, readPlaylistPages } from "../src/main/spotify/pathfinder.ts"
import { candidateOf } from "../src/main/spotify/candidate.ts"
import { parseBrowsePage } from "../src/main/youtube/parser.ts"
import {
  buildQueries,
  matchTrack,
  parseTitle,
  rankCandidates,
  type MatchCandidate,
} from "../src/main/spotify/matcher.ts"

const ID = "37i9dQZF1DXcBWIGoYBM5M"

function track(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    sourceId: "source",
    title: "Song",
    artists: ["Artist"],
    album: null,
    durationMs: 200_000,
    isrc: null,
    artworkUrl: null,
    explicit: null,
    ...overrides,
  }
}

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    videoId: "yt-1",
    title: "Song",
    artists: ["Artist"],
    album: null,
    durationSec: 200,
    ...overrides,
  }
}

test("Spotify playlist URLs are parsed and other links are rejected", () => {
  const cases: Array<[string, string | null]> = [
    [`https://open.spotify.com/playlist/${ID}`, ID],
    [`https://open.spotify.com/playlist/${ID}?si=abc123`, ID],
    [`https://open.spotify.com/intl-id/playlist/${ID}`, ID],
    [`spotify:playlist:${ID}`, ID],
    [`https://open.spotify.com/album/${ID}`, null],
    [`https://notspotify.com/playlist/${ID}`, null],
    [`ftp://open.spotify.com/playlist/${ID}`, null],
    ["https://open.spotify.com/playlist/short", null],
    ["", null],
  ]
  for (const [input, expected] of cases) assert.equal(extractPlaylistId(input), expected, input)
  assert.equal(isSpotifyShortLink("https://spotify.link/abc"), true)
  assert.equal(isSpotifyShortLink("https://open.spotify.com/playlist/x"), false)
})

test("embed parser reads both entity shapes and skips episodes", () => {
  const entity = {
    name: "Road Trip",
    coverArt: { sources: [{ width: 64, url: "https://i.scdn.co/small" }, { width: 640, url: "https://i.scdn.co/big" }] },
    trackList: [
      {
        uri: "spotify:track:abc",
        title: "Song",
        subtitle: "Artist, Guest",
        duration: 213_500,
        isExplicit: false,
        entityType: "track",
      },
      { uri: "spotify:episode:ep", title: "Episode", entityType: "episode" },
    ],
  }
  const nested = {
    props: {
      pageProps: {
        state: { data: { entity }, settings: { session: { accessToken: "anonymous-token" } } },
      },
    },
  }
  const parsed = parseEmbedPlaylist(
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nested)}</script>`,
    ID,
  )
  assert.equal(parsed.name, "Road Trip")
  assert.equal(parsed.cover, "https://i.scdn.co/big")
  assert.equal(parsed.token, "anonymous-token")
  assert.equal(parsed.skipped, 1)
  assert.equal(parsed.tracks.length, 1)
  assert.deepEqual(parsed.tracks[0], {
    sourceId: "abc",
    title: "Song",
    artists: ["Artist, Guest"],
    album: null,
    durationMs: 213_500,
    isrc: null,
    artworkUrl: "https://i.scdn.co/big",
    explicit: false,
  })

  const flat = { props: { pageProps: { entity: { ...entity, name: "Flat" } } } }
  const flatParsed = parseEmbedPlaylist(
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(flat)}</script>`,
    ID,
  )
  assert.equal(flatParsed.name, "Flat")
  assert.equal(flatParsed.token, null)
})

test("embed parser fails clearly when Spotify changes the page", () => {
  assert.throws(() => parseEmbedPlaylist("<html>no payload</html>", ID), /Could not read the Spotify playlist page/)
  const missing = { props: { pageProps: {} } }
  assert.throws(
    () => parseEmbedPlaylist(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(missing)}</script>`, ID),
    /private, deleted, or not available/,
  )
})

test("search rows use the media id as the video id and read duration from the subtitle", () => {
  const json = {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicShelfRenderer: {
                        contents: [
                          {
                            musicResponsiveListItemRenderer: {
                              playlistItemData: { videoId: "yt-123" },
                              flexColumns: [
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: { runs: [{ text: "Thriller" }] },
                                  },
                                },
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: { runs: [{ text: "Michael Jackson • Thriller • 5:58" }] },
                                  },
                                },
                              ],
                              navigationEndpoint: {
                                watchEndpoint: {
                                  videoId: "yt-123",
                                  watchEndpointMusicSupportedConfigs: {
                                    watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" },
                                  },
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  }

  const page = parseBrowsePage(json, "Songs")
  const item = page.shelves[0]?.items[0]
  assert.ok(item)
  assert.equal(item.id, "yt-123")
  assert.equal(item.duration, 358)
  assert.deepEqual(candidateOf(item), {
    videoId: "yt-123",
    title: "Thriller",
    artists: ["Michael Jackson"],
    album: "Thriller",
    durationSec: 358,
    explicit: null,
    musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
  })
})

test("Pathfinder page parser preserves raw entry count and artwork order", () => {  const page = parsePlaylistPage({
    data: {
      playlistV2: {
        name: "Big Playlist",
        images: { items: [{ sources: [{ width: 64, url: "small" }, { width: 640, url: "big" }] }] },
        content: {
          totalCount: 3,
          items: [
            { itemV2: { data: { __typename: "Episode", name: "Episode" } } },
            {
              itemV2: {
                data: {
                  __typename: "Track",
                  uri: "spotify:track:one",
                  name: "One",
                  artists: { items: [{ profile: { name: "Artist" } }] },
                  albumOfTrack: {
                    name: "Album",
                    coverArt: { sources: [{ width: 300, url: "cover" }] },
                  },
                  trackDuration: { totalMilliseconds: 180_000 },
                  contentRating: { label: "EXPLICIT" },
                },
              },
            },
          ],
        },
      },
    },
  })

  assert.equal(page.rawCount, 2)
  assert.equal(page.totalCount, 3)
  assert.equal(page.skipped, 1)
  assert.equal(page.cover, "big")
  assert.equal(page.tracks.length, 1)
  assert.equal(page.tracks[0].title, "One")
  assert.equal(page.tracks[0].explicit, true)
  assert.equal(page.tracks[0].artworkUrl, "cover")
})

test("Pathfinder pagination advances by raw entries, not filtered tracks", async () => {
  const offsets: number[] = []
  const pages = await readPlaylistPages("id", "token", async (offset) => {
    offsets.push(offset)
    if (offset === 0) {
      return { name: "Big", cover: "c", totalCount: 5, rawCount: 2, skipped: 1, tracks: [track({ title: "A" })] }
    }
    if (offset === 2) {
      return { name: null, cover: null, totalCount: 5, rawCount: 1, skipped: 0, tracks: [track({ title: "B" })] }
    }
    return { name: null, cover: null, totalCount: 5, rawCount: 2, skipped: 0, tracks: [track({ title: "C" }), track({ title: "D" })] }
  })

  assert.deepEqual(offsets, [0, 2, 3])
  assert.equal(pages.totalCount, 5)
  assert.equal(pages.skipped, 1)
  assert.deepEqual(pages.tracks.map((entry) => entry.title), ["A", "B", "C", "D"])
  assert.equal(pages.truncated, false)
})

test("a later Pathfinder page failure keeps the pages already read", async () => {
  const pages = await readPlaylistPages("id", "token", async (offset) => {
    if (offset === 0) {
      return { name: "Big", cover: null, totalCount: 4, rawCount: 2, skipped: 0, tracks: [track({ title: "A" })] }
    }
    throw new Error("page failed")
  })
  assert.equal(pages.tracks.length, 1)
  assert.equal(pages.truncated, true)

  await assert.rejects(
    readPlaylistPages("id", "token", async () => {
      throw new Error("first page failed")
    }),
    /first page failed/,
  )
})

test("the fetchPlaylist hash is extracted from the web-player bundle", () => {
  const hash = "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf"
  const source = `var f=new aQ.l("fetchPlaylist","query","${hash}",null),g=new aQ.l("fetchPlaylistMetadata"`
  assert.equal(extractPlaylistHash(source), hash)
  assert.equal(extractPlaylistHash("nothing here"), null)
})

test("title parsing separates identity, versions and packaging", () => {
  assert.deepEqual(parseTitle('Paniyon Sa (From "Satyamev Jayate")'), {
    core: "paniyonsa",
    versions: [],
    context: ["satyamev", "jayate"],
    searchable: "Paniyon Sa",
  })
  assert.equal(parseTitle("KALYANI (Remix)").core, "kalyani")
  assert.deepEqual(parseTitle("KALYANI (Remix)").versions, ["remix"])
  assert.equal(parseTitle("Song - Official Audio").core, "song")
  assert.equal(parseTitle("My Song").core, "mysong")
  assert.equal(parseTitle("紅蓮華 - Gurenge").core, "gurenge")
  assert.equal(parseTitle("紅蓮華 - Gurenge").searchable, "Gurenge")
})

test("queries prefer title and artist, then a title-only fallback", () => {
  const queries = buildQueries(track({ title: 'Song (From "Film")', artists: ["Artist"] }))
  assert.equal(queries[0], "Song Artist")
  assert.equal(queries[1], "Song")
})

test("exact title, artist, duration and album match", () => {
  const match = rankCandidates(
    track({
      title: "Blinding Lights",
      artists: ["The Weeknd"],
      album: "After Hours",
      durationMs: 200_040,
      explicit: false,
    }),
    [
      candidate({
        videoId: "yt",
        title: "Blinding Lights",
        artists: ["The Weeknd"],
        album: "After Hours",
        durationSec: 200,
        explicit: false,
      }),
    ],
  )
  assert.ok(match)
  assert.equal(match.candidate.videoId, "yt")
  assert.equal(match.score, 220)
})

test("a different artist is rejected unless the runtime is nearly exact", () => {
  assert.equal(
    rankCandidates(track({ title: "Song", artists: ["Artist"], durationMs: 200_000 }), [
      candidate({ title: "Song", artists: ["Someone Else"], durationSec: 180 }),
    ]),
    null,
  )
  assert.equal(
    rankCandidates(track({ title: "Song", artists: ["Composer"], durationMs: 200_000 }), [
      candidate({ title: "Song", artists: ["Singer"], durationSec: 201 }),
    ])?.score,
    110,
  )
})

test("live and studio recordings never stand in for each other", () => {
  assert.equal(
    rankCandidates(track({ title: "Song (Live)" }), [candidate({ title: "Song" })]),
    null,
  )
  assert.equal(
    rankCandidates(track({ title: "Song" }), [candidate({ title: "Song (Live)" })]),
    null,
  )
})

test("matching remixes and ignoring film packaging", () => {
  assert.ok(
    rankCandidates(track({ title: "Song (Remix)" }), [candidate({ title: "Song (Remix)" })]),
  )
  assert.ok(
    rankCandidates(track({ title: 'Song (From "Film")' }), [candidate({ title: "Song" })]),
  )
  assert.equal(
    rankCandidates(track({ title: "Song" }), [candidate({ title: "Song (Re-recorded)" })]),
    null,
  )
})

test("artist-prefixed uploads and kana/romaji titles match", () => {
  assert.ok(
    rankCandidates(track({ title: "Song", artists: ["Artist"] }), [
      candidate({ title: "Artist - Song", artists: [] }),
    ]),
  )
  assert.ok(
    rankCandidates(track({ title: "こいこがれ", artists: ["Ado"] }), [
      candidate({ title: "Koikogare", artists: ["Ado"] }),
    ]),
  )
})

test("duration and explicit gates reject different recordings", () => {
  assert.equal(
    rankCandidates(track({ title: "Song", durationMs: 200_000 }), [candidate({ durationSec: 231 })]),
    null,
  )
  assert.ok(rankCandidates(track({ title: "Song", durationMs: 200_000 }), [candidate({ durationSec: 203 })]))
  assert.equal(
    rankCandidates(track({ title: "Song", explicit: true }), [candidate({ explicit: false })]),
    null,
  )
})

test("matchTrack uses search queries and never invents a match", async () => {
  assert.equal(await matchTrack(track({ title: "Song" }), async () => []), null)

  const queries: string[] = []
  const match = await matchTrack(track({ title: "Song", artists: ["Artist"] }), async (query) => {
    queries.push(query)
    if (queries.length === 1) return [candidate({ title: "Song", artists: ["Cover Band"], durationSec: 210 })]
    return [candidate({ videoId: "right", title: "Song", artists: ["Artist"] })]
  })
  assert.ok(match)
  assert.equal(match.candidate.videoId, "right")
  assert.deepEqual(queries, ["Song Artist", "Song"])
})
