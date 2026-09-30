/**
 * Instagram Reels Collector.
 * The Apify actor is treated as a provider adapter: raw rows are normalized here,
 * then shared eligibility decides whether a row is a usable no-detected-paid-marker Reel.
 */

import axios from "axios";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { Collector, CollectorOptions, CollectorResult, Video, makeSeenKey } from "./types";
import {
  NormalizedProviderItem,
  evaluateOrganicReel,
  hashtagsFor,
  incrementDrop,
  underCreatorCap,
} from "./organicEligibility";
import { firstUsableCount, CANONICAL_VIEW_FIELDS, LIKE_FIELDS } from "../engagement/reels";
import {
  ProviderRunBudget,
  createProviderRunBudget,
  readProviderCache,
  tryConsumeProviderRun,
  writeProviderCache,
} from "./providerRuntime";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { withRetry, sleep } from "../lib/utils";

const APIFY_BASE_URL = "https://api.apify.com/v2";
const ACTOR_ID = "apify~instagram-scraper";
const APIFY_USAGE_LIMIT_REASON = "apify_monthly_usage_hard_limit";
const APIFY_PROVIDER_AUTH_REASON = "apify_provider_auth";

export interface ApifyRawItem {
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
  product_type?: string;
  mediaType?: string;
  __typename?: string;
  isPaidPartnership?: boolean;
  paidPartnership?: boolean;
  sponsorship?: unknown;
  caption?: string | { text?: string };
  hashtags?: string[];
  likesCount?: unknown;
  likes?: unknown;
  videoViewCount?: unknown;
  videoPlayCount?: unknown;
  playCount?: unknown;
  views?: unknown;
  ownerUsername?: string;
  author?: string;
  ownerId?: string;
  owner?: { username?: string; id?: string };
  timestamp?: string;
  takenAtIso?: string;
}

function apifyBlockedReason(err: unknown): string | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const status = err.response?.status;
  const type = (err.response?.data as { error?: { type?: string } } | undefined)?.error?.type;
  if (type === "platform-feature-disabled") return APIFY_USAGE_LIMIT_REASON;
  if (status === 402 || type === "not-enough-usage-to-run-paid-actor") return APIFY_USAGE_LIMIT_REASON;
  if (status === 401 || status === 403) return APIFY_PROVIDER_AUTH_REASON;
  return undefined;
}

function sanitizedProviderError(err: unknown): Record<string, unknown> {
  if (!axios.isAxiosError(err)) {
    return {
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const data = err.response?.data as { error?: { type?: string; message?: string } } | undefined;
  return {
    message: data?.error?.message ?? err.message,
    status: err.response?.status,
    type: data?.error?.type,
    url: err.config?.url,
    method: err.config?.method,
  };
}

function normalizeTag(query: string): string {
  return query.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function fixtureScope(queries: string[]): string {
  return normalizeTag(queries[0] ?? "fixture") || "fixture";
}

function inferContentType(raw: ApifyRawItem, url: string): Video["contentType"] {
  const productType = (raw.productType ?? raw.product_type ?? "").toLowerCase();
  const type = (raw.type ?? raw.mediaType ?? raw.__typename ?? "").toLowerCase();
  if (["clips", "reel", "reels"].includes(productType) || url.includes("/reel/")) return "reel";
  if (type.includes("sidecar") || type.includes("carousel") || productType.includes("carousel")) return "carousel";
  if (type.includes("image") || productType.includes("feed_photo")) return "image";
  if (type.includes("video") || productType.includes("video")) return "video";
  return "unknown";
}

export function normalizeApifyInstagramItem(raw: ApifyRawItem, paginationDepth = 0): NormalizedProviderItem | null {
  if (raw.error || raw.errorDescription) return null;
  const platformId = raw.shortCode ?? raw.shortcode ?? raw.code ?? raw.platformId ?? raw.id ?? "";
  if (!platformId) return null;

  const caption = typeof raw.caption === "string" ? raw.caption : raw.caption?.text ?? "";
  const author = raw.ownerUsername ?? raw.owner?.username ?? raw.author?.replace(/^@/, "");
  const thumbnailUrl = raw.displayUrl ?? raw.thumbnailUrl ?? raw.thumbnail ?? raw.imageUrl ?? raw.videoThumbnail ?? "";
  const url = raw.url ?? `https://www.instagram.com/reel/${platformId}/`;

  return {
    id: raw.id ?? platformId,
    platformId,
    providerMediaId: raw.id ?? platformId,
    providerCreatorId: raw.ownerId ?? raw.owner?.id ?? author,
    creatorHandle: author ? `@${author.replace(/^@/, "")}` : undefined,
    url,
    thumbnailUrl,
    caption,
    hashtags: hashtagsFor(caption, raw.hashtags ?? []),
    contentType: inferContentType(raw, url),
    productType: raw.productType ?? raw.product_type,
    paidPartnershipFlag: Boolean(raw.isPaidPartnership || raw.paidPartnership || raw.sponsorship),
    likes: firstUsableCount(raw as Record<string, unknown>, LIKE_FIELDS),
    views: firstUsableCount(raw as Record<string, unknown>, CANONICAL_VIEW_FIELDS),
    createdAt: raw.timestamp ?? raw.takenAtIso,
    paginationDepth,
  };
}

export function apifyInstagramCanary(raw: ApifyRawItem): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!(raw.shortCode ?? raw.shortcode ?? raw.code ?? raw.platformId ?? raw.id)) missing.push("platformId");
  if (!(raw.url ?? raw.productType ?? raw.product_type ?? raw.type ?? raw.mediaType ?? raw.__typename)) {
    missing.push("content identity");
  }
  if (!(raw.ownerUsername ?? raw.owner?.username ?? raw.author)) missing.push("creator");
  return { ok: missing.length === 0, missing };
}

function videoFromEligibleItem(item: NormalizedProviderItem, paidMarkerDetected?: string): Video {
  return {
    id: uuidv4(),
    platform: "instagram",
    platformId: item.platformId,
    providerMediaId: item.providerMediaId,
    providerCreatorId: item.providerCreatorId,
    url: item.url,
    thumbnailUrl: item.thumbnailUrl,
    caption: item.caption,
    author: item.creatorHandle,
    creatorHandle: item.creatorHandle,
    likes: item.likes,
    views: item.views,
    contentType: "reel",
    sourceKind: "organic",
    isPaidPartnership: false,
    paidMarkerDetected,
    createdAt: item.createdAt,
    engagementFetchedAt: item.views !== undefined || item.likes !== undefined ? new Date().toISOString() : undefined,
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
      providerMediaId: `${base.providerMediaId ?? base.platformId}-fixture-${suffix}`,
      url: `${base.url.replace(/\/$/, "")}?fixture=${suffix}`,
      thumbnailUrl: base.thumbnailUrl.replace(/seed\/([^/]+)/, `seed/$1-${suffix}`),
      caption: uniqueTerms,
    });
  }
  return expanded;
}

export class InstagramCollector implements Collector {
  private budget: ProviderRunBudget;

  constructor() {
    this.budget = createProviderRunBudget("apify:instagram");
  }

  async collect(queries: string[], opts: CollectorOptions): Promise<CollectorResult> {
    const start = Date.now();
    const triedQueries: string[] = [];
    const triedTags = new Set<string>();
    const videos: Video[] = [];
    const localSeen = new Set(opts.seenIds);
    const creatorCounts = new Map<string, number>();
    const dropReasons: Record<string, number> = {};
    let cacheHits = 0;
    let liveRuns = 0;

    if (env.USE_FIXTURES) {
      logger.info("Instagram collector: USE_FIXTURES=true, loading fixture data");
      const fixturePath = path.resolve(__dirname, "../../fixtures/instagram-sample.json");
      const raw: ApifyRawItem[] = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      const normalized = raw
        .map((item) => normalizeApifyInstagramItem(item))
        .filter((item): item is NormalizedProviderItem => item !== null)
        .map((item) => {
          const result = evaluateOrganicReel(item);
          if (!result.item) {
            incrementDrop(dropReasons, result.dropReason);
            return null;
          }
          return videoFromEligibleItem(result.item, result.paidMarkerDetected);
        })
        .filter((video): video is Video => video !== null);
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
          targetResults: opts.target,
          status: expanded.length >= opts.target ? "complete" : "partial",
          sourceKinds: { instagram: "organic" },
          dropReasons,
          cacheHits: 0,
          liveRuns: 0,
        },
      };
    }

    if (!env.APIFY_API_TOKEN) {
      logger.warn("APIFY_API_TOKEN not set - Instagram collector returning empty");
      return {
        videos: [],
        stats: {
          got: 0,
          wanted: opts.target,
          triedQueries: [],
          status: "partial",
          targetResults: opts.target,
          sourceKinds: { instagram: "organic" },
          dropReasons: { missing_provider_token: 1 },
        },
      };
    }

    for (const query of queries) {
      const tag = normalizeTag(query);
      if (!tag || triedTags.has(tag)) continue;
      triedTags.add(tag);

      if (videos.length >= opts.target || Date.now() - start >= opts.timeBudgetMs) break;

      triedQueries.push(tag);
      logger.info({ query, tag }, "Instagram: collecting organic reel candidates");

      try {
        for (let depth = 0; depth < Math.max(1, env.MAX_REFILL_ROUNDS) && videos.length < opts.target; depth++) {
          const { items, fromCache, liveRun, blockedReason } = await withRetry(
            () => this.fetchNormalizedItems(tag, opts.target - videos.length, depth),
            { maxAttempts: 3, baseDelay: 2000 }
          );
          if (fromCache) cacheHits++;
          if (liveRun) liveRuns++;
          if (blockedReason) {
            incrementDrop(dropReasons, blockedReason);
            return {
              videos,
              stats: {
                got: videos.length,
                wanted: opts.target,
                triedQueries,
                status: "partial",
                targetResults: opts.target,
                sourceKinds: { instagram: "organic" },
                dropReasons,
                cacheHits,
                liveRuns,
              },
            };
          }

          let acceptedThisDepth = 0;
          for (const item of items) {
            const eligibility = evaluateOrganicReel(item);
            if (!eligibility.item) {
              incrementDrop(dropReasons, eligibility.dropReason);
              continue;
            }

            const video = videoFromEligibleItem(eligibility.item, eligibility.paidMarkerDetected);
            const key = makeSeenKey("instagram", video.platformId);
            if (localSeen.has(key)) continue;
            if (!underCreatorCap(eligibility.item, creatorCounts, env.PER_CREATOR_CAP)) {
              incrementDrop(dropReasons, "creator_cap");
              continue;
            }
            localSeen.add(key);
            videos.push(video);
            acceptedThisDepth++;
            if (videos.length >= opts.target) break;
          }

          if (!fromCache && acceptedThisDepth < env.MIN_REFILL_YIELD) break;
        }
      } catch (err) {
        const blockedReason = apifyBlockedReason(err);
        if (blockedReason) {
          logger.warn({ err: sanitizedProviderError(err), query, blockedReason }, "Instagram collector: provider blocked run");
          incrementDrop(dropReasons, blockedReason);
          break;
        }

        logger.error({ err: sanitizedProviderError(err), query }, "Instagram collector: query failed");
        incrementDrop(dropReasons, "provider_error");
      }

      if (videos.length < opts.target) {
        await sleep(1000);
      }
    }

    return {
      videos,
      stats: {
        got: videos.length,
        wanted: opts.target,
        triedQueries,
        status: videos.length >= opts.target ? "complete" : "partial",
        targetResults: opts.target,
        sourceKinds: { instagram: "organic" },
        dropReasons,
        cacheHits,
        liveRuns,
      },
    };
  }

  private async fetchNormalizedItems(
    hashtag: string,
    maxItems: number,
    paginationDepth: number
  ): Promise<{ items: NormalizedProviderItem[]; fromCache: boolean; liveRun: boolean; blockedReason?: string }> {
    const tag = normalizeTag(hashtag);
    if (!tag) return { items: [], fromCache: false, liveRun: false };

    const cacheKey = JSON.stringify({
      provider: "apify:instagram",
      tag,
      paginationDepth,
      maxItems: Math.min(maxItems, 50),
      resultsType: "reels",
    });
    const cached = readProviderCache<ApifyRawItem[]>(cacheKey);
    if (cached) {
      return {
        items: cached
          .map((item) => normalizeApifyInstagramItem(item, paginationDepth))
          .filter((item): item is NormalizedProviderItem => item !== null),
        fromCache: true,
        liveRun: false,
      };
    }

    const consumed = tryConsumeProviderRun(this.budget);
    if (!consumed.ok) {
      return { items: [], fromCache: false, liveRun: false, blockedReason: consumed.reason };
    }

    let runResp;
    try {
      runResp = await axios.post(
        `${APIFY_BASE_URL}/acts/${ACTOR_ID}/runs`,
        {
          directUrls: [`https://www.instagram.com/explore/tags/${tag}/`],
          resultsType: "reels",
          resultsLimit: Math.min(maxItems, 50),
          searchLimit: Math.max(1, paginationDepth + 1),
        },
        {
          headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
          timeout: 30000,
        }
      );
    } catch (err) {
      const blockedReason = apifyBlockedReason(err);
      if (blockedReason) {
        logger.warn({ err: sanitizedProviderError(err), tag, blockedReason }, "Instagram collector: actor run could not start");
        return { items: [], fromCache: false, liveRun: false, blockedReason };
      }
      throw err;
    }

    const runId: string = runResp.data.data.id;
    logger.info({ runId, tag, paginationDepth }, "Apify Instagram actor started");

    let status = "RUNNING";
    let attempts = 0;
    while (status === "RUNNING" && attempts < 30) {
      await sleep(3000);
      const statusResp = await axios.get(`${APIFY_BASE_URL}/actor-runs/${runId}`, {
        headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
      });
      status = statusResp.data.data.status;
      attempts++;
    }

    if (status !== "SUCCEEDED") {
      throw new Error(`Apify actor run ${runId} finished with status: ${status}`);
    }

    const datasetResp = await axios.get(`${APIFY_BASE_URL}/actor-runs/${runId}/dataset/items`, {
      headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
      params: { clean: true, limit: maxItems },
    });

    const items: ApifyRawItem[] = datasetResp.data;
    writeProviderCache(cacheKey, items);
    return {
      items: items
        .map((item) => normalizeApifyInstagramItem(item, paginationDepth))
        .filter((item): item is NormalizedProviderItem => item !== null),
      fromCache: false,
      liveRun: true,
    };
  }
}
