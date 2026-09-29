import axios from "axios";
import sharp from "sharp";
import { cosineSimilarity } from "../brain/imageBrain";
import { Video } from "../collectors/types";
import { env } from "../lib/env";

const HASH_SIZE = 8;

export function hammingDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

export async function computeAverageHash(thumbnailUrl: string): Promise<string> {
  if (!thumbnailUrl) return "";
  const resp = await axios.get<ArrayBuffer>(thumbnailUrl, {
    responseType: "arraybuffer",
    timeout: 10000,
    maxContentLength: 5 * 1024 * 1024,
  });

  const pixels = await sharp(Buffer.from(resp.data))
    .resize(HASH_SIZE, HASH_SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  const values = Array.from(pixels);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => (value >= average ? "1" : "0")).join("");
}

async function ensureThumbHash(video: Video): Promise<string> {
  if (video.thumbPHash) return video.thumbPHash;
  try {
    video.thumbPHash = await computeAverageHash(video.thumbnailUrl);
  } catch {
    video.thumbPHash = "";
  }
  return video.thumbPHash ?? "";
}

export async function dedupVisual(
  videos: Video[],
  opts: { pHashDistance?: number; clipThreshold?: number } = {}
): Promise<Video[]> {
  if (env.USE_FIXTURES) return videos;

  const pHashDistance = opts.pHashDistance ?? 6;
  const clipThreshold = opts.clipThreshold ?? 0.95;
  const uniqueVideos: Video[] = [];

  for (const video of videos) {
    const hash = await ensureThumbHash(video);
    let isDuplicate = false;

    for (const unique of uniqueVideos) {
      const uniqueHash = await ensureThumbHash(unique);
      if (hash && uniqueHash && hammingDistance(hash, uniqueHash) <= pHashDistance) {
        isDuplicate = true;
        break;
      }

      if (
        video.embedding &&
        unique.embedding &&
        video.embedding.length > 0 &&
        unique.embedding.length > 0 &&
        cosineSimilarity(video.embedding, unique.embedding) > clipThreshold
      ) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      uniqueVideos.push(video);
    }
  }

  return uniqueVideos;
}
