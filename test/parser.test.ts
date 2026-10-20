import { test } from "node:test"
import assert from "node:assert/strict"
import { parseQueueTracks } from "../src/main/youtube/parser.ts"

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
