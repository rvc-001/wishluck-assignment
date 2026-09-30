import axios from "axios";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { Collector, CollectorOptions, CollectorResult, Video, makeSeenKey } from "./types";
import {
  ProviderRunBudget,
  createProviderRunBudget,
  readProviderCache,
  tryConsumeProviderRun,
  writeProviderCache,
} from "./providerRuntime";
import { firstUsableCount, CANONICAL_VIEW_FIELDS, LIKE_FIELDS } from "../engagement/reels";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { sleep, withRetry } from "../lib/utils";

const APIFY_BASE_URL = "https://api.apify.com/v2";
const APIFY_USAGE_LIMIT_REASON = "apify_monthly_usage_hard_limit";
const TIKTOK_USAGE_BLOCKED_REASON = "tiktok_paid_actor_insufficient_usage";
const TIKTOK_AUTH_BLOCKED_REASON = "tiktok_provider_auth";

export interface ApifyTikTokRawItem {
  id?: unknown;
  videoId?: unknown;
  awemeId?: unknown;
  itemId?: unknown;
  webVideoUrl?: string;
  url?: string;
  shareUrl?: string;
  cover?: string;
  thumbnail?: string;
  thumbnailUrl?: string;
  videoMeta?: { coverUrl?: string; originalCoverUrl?: string };
  desc?: string;
  text?: string;
  title?: string;
  authorMeta?: { name?: string; nickName?: string; id?: unknown };
  author?: { uniqueId?: string; nickname?: string; id?: unknown } | string;
  createTimeISO?: string;
  createTime?: string | number;
  create_time?: string | number;
  playCount?: unknown;
  viewCount?: unknown;
  videoPlayCount?: unknown;
  views?: unknown;
  diggCount?: unknown;
  likeCount?: unknown;
  likes?: unknown;
}

function stringId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9\s_]/g, " ").replace(/\s+/g, " ").trim();
}

function creatorHandle(raw: ApifyTikTokRawItem): string | undefined {
  const authorObject = typeof raw.author === "object" ? raw.author : undefined;
  const name = raw.authorMeta?.name ?? authorObject?.uniqueId ?? (typeof raw.author === "string" ? raw.author : undefined);
  return name ? `@${name.replace(/^@/, "")}` : undefined;
}

function normalizeCreatedAt(raw: ApifyTikTokRawItem): string | undefined {
  if (raw.createTimeISO) return raw.createTimeISO;
  const value = raw.createTime ?? raw.create_time;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 9_999_999_999 ? value : value * 1000).toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function apifyBlockedReason(err: unknown): string | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const status = err.response?.status;
  const type = (err.response?.data as { error?: { type?: string } } | undefined)?.error?.type;
  if (type === "platform-feature-disabled") return APIFY_USAGE_LIMIT_REASON;
  if (status === 402 || type === "not-enough-usage-to-run-paid-actor") return TIKTOK_USAGE_BLOCKED_REASON;
  if (status === 401 || status === 403) return TIKTOK_AUTH_BLOCKED_REASON;
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

export function normalizeApifyTikTokItem(raw: ApifyTikTokRawItem): Video | null {
  const platformId = stringId(raw.id) ?? stringId(raw.videoId) ?? stringId(raw.awemeId) ?? stringId(raw.itemId);
  if (!platformId) return null;
  const authorObject = typeof raw.author === "object" ? raw.author : undefined;
  const handle = creatorHandle(raw);
  const url = raw.webVideoUrl ?? raw.shareUrl ?? raw.url ?? (handle ? `https://www.tiktok.com/${handle}/video/${platformId}` : `https://www.tiktok.com/video/${platformId}`);
  const thumbnailUrl = raw.cover ?? raw.thumbnailUrl ?? raw.thumbnail ?? raw.videoMeta?.coverUrl ?? raw.videoMeta?.originalCoverUrl ?? "";
  const caption = raw.desc ?? raw.text ?? raw.title ?? "";
  const counts = raw as Record<string, unknown>;
  const views = firstUsableCount(counts, ["playCount", "viewCount", ...CANONICAL_VIEW_FIELDS]);
  const likes = firstUsableCount(counts, ["diggCount", "likeCount", ...LIKE_FIELDS]);

  return {
    id: uuidv4(),
    platform: "tiktok",
    platformId,
    providerMediaId: platformId,
    providerCreatorId: stringId(raw.authorMeta?.id) ?? stringId(authorObject?.id) ?? handle,
    url,
    thumbnailUrl,
    caption,
    author: handle,
    creatorHandle: handle,
    likes,
    views,
    engagementFetchedAt: views !== undefined || likes !== undefined ? new Date().toISOString() : undefined,
    contentType: "video",
    sourceKind: "organic",
    isPaidPartnership: false,
    createdAt: normalizeCreatedAt(raw),
  };
}

function expandFixtureVideos(videos: Video[], target: number, scope: string): Video[] {
  const expanded: Video[] = [];
  for (let i = 0; videos.length > 0 && expanded.length < target; i++) {
    const base = videos[i % videos.length];
    const suffix = i + 1;
    expanded.push({
      ...base,
      id: uuidv4(),
      platformId: `${scope}-${base.platformId}-${suffix}`,
      providerMediaId: `${base.providerMediaId}-${suffix}`,
      url: `${base.url}?fixture=${suffix}`,
      caption: `${base.caption} fixture ${suffix}`,
    });
  }
  return expanded;
}

export class TikTokCollector implements Collector {
  private budget: ProviderRunBudget;

  constructor() {
    this.budget = createProviderRunBudget("apify:tiktok");
  }

  async collect(queries: string[], opts: CollectorOptions): Promise<CollectorResult> {
    const triedQueries: string[] = [];
    const videos: Video[] = [];
    const localSeen = new Set(opts.seenIds);
    const dropReasons: Record<string, number> = {};
    const start = Date.now();
    let cacheHits = 0;
    let liveRuns = 0;

    logger.info(
      {
        queryCount: queries.length,
        target: opts.target,
        timeBudgetMs: opts.timeBudgetMs,
        actorId: env.TIKTOK_ACTOR_ID || undefined,
        useFixtures: env.USE_FIXTURES,
      },
      "TikTok collector: starting"
    );

    if (env.USE_FIXTURES) {
      const fixturePath = path.resolve(__dirname, "../../fixtures/tiktok-sample.json");
      const raw: ApifyTikTokRawItem[] = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      const normalized = raw.map(normalizeApifyTikTokItem).filter((video): video is Video => video !== null);
      const scope = normalizeQuery(queries[0] ?? "fixture").replace(/\s+/g, "") || "fixture";
      return {
        videos: expandFixtureVideos(normalized, opts.target, scope),
        stats: {
          got: Math.min(opts.target, normalized.length || opts.target),
          wanted: opts.target,
          triedQueries: ["fixture"],
          targetResults: opts.target,
          status: "complete",
          sourceKinds: { tiktok: "organic" },
          dropReasons,
        },
      };
    }

    if (!env.APIFY_API_TOKEN || !env.TIKTOK_ACTOR_ID) {
      logger.warn(
        { hasApifyToken: Boolean(env.APIFY_API_TOKEN), hasTikTokActorId: Boolean(env.TIKTOK_ACTOR_ID) },
        "TikTok collector: missing provider configuration"
      );
      return {
        videos: [],
        stats: {
          got: 0,
          wanted: opts.target,
          triedQueries,
          status: "partial",
          targetResults: opts.target,
          sourceKinds: { tiktok: "organic" },
          dropReasons: { missing_tiktok_provider_config: 1 },
        },
      };
    }

    for (const query of queries) {
      if (videos.length >= opts.target || Date.now() - start >= opts.timeBudgetMs) break;
      const normalizedQuery = normalizeQuery(query);
      if (!normalizedQuery) continue;
      triedQueries.push(normalizedQuery);

      try {
        logger.info({ query: normalizedQuery, remaining: opts.target - videos.length }, "TikTok collector: fetching query");
        const { items, fromCache, liveRun, blockedReason } = await withRetry(
          () => this.fetchNormalizedItems(normalizedQuery, opts.target - videos.length),
          { maxAttempts: 2, baseDelay: 1500 }
        );
        if (fromCache) cacheHits++;
        if (liveRun) liveRuns++;
        logger.info(
          { query: normalizedQuery, itemCount: items.length, fromCache, liveRun, blockedReason },
          "TikTok collector: query fetched"
        );
        if (blockedReason) {
          dropReasons[blockedReason] = (dropReasons[blockedReason] ?? 0) + 1;
          break;
        }

        for (const video of items) {
          const key = makeSeenKey("tiktok", video.platformId);
          if (localSeen.has(key)) continue;
          localSeen.add(key);
          videos.push(video);
          if (videos.length >= opts.target) break;
        }
      } catch (err) {
        const blockedReason = apifyBlockedReason(err);
        if (blockedReason) {
          logger.warn({ err: sanitizedProviderError(err), query, blockedReason }, "TikTok collector: provider blocked run");
          dropReasons[blockedReason] = (dropReasons[blockedReason] ?? 0) + 1;
          break;
        }

        logger.error({ err: sanitizedProviderError(err), query }, "TikTok collector: query failed");
        dropReasons.provider_error = (dropReasons.provider_error ?? 0) + 1;
      }

      if (videos.length < opts.target) await sleep(500);
    }

    return {
      videos,
      stats: {
        got: videos.length,
        wanted: opts.target,
        triedQueries,
        status: videos.length >= opts.target ? "complete" : "partial",
        targetResults: opts.target,
        sourceKinds: { tiktok: "organic" },
        dropReasons,
        cacheHits,
        liveRuns,
      },
    };
  }

  private async fetchNormalizedItems(
    query: string,
    maxItems: number
  ): Promise<{ items: Video[]; fromCache: boolean; liveRun: boolean; blockedReason?: string }> {
    const cacheKey = JSON.stringify({
      provider: "apify:tiktok",
      actor: env.TIKTOK_ACTOR_ID,
      query,
      maxItems: Math.min(maxItems, 50),
    });
    const cached = readProviderCache<ApifyTikTokRawItem[]>(cacheKey);
    if (cached) {
      return {
        items: cached.map(normalizeApifyTikTokItem).filter((video): video is Video => video !== null),
        fromCache: true,
        liveRun: false,
      };
    }

    const consumed = tryConsumeProviderRun(this.budget);
    if (!consumed.ok) return { items: [], fromCache: false, liveRun: false, blockedReason: consumed.reason };

    let runResp;
    try {
      logger.info(
        { actorId: env.TIKTOK_ACTOR_ID, query, maxItems: Math.min(maxItems, 50) },
        "TikTok collector: starting Apify actor run"
      );
      runResp = await axios.post(
        `${APIFY_BASE_URL}/acts/${env.TIKTOK_ACTOR_ID}/runs`,
        {
          searchQueries: [query],
          resultsPerPage: Math.min(maxItems, 50),
          searchSection: "/video",
        },
        { headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` }, timeout: 30000 }
      );
    } catch (err) {
      const blockedReason = apifyBlockedReason(err);
      if (blockedReason) {
        logger.warn({ err: sanitizedProviderError(err), query, blockedReason }, "TikTok collector: actor run could not start");
        return { items: [], fromCache: false, liveRun: false, blockedReason };
      }
      throw err;
    }

    const runId: string = runResp.data.data.id;
    let status = "RUNNING";
    for (let attempts = 0; status === "RUNNING" && attempts < 30; attempts++) {
      await sleep(3000);
      const statusResp = await axios.get(`${APIFY_BASE_URL}/actor-runs/${runId}`, {
        headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
      });
      status = statusResp.data.data.status;
    }
    if (status !== "SUCCEEDED") throw new Error(`TikTok Apify actor run ${runId} finished with status: ${status}`);

    const datasetResp = await axios.get(`${APIFY_BASE_URL}/actor-runs/${runId}/dataset/items`, {
      headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
      params: { clean: true, limit: maxItems },
    });
    const items: ApifyTikTokRawItem[] = datasetResp.data;
    writeProviderCache(cacheKey, items);
    return {
      items: items.map(normalizeApifyTikTokItem).filter((video): video is Video => video !== null),
      fromCache: false,
      liveRun: true,
    };
  }
}
