import crypto from "crypto";
import { Video } from "../collectors/types";
import { hammingDistance } from "./visual";
import { env } from "../lib/env";

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#][\w_]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensFor(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 2);
}

function hashToken(token: string): bigint {
  const digest = crypto.createHash("sha256").update(token).digest();
  return digest.readBigUInt64BE(0);
}

export function simHash(text: string): string {
  const tokens = tokensFor(text);
  if (tokens.length === 0) return "";

  const vector = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = hashToken(token);
    for (let bit = 0; bit < 64; bit++) {
      const mask = 1n << BigInt(bit);
      vector[bit] += (hash & mask) === 0n ? -1 : 1;
    }
  }

  return vector.map((weight) => (weight >= 0 ? "1" : "0")).join("");
}

function creativeKey(video: Video): string {
  const author = (video.author ?? "").toLowerCase().trim();
  const caption = normalizeText(video.caption ?? "").slice(0, 160);
  return `${video.platform}:${author}:${caption}`;
}

export function dedupTextual(videos: Video[], maxDistance = 4): Video[] {
  if (env.USE_FIXTURES) return videos;

  const uniqueVideos: Video[] = [];
  const seenCreativeKeys = new Set<string>();

  for (const video of videos) {
    const key = creativeKey(video);
    if (video.platform === "meta" && seenCreativeKeys.has(key)) {
      continue;
    }
    seenCreativeKeys.add(key);

    if (!video.captionSimhash) {
      video.captionSimhash = simHash(video.caption ?? "");
    }

    let isDuplicate = false;
    for (const unique of uniqueVideos) {
      if (!video.captionSimhash || !unique.captionSimhash) continue;
      if (hammingDistance(video.captionSimhash, unique.captionSimhash) <= maxDistance) {
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
