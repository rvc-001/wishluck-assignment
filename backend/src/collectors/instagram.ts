/**
 * Instagram Reels Collector (Phase 3A)
 * Uses Apify's instagram-reel-scraper actor behind the Collector interface.
 * In USE_FIXTURES=true mode, returns saved fixture data without live API calls.
 */

import axios from "axios";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import {
  Collector,
  CollectorOptions,
  CollectorResult,
  Video,
  makeSeenKey,
} from "./types";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { withRetry, sleep } from "../lib/utils";

// Rate limit compliance: Apify Instagram scraper — max 50 results/run recommended
// https://apify.com/apify/instagram-reel-scraper

const APIFY_BASE_URL = "https://api.apify.com/v2";
const ACTOR_ID = "apify~instagram-scraper";

interface ApifyRawItem {
  error?: string;
  errorDescription?: string;
  id?: string;
  platformId?: string;
  shortCode?: string;
  shortcode?: string;
  code?: string;
  url?: string;
  displayUrl?: string;
  thumbnail?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  videoThumbnail?: string;
  videoUrl?: string;
  type?: string;
  productType?: string;
  caption?: string | { text?: string };
  likesCount?: number;
  likes?: number;
  videoViewCount?: number;
  views?: number;
  ownerUsername?: string;
  author?: string;
  owner?: { username?: string };
  timestamp?: string;
  takenAtIso?: string;
}

function normalizeTag(query: string): string {
  return query.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function fixtureScope(queries: string[]): string {
  return normalizeTag(queries[0] ?? "fixture") || "fixture";
}

function normalizeApifyItem(raw: ApifyRawItem): Video | null {
  if (raw.error || raw.errorDescription) return null;
  const platformId = raw.shortCode ?? raw.shortcode ?? raw.code ?? raw.platformId ?? raw.id ?? "";
  if (!platformId) return null;
  const caption =
    typeof raw.caption === "string" ? raw.caption : raw.caption?.text ?? "";
  const author = raw.ownerUsername ?? raw.owner?.username ?? raw.author?.replace(/^@/, "");
  const thumbnailUrl = raw.displayUrl ?? raw.thumbnailUrl ?? raw.thumbnail ?? raw.imageUrl ?? raw.videoThumbnail ?? "";
  const url = raw.url ?? `https://www.instagram.com/reel/${platformId}/`;

  return {
    id: uuidv4(),
    platform: "instagram",
    platformId,
    url,
    thumbnailUrl,
    caption,
    author: author ? `@${author}` : undefined,
    likes: raw.likesCount ?? raw.likes,
    views: raw.videoViewCount ?? raw.views,
    createdAt: raw.timestamp ?? raw.takenAtIso,
  };
}

function expandFixtureVideos(videos: Video[], target: number): Video[] {
  if (videos.length === 0) return videos;
  const expanded: Video[] = [];
  for (let i = 0; expanded.length < target; i++) {
    const base = videos[i % videos.length];
    const suffix = i + 1;
    const uniqueTerms = `uniquefixture${suffix} angle${suffix} scene${suffix} creator${suffix} proof${suffix} match${suffix} style${suffix} product${suffix}`;
    expanded.push({
      ...base,
      id: uuidv4(),
      platformId: `${base.platformId}-fixture-${suffix}`,
      url: `${base.url.replace(/\/$/, "")}?fixture=${suffix}`,
      thumbnailUrl: base.thumbnailUrl.replace(/seed\/([^/]+)/, `seed/$1-${suffix}`),
      caption: uniqueTerms,
    });
  }
  return expanded;
}

export class InstagramCollector implements Collector {
  async collect(
    queries: string[],
    opts: CollectorOptions
  ): Promise<CollectorResult> {
    const start = Date.now();
    const triedQueries: string[] = [];
    const triedTags = new Set<string>();
    const videos: Video[] = [];
    const localSeen = new Set(opts.seenIds);

    // 0.9 — Fixture mode
    if (env.USE_FIXTURES) {
      logger.info("Instagram collector: USE_FIXTURES=true, loading fixture data");
      const fixturePath = path.resolve(
        __dirname,
        "../../fixtures/instagram-sample.json"
      );
      const raw: ApifyRawItem[] = JSON.parse(
        fs.readFileSync(fixturePath, "utf-8")
      );
      const normalized = raw
        .map(normalizeApifyItem)
        .filter((v): v is Video => v !== null);
      const scope = fixtureScope(queries);
      const expanded = expandFixtureVideos(normalized, opts.target).map((video) => ({
        ...video,
        platformId: `${scope}-${video.platformId}`,
        url: `${video.url}&scope=${scope}`,
      }));
      return {
        videos: expanded,
        stats: {
          got: expanded.length,
          wanted: opts.target,
          triedQueries: ["fixture"],
          metaPath: undefined,
        },
      };
    }

    if (!env.APIFY_API_TOKEN) {
      logger.warn("APIFY_API_TOKEN not set — Instagram collector returning empty");
      return {
        videos: [],
        stats: { got: 0, wanted: opts.target, triedQueries: [] },
      };
    }

    // 3A.3 — Paginate through queries until target is met
    for (const query of queries) {
      const tag = normalizeTag(query);
      if (!tag || triedTags.has(tag)) continue;
      triedTags.add(tag);

      if (
        videos.length >= opts.target ||
        Date.now() - start >= opts.timeBudgetMs
      ) {
        break;
      }

      triedQueries.push(tag);
      logger.info({ query, tag }, "Instagram: collecting reel for query");

      try {
        const batch = await withRetry(
          () => this.runApifyActor(tag, opts.target - videos.length),
          { maxAttempts: 3, baseDelay: 2000 }
        );

        for (const item of batch) {
          // 3A.4 — In-flight dedup
          const key = makeSeenKey("instagram", item.platformId);
          if (localSeen.has(key)) continue;
          localSeen.add(key);
          videos.push(item);
        }
      } catch (err) {
        logger.error({ err, query }, "Instagram collector: query failed");
      }

      if (videos.length < opts.target) {
        await sleep(1000); // be polite between queries
      }
    }

    // 3A.5 — Always return stats
    return {
      videos,
      stats: {
        got: videos.length,
        wanted: opts.target,
        triedQueries,
      },
    };
  }

  private async runApifyActor(
    hashtag: string,
    maxItems: number
  ): Promise<Video[]> {
    // Normalize hashtag — strip # if present
    const tag = normalizeTag(hashtag);
    if (!tag) return [];

    // Start actor run
    const runResp = await axios.post(
      `${APIFY_BASE_URL}/acts/${ACTOR_ID}/runs`,
      {
        directUrls: [`https://www.instagram.com/explore/tags/${tag}/`],
        resultsType: "posts",
        resultsLimit: Math.min(maxItems, 50),
        searchLimit: 1,
      },
      {
        headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
        timeout: 30000,
      }
    );

    const runId: string = runResp.data.data.id;
    logger.info({ runId, tag }, "Apify Instagram actor started");

    // Poll until finished (max 90s)
    let status = "RUNNING";
    let attempts = 0;
    while (status === "RUNNING" && attempts < 30) {
      await sleep(3000);
      const statusResp = await axios.get(
        `${APIFY_BASE_URL}/actor-runs/${runId}`,
        { headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` } }
      );
      status = statusResp.data.data.status;
      attempts++;
    }

    if (status !== "SUCCEEDED") {
      throw new Error(`Apify actor run ${runId} finished with status: ${status}`);
    }

    // Fetch results
    const datasetResp = await axios.get(
      `${APIFY_BASE_URL}/actor-runs/${runId}/dataset/items`,
      {
        headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
        params: { clean: true, limit: maxItems },
      }
    );

    const items: ApifyRawItem[] = datasetResp.data;
    return items
      .map(normalizeApifyItem)
      .filter((v): v is Video => v !== null);
  }
}
