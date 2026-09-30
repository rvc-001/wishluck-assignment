import { Video } from "../collectors/types";
import { sha256 } from "../lib/utils";

/**
 * L1 — Exact Deduplication
 * Eliminates duplicates based on platform video ID or SHA-256 of media URL.
 */
export function dedupExact(videos: Video[]): Video[] {
  const seenIds = new Set<string>();
  const seenProviderMediaIds = new Set<string>();
  const seenUrlHashes = new Set<string>();
  const uniqueVideos: Video[] = [];

  for (const video of videos) {
    const idKey = `${video.platform}:${video.platformId}`;
    const providerMediaKey = video.providerMediaId ? `${video.platform}:${video.providerMediaId}` : "";
    const urlHash = sha256(video.url);
    video.urlHash = urlHash; // Save for database storage

    if (
      seenIds.has(idKey) ||
      (providerMediaKey && seenProviderMediaIds.has(providerMediaKey)) ||
      seenUrlHashes.has(urlHash)
    ) {
      continue;
    }

    seenIds.add(idKey);
    if (providerMediaKey) seenProviderMediaIds.add(providerMediaKey);
    seenUrlHashes.add(urlHash);
    uniqueVideos.push(video);
  }

  return uniqueVideos;
}
