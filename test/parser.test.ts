import { test } from "node:test"
import assert from "node:assert/strict"
import { appendBrowseItems, parseBrowseFeed, parseQueueTracks, sizedThumbnail } from "../src/main/youtube/parser.ts"

test("thumbnails are resized to the requested display size", () => {
  assert.equal(
    sizedThumbnail("https://lh3.googleusercontent.com/abc=w1080-h1080-l90-rj", 320),
    "https://lh3.googleusercontent.com/abc=w320-h320-l90-rj",
  )
  assert.equal(
    sizedThumbnail("https://yt3.ggpht.com/abc=s544-c-k-c0x00ffffff-no-rj", 544),
    "https://yt3.ggpht.com/abc=s544-c-k-c0x00ffffff-no-rj",
  )
  assert.equal(
    sizedThumbnail("https://yt3.ggpht.com/abc=s900", 544),
    "https://yt3.ggpht.com/abc=s544",
  )
  assert.equal(sizedThumbnail(null, 320), null)
  assert.equal(
    sizedThumbnail("https://i.ytimg.com/vi/abc/hqdefault.jpg", 320),
    "https://i.ytimg.com/vi/abc/hqdefault.jpg",
  )
})

test("radio parser skips official music videos", () => {
  const json = {
    contents: {
      singleColumnMusicWatchNextResultsRenderer: {
        tabbedRenderer: {
          watchNextTabbedResultsRenderer: {
            tabs: [
              {
                tabRenderer: {
                  content: {
                    musicQueueRenderer: {
                      content: {
                        playlistPanelRenderer: {
                          contents: [
                            {
                              playlistPanelVideoRenderer: {
                                videoId: "audio",
                                title: { runs: [{ text: "Audio Track" }] },
                                longBylineText: { runs: [{ text: "Artist" }] },
                                lengthText: { runs: [{ text: "3:00" }] },
                                navigationEndpoint: {
                                  watchEndpoint: {
                                    videoId: "audio",
                                    watchEndpointMusicSupportedConfigs: {
                                      watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" },
                                    },
                                  },
                                },
                              },
                            },
                            {
                              playlistPanelVideoRenderer: {
                                videoId: "video",
                                title: { runs: [{ text: "Video Track" }] },
                                longBylineText: { runs: [{ text: "Artist" }] },
                                lengthText: { runs: [{ text: "3:00" }] },
                                navigationEndpoint: {
                                  watchEndpoint: {
                                    videoId: "video",
                                    watchEndpointMusicSupportedConfigs: {
                                      watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_OMV" },
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  }

  const tracks = parseQueueTracks(json)
  assert.deepEqual(tracks.map((track) => track.videoId), ["audio"])
})

function playlistItem(videoId: string, title: string) {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Artist" }] } } },
      ],
    },
  }
}

function continuationItem(token: string) {
  return {
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token } },
    },
  }
}

test("playlist pages follow the track list continuation", () => {
  const first = {
    header: { musicEditablePlaylistDetailHeaderRenderer: { title: { simpleText: "Long playlist" } } },
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicPlaylistShelfRenderer: {
                        contents: [
                          playlistItem("one", "One"),
                          playlistItem("two", "Two"),
                          continuationItem("page-2"),
                        ],
                      },
                    },
                    {
                      musicCarouselShelfRenderer: {
                        contents: [playlistItem("related", "Related")],
                        continuations: [
                          {
                            nextContinuationData: {
                              continuation: "carousel-page",
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

  const feed = parseBrowseFeed(first, "VLPL-long")
  assert.equal(feed.page.title, "Long playlist")
  assert.equal(feed.continuation, "page-2")
  assert.deepEqual(feed.page.shelves[0].items.map((item) => item.id), ["one", "two"])

  // Real playlist chunks come back as append actions, not continuation shelves.
  const second = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [playlistItem("three", "Three"), continuationItem("page-3")],
        },
      },
    ],
  }
  const chunk = parseBrowseFeed(second, "VLPL-long")
  assert.equal(chunk.continuation, "page-3")
  appendBrowseItems(feed.page, chunk.page.shelves.flatMap((shelf) => shelf.items), feed.trackListIndex)
  assert.deepEqual(feed.page.shelves[0].items.map((item) => item.id), ["one", "two", "three"])

  const last = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [playlistItem("four", "Four")],
        },
      },
    ],
  }
  const finalChunk = parseBrowseFeed(last, "VLPL-long")
  assert.equal(finalChunk.continuation, null)
  appendBrowseItems(feed.page, finalChunk.page.shelves.flatMap((shelf) => shelf.items), feed.trackListIndex)
  assert.deepEqual(feed.page.shelves[0].items.map((item) => item.id), ["one", "two", "three", "four"])
})

test("carousel continuations are not followed when the track list is complete", () => {
  const json = {
    contents: {
      musicShelfRenderer: {
        contents: [playlistItem("one", "One")],
      },
      musicCarouselShelfRenderer: {
        contents: [playlistItem("related", "Related")],
        continuations: [{ nextContinuationData: { continuation: "carousel-page" } }],
      },
    },
  }

  const feed = parseBrowseFeed(json, "MPREb-album")
  assert.equal(feed.page.shelves.length, 2)
  assert.equal(feed.continuation, null)
})

test("continuation chunks skip items that overlap the previous page", () => {
  const page = {
    title: "",
    shelves: [
      {
        title: "",
        items: [
          { kind: "track" as const, id: "one", title: "One", subtitle: "", thumbnail: null },
          { kind: "track" as const, id: "two", title: "Two", subtitle: "", thumbnail: null },
        ],
      },
    ],
  }

  appendBrowseItems(page, [
    { kind: "track", id: "two", title: "Two", subtitle: "", thumbnail: null },
    { kind: "track", id: "three", title: "Three", subtitle: "", thumbnail: null },
  ])

  assert.deepEqual(page.shelves[0].items.map((item) => item.id), ["one", "two", "three"])
})
