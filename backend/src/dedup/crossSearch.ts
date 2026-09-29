import { Video } from "../collectors/types";

export function filterPreviouslySeen(
  videos: Video[],
  seenIds: Set<string>,
  showSeen = false
): Video[] {
  if (showSeen) return videos;
  return videos.filter((video) => !seenIds.has(`${video.platform}:${video.platformId}`));
}
