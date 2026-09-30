import axios from "axios";
import sharp from "sharp";
import { cosineSimilarity } from "../brain/imageBrain";
import { Video } from "../collectors/types";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const HASH_SIZE = 8;
const HASH_TIMEOUT_MS = 4000;
const HASH_CONCURRENCY = 8;

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
    timeout: HASH_TIMEOUT_MS,
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
    video.thumbPHash = await withTimeout(computeAverageHash(video.thumbnailUrl), HASH_TIMEOUT_MS, "");
  } catch (err) {
    logger.warn(
      {
        platform: video.platform,
        platformId: video.platformId,
        thumbnailHost: safeHost(video.thumbnailUrl),
        err: err instanceof Error ? err.message : String(err),
      },
      "Visual dedup thumbnail hash failed"
    );
    video.thumbPHash = "";
  }
  return video.thumbPHash ?? "";
}

function safeHost(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

async function precomputeThumbHashes(videos: Video[]): Promise<void> {
  for (let i = 0; i < videos.length; i += HASH_CONCURRENCY) {
    const batch = videos.slice(i, i + HASH_CONCURRENCY);
    await Promise.all(batch.map((video) => ensureThumbHash(video)));
    logger.info(
      {
        done: Math.min(i + batch.length, videos.length),
        total: videos.length,
      },
      "Visual dedup thumbnail hash progress"
    );
  }
}

export async function dedupVisual(
  videos: Video[],
  opts: { pHashDistance?: number; clipThreshold?: number } = {}
): Promise<Video[]> {
  if (env.USE_FIXTURES) return videos;

  const pHashDistance = opts.pHashDistance ?? 6;
  const clipThreshold = opts.clipThreshold ?? 0.95;
  const uniqueVideos: Video[] = [];

  logger.info({ videos: videos.length }, "Visual dedup started");
  await precomputeThumbHashes(videos);

  for (const video of videos) {
    const hash = video.thumbPHash ?? "";
    let isDuplicate = false;

    for (const unique of uniqueVideos) {
      const uniqueHash = unique.thumbPHash ?? "";
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
