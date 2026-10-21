import { innertube } from "./innertube.ts"
import { getScope } from "./auth.ts"
import type { Rating } from "../../shared/types.ts"

/** Writes are live account operations and must be signed in. Check the body (DOC §11.1). */
export async function rate(videoId: string, rating: Rating): Promise<void> {
  if (!getScope()) throw new Error("Sign in to like songs")
  const endpoint = rating === "like" ? "like/like" : rating === "dislike" ? "like/dislike" : "like/removelike"
  const response: any = await innertube(endpoint, { target: { videoId } })
  if (response?.error) throw new Error(response.error.message ?? "YouTube refused the rating")
}

function requireScope(): void {
  if (!getScope()) throw new Error("Sign in to edit your library")
}

/** Browse IDs carry a VL prefix; playlist write endpoints want the bare ID. */
function playlistId(id: string): string {
  return id.replace(/^VL/, "")
}

export async function createPlaylist(title: string, videoId?: string): Promise<string> {
  requireScope()
  const response: any = await innertube("playlist/create", { title, privacyStatus: "PRIVATE" })
  if (response?.error) throw new Error(response.error.message ?? "Could not create playlist")
  const id = response?.playlistId
  if (!id) throw new Error("YouTube returned no playlist ID")
  if (videoId) await addToPlaylist(id, videoId)
  return id
}

export async function addToPlaylist(playlist: string, videoId: string): Promise<void> {
  await addToPlaylistBatch(playlist, [videoId])
}

/** Append several videos in one request. Action order is preserved by YouTube. */
export async function addToPlaylistBatch(playlist: string, videoIds: string[]): Promise<void> {
  requireScope()
  if (!videoIds.length) return
  const response: any = await innertube("browse/edit_playlist", {
    playlistId: playlistId(playlist),
    actions: videoIds.map((videoId) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: videoId })),
  })
  if (response?.error) throw new Error(response.error.message ?? "Could not add to playlist")
}

export async function deletePlaylist(playlist: string): Promise<void> {
  requireScope()
  const response: any = await innertube("playlist/delete", { playlistId: playlistId(playlist) })
  if (response?.error) throw new Error(response.error.message ?? "Could not delete playlist")
}

export async function subscribe(channelId: string, subscribed: boolean, params?: string | null): Promise<void> {
  requireScope()
  const response: any = await innertube(subscribed ? "subscription/unsubscribe" : "subscription/subscribe", {
    channelIds: [channelId],
    ...(!subscribed && params ? { params } : {}),
  })
  if (response?.error) throw new Error(response.error.message ?? "Could not update subscription")
}
