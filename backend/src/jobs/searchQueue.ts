import { Queue, Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis";
import { logger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import { env } from "../lib/env";
import { emitSearchEvent } from "./progressEvents";
import { CollectorResult, Video } from "../collectors/types";
import { filterPreviouslySeen } from "../dedup/crossSearch";
import { normalizeUrl, sha256 } from "../lib/utils";
import {
  aboveFloorCount,
  engagementOrderingByPlatformFor,
  engagementOrderingFor,
  engagementStatus,
  floorForPlatform,
  rankOrganicVideos,
} from "../engagement/reels";

export const SEARCH_QUEUE_NAME = "search-jobs";

// ─── Job Data Shape ───────────────────────────────────────────────────────────
export interface SearchJobData {
  searchId: string;
  query: string;
  queryType: "keyword" | "url" | "image";
  imageFile?: string; // base64 encoded if image upload
  showSeen?: boolean;
}

// ─── Queue singleton ──────────────────────────────────────────────────────────
let queueInstance: Queue | null = null;

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const query of queries) {
    const normalized = query.toLowerCase().replace(/^#/, "").replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

const INSTAGRAM_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "tm",
]);

function instagramTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !INSTAGRAM_QUERY_STOPWORDS.has(token));
}

function tagCandidate(value: string): string {
  return value.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "");
}

export function buildInstagramHashtagQueries(values: string[], limit: number): string[] {
  const tokens = uniqueQueries(values.flatMap(instagramTokens));
  const phrases = uniqueQueries(values).flatMap((value) => {
    const valueTokens = instagramTokens(value);
    const compact = tagCandidate(valueTokens.join(""));
    const candidates: string[] = [];
    if (valueTokens.length > 1 && compact.length <= 30) {
      candidates.push(compact);
    }
    for (let i = 0; i < valueTokens.length - 1; i++) {
      const left = valueTokens[i];
      const right = valueTokens[i + 1];
      const pair = `${left}${right}`;
      candidates.push(pair);
    }
    return candidates;
  });

  return uniqueQueries([...phrases, ...tokens])
    .map(tagCandidate)
    .filter((query) => query.length >= 3 && query.length <= 30)
    .slice(0, Math.max(1, limit));
}

async function getPreviouslySeenIds(): Promise<Set<string>> {
  const prisma = getPrisma();
  const rows = await prisma.searchResult.findMany({
    select: {
      video: { select: { platform: true, platformId: true } },
    },
  });
  return new Set(rows.map((row) => `${row.video.platform}:${row.video.platformId}`));
}

function appendSeenIds(seenIds: Set<string>, videos: Video[]): void {
  for (const video of videos) {
    seenIds.add(`${video.platform}:${video.platformId}`);
  }
}

function platformCount(videos: Video[], platform: Video["platform"]): number {
  return videos.filter((video) => video.platform === platform).length;
}

export type SourceWarnings = Record<string, string[]>;

function addSourceWarning(warnings: SourceWarnings, source: string, message: string): void {
  const existing = warnings[source] ?? [];
  if (existing.includes(message)) return;
  warnings[source] = [...existing, message];
}

function eligibleOrganicVideo(video: Video): boolean {
  if (video.sourceKind !== "organic") return false;
  if (video.platform === "instagram") return video.contentType === "reel";
  if (video.platform === "tiktok") return video.contentType === "video";
  return false;
}

function nextQueryBatch(baseQueries: string[], attempt: number): string[] {
  if (attempt === 0) return baseQueries;
  void attempt;
  return uniqueQueries(baseQueries)
    .map(tagCandidate)
    .filter((query) => query.length >= 3 && query.length <= 30)
    .slice(0, 4);
}

export interface SourceCollectorConfig {
  id: Video["platform"];
  label: string;
  kind: "organic" | "ads" | "unknown";
  collector: { collect: (queries: string[], opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }) => Promise<CollectorResult> };
  queries: string[];
  target: number;
}

export interface CollectionPipelineResult {
  videos: Video[];
  status: "complete" | "partial";
  targetResults: number;
  sourceKinds: Record<string, "organic" | "ads" | "unknown">;
  dropReasons: Record<string, number>;
  sourceWarnings?: SourceWarnings;
}

export interface SourcePlan {
  sources: SourceCollectorConfig[];
  sourceWarnings: SourceWarnings;
  requestedSources: string[];
}

export async function buildSourceConfigsForSearch(params: {
  requestedSources: string[];
  instagramQueries: string[];
  tiktokQueries?: string[];
  metaQueries: string[];
  target: number;
}): Promise<SourcePlan> {
  const sourceWarnings: SourceWarnings = {};
  const requested = Array.from(new Set(params.requestedSources.map((source) => source.trim().toLowerCase()).filter(Boolean)));
  const unsupported = requested.filter((source) => !["instagram", "tiktok"].includes(source));
  for (const source of unsupported) {
    addSourceWarning(sourceWarnings, source, "Unsupported source ignored for organic video search.");
    logger.warn({ source, requestedSources: requested }, "Unsupported search source ignored");
  }

  const sources: SourceCollectorConfig[] = [];
  if (requested.includes("instagram")) {
    const { InstagramCollector } = await import("../collectors/instagram");
    sources.push({
      id: "instagram",
      label: "Instagram Reels",
      kind: "organic",
      collector: new InstagramCollector(),
      queries: params.instagramQueries,
      target: params.target,
    });
  }

  if (requested.includes("tiktok")) {
    if (!env.ENABLE_TIKTOK) {
      addSourceWarning(sourceWarnings, "tiktok", "TikTok is disabled. Set ENABLE_TIKTOK=true and include tiktok in SEARCH_SOURCES to show TikTok videos.");
      logger.warn({ requestedSources: requested }, "TikTok requested but ENABLE_TIKTOK is false");
    } else if (!env.APIFY_API_TOKEN || !env.TIKTOK_ACTOR_ID) {
      addSourceWarning(sourceWarnings, "tiktok", "TikTok disabled: APIFY_API_TOKEN or TIKTOK_ACTOR_ID is missing.");
      logger.warn(
        { hasApifyToken: Boolean(env.APIFY_API_TOKEN), hasTikTokActorId: Boolean(env.TIKTOK_ACTOR_ID) },
        "TikTok requested but provider configuration is missing"
      );
    } else {
      const { TikTokCollector } = await import("../collectors/tiktok");
      sources.push({
        id: "tiktok",
        label: "TikTok Videos",
        kind: "organic",
        collector: new TikTokCollector(),
        queries: params.tiktokQueries ?? params.instagramQueries,
        target: params.target,
      });
      logger.info({ actorId: env.TIKTOK_ACTOR_ID, target: params.target }, "TikTok source enabled for search");
    }
  }

  void params.metaQueries;
  if (!requested.includes("tiktok") && env.ENABLE_TIKTOK) {
    addSourceWarning(sourceWarnings, "tiktok", "TikTok is enabled but not requested. Add tiktok to SEARCH_SOURCES to include TikTok videos.");
  }
  return { sources, sourceWarnings, requestedSources: requested };
}

function mergeReasons(target: Record<string, number>, source?: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source ?? {})) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function sourceWarningForDropReason(reason: string): string | undefined {
  switch (reason) {
    case "apify_monthly_usage_hard_limit":
      return "Apify monthly usage hard limit is exceeded, so this source cannot run. Raise the Apify usage limit/add billing credits, or switch to fixture mode while developing.";
    case "apify_provider_auth":
      return "Apify rejected the token or actor access for this source. Check APIFY_API_TOKEN and the actor permissions.";
    case "tiktok_paid_actor_insufficient_usage":
      return "TikTok could not run because the Apify account does not have enough remaining usage for this paid actor. Add Apify credits, raise the billing limit, choose a cheaper/free actor, or remove tiktok from SEARCH_SOURCES.";
    case "tiktok_provider_auth":
      return "TikTok could not run because Apify rejected the token or actor access. Check APIFY_API_TOKEN and TIKTOK_ACTOR_ID.";
    case "missing_tiktok_provider_config":
      return "TikTok disabled: APIFY_API_TOKEN or TIKTOK_ACTOR_ID is missing.";
    case "per_job_run_cap":
      return "Provider run budget reached for this search; showing the best results collected so far.";
    case "daily_run_budget":
      return "Daily provider run budget reached; showing cached or already collected results only.";
    case "provider_error":
      return "Provider error while collecting this source; showing results from sources that completed.";
    default:
      return undefined;
  }
}

function addDropReasonWarnings(warnings: SourceWarnings, source: string, dropReasons?: Record<string, number>): void {
  for (const [reason, count] of Object.entries(dropReasons ?? {})) {
    if (count <= 0) continue;
    const message = sourceWarningForDropReason(reason);
    if (message) addSourceWarning(warnings, source, message);
  }
}

function hasActionableDropReason(dropReasons?: Record<string, number>): boolean {
  return Object.keys(dropReasons ?? {}).some((reason) => sourceWarningForDropReason(reason));
}

function totalTarget(sources: SourceCollectorConfig[]): number {
  return sources.reduce((sum, source) => sum + source.target, 0);
}

function sourceKindsFor(sources: SourceCollectorConfig[]): Record<string, "organic" | "ads" | "unknown"> {
  return Object.fromEntries(sources.map((source) => [source.id, source.kind]));
}

function platformFloors(): Record<string, number> {
  return {
    instagram: env.MIN_INSTAGRAM_VIEWS,
    tiktok: env.MIN_TIKTOK_VIEWS,
  };
}

function engagementSummaryByPlatform(
  rows: Array<{ platform: string; views?: number | null }>,
  floors = platformFloors()
): Record<string, { aboveFloor: number; shown: number; floor: number }> {
  const byPlatform = new Map<string, Array<{ views?: number | null }>>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }
  return Object.fromEntries(
    [...byPlatform.entries()].map(([platform, items]) => {
      const floor = floorForPlatform(platform, floors, env.MIN_VIDEO_VIEWS);
      return [platform, { aboveFloor: aboveFloorCount(items, floor), shown: items.length, floor }];
    })
  );
}

function legacyEngagementOrdering(orderingByPlatform: Record<string, "enabled" | "disabled_low_coverage">): "enabled" | "disabled_low_coverage" {
  const values = Object.values(orderingByPlatform);
  return values.length > 0 && values.every((value) => value === "enabled") ? "enabled" : "disabled_low_coverage";
}

function qualityNoticeFor(params: {
  results: Array<{ label?: string; score?: number; engagementStatus?: string; reason?: string }>;
  targetResults: number;
  sourceWarnings?: SourceWarnings;
}): { title: string; messages: string[] } | undefined {
  const messages: string[] = [];
  const matchCount = params.results.filter((result) => result.label === "match" && (result.score ?? 0) >= 0.6).length;
  const highEngagementCount = params.results.filter((result) => result.engagementStatus === "high").length;
  const fallbackCount = params.results.filter((result) => /fallback|text relevance|visual verification unavailable|inconclusive/i.test(result.reason ?? "")).length;

  if (params.results.length === 0) {
    messages.push("No eligible organic videos were found for this search.");
  } else {
    if (matchCount < Math.max(3, Math.ceil(params.targetResults * 0.25))) {
      messages.push("Very few visually relevant videos were found. Results may be based on broad caption or hashtag matches.");
    }
    if (highEngagementCount < Math.max(3, Math.ceil(params.results.length * 0.25))) {
      messages.push("Few returned videos clear the high-engagement view threshold.");
    }
    if (fallbackCount > Math.ceil(params.results.length * 0.5)) {
      messages.push("Visual verification was unavailable or inconclusive for many videos, so ranking relied more on text signals.");
    }
  }

  for (const [source, warnings] of Object.entries(params.sourceWarnings ?? {})) {
    for (const warning of warnings) messages.push(`${source}: ${warning}`);
  }

  return messages.length > 0 ? { title: "Why results may look weak", messages } : undefined;
}

function hasProviderBudgetStop(dropReasons: Record<string, number>): boolean {
  return Boolean(dropReasons.per_job_run_cap || dropReasons.daily_run_budget);
}

export async function collectWithRefill(params: {
  sources: SourceCollectorConfig[];
  seenIds: Set<string>;
  searchId: string;
  timeBudgetMs: number;
  sourceWarnings?: SourceWarnings;
}): Promise<CollectionPipelineResult> {
  const started = Date.now();
  const rawVideos: Video[] = [];
  const attemptedQueries = new Map<string, Set<string>>();
  const dropReasons: Record<string, number> = {};
  const sourceWarnings: SourceWarnings = { ...(params.sourceWarnings ?? {}) };
  let attempts = 0;

  while (attempts < env.MAX_REFILL_ROUNDS && Date.now() - started < params.timeBudgetMs) {
    const missingBySource = params.sources.map((source) => ({
      source,
      missing: Math.max(0, source.target - platformCount(rawVideos, source.id)),
    }));
    if (missingBySource.every((entry) => entry.missing === 0)) break;

    const timeLeft = Math.max(1000, params.timeBudgetMs - (Date.now() - started));
    const tasks = missingBySource.map(({ source, missing }) => {
      const seenForSource = attemptedQueries.get(source.id) ?? new Set<string>();
      attemptedQueries.set(source.id, seenForSource);
      const queries = nextQueryBatch(source.queries, attempts).filter((query) => {
        if (seenForSource.has(query)) return false;
        seenForSource.add(query);
        return true;
      });
      return { source, missing, queries };
    });

    const runnable = tasks.filter((task) => task.missing > 0 && task.queries.length > 0);
    if (runnable.length === 0) break;

    const results = await Promise.allSettled(
      runnable.map((task) =>
        Promise.race([
          task.source.collector.collect(task.queries, {
            target: task.missing,
            seenIds: params.seenIds,
            timeBudgetMs: timeLeft,
          }),
          new Promise<CollectorResult>((_, reject) =>
            setTimeout(() => reject(new Error("source_timeout")), Math.min(timeLeft, env.REQUEST_TIMEOUT_MS * 6))
          ),
        ])
      )
    );

    for (let i = 0; i < runnable.length; i++) {
      const task = runnable[i];
      const result = results[i];
      if (result.status !== "fulfilled") {
        mergeReasons(dropReasons, { provider_error: 1 });
        addSourceWarning(sourceWarnings, task.source.id, result.reason instanceof Error ? result.reason.message : "Provider error.");
        continue;
      }

      mergeReasons(dropReasons, result.value.stats.dropReasons);
      addDropReasonWarnings(sourceWarnings, task.source.id, result.value.stats.dropReasons);
      if (result.value.videos.length === 0 && !hasActionableDropReason(result.value.stats.dropReasons)) {
        addSourceWarning(sourceWarnings, task.source.id, "No eligible organic videos returned.");
      }
      const videos = filterPreviouslySeen(result.value.videos, params.seenIds);
      rawVideos.push(...videos);
      appendSeenIds(params.seenIds, videos);
      emitSearchEvent(params.searchId, {
        contractVersion: 1,
        stage: "collect",
        status: "progress",
        source: task.source.id,
        sourceKinds: sourceKindsFor(params.sources),
        got: rawVideos.filter((video) => video.platform === task.source.id).length,
        wanted: task.source.target,
        targetResults: totalTarget(params.sources),
        dropReasons,
      });
    }

    if (params.sources.every((source) => platformCount(rawVideos, source.id) >= source.target)) break;
    attempts++;
  }

  const targetResults = totalTarget(params.sources);
  const status = rawVideos.length >= targetResults ? "complete" : "partial";
  emitSearchEvent(params.searchId, {
    contractVersion: 1,
    stage: "collect",
    status: "done",
    resultStatus: status,
    got: rawVideos.length,
    wanted: targetResults,
    targetResults,
    sourceKinds: sourceKindsFor(params.sources),
    dropReasons,
    sourceWarnings,
    shortfall: Math.max(0, targetResults - rawVideos.length),
  });

  return {
    videos: rawVideos,
    status,
    targetResults,
    sourceKinds: sourceKindsFor(params.sources),
    dropReasons,
    sourceWarnings,
  };
}

export async function dedupWithSourceRefill(params: {
  rawVideos: Video[];
  sources: SourceCollectorConfig[];
  seenIds: Set<string>;
  searchId: string;
  timeBudgetMs: number;
  runDedup: (videos: Video[]) => Promise<Video[]>;
  dropReasons?: Record<string, number>;
  sourceWarnings?: SourceWarnings;
}): Promise<CollectionPipelineResult> {
  const started = Date.now();
  let rawVideos = params.rawVideos;
  let dedupedVideos = await params.runDedup(rawVideos);
  const dropReasons = { ...(params.dropReasons ?? {}) };
  const sourceWarnings: SourceWarnings = { ...(params.sourceWarnings ?? {}) };
  let attempts = 0;

  while (attempts < env.MAX_REFILL_ROUNDS && Date.now() - started < params.timeBudgetMs) {
    if (hasProviderBudgetStop(dropReasons)) break;

    const missingBySource = params.sources.map((source) => ({
      source,
      missing: Math.max(0, source.target - platformCount(dedupedVideos, source.id)),
    }));
    if (missingBySource.every((entry) => entry.missing === 0)) break;

    emitSearchEvent(params.searchId, {
      contractVersion: 1,
      stage: "collect",
      status: "progress",
      source: "post-dedup-refill",
      got: dedupedVideos.length,
      wanted: totalTarget(params.sources),
      targetResults: totalTarget(params.sources),
      sourceKinds: sourceKindsFor(params.sources),
      dropReasons,
      shortfall: missingBySource.reduce((sum, entry) => sum + entry.missing, 0),
    });

    const timeLeft = Math.max(1000, params.timeBudgetMs - (Date.now() - started));
    const runnable = missingBySource.filter((entry) => entry.missing > 0);
    const results = await Promise.allSettled(
      runnable.map(({ source, missing }) =>
        source.collector.collect(nextQueryBatch(source.queries, attempts + 1), {
          target: missing,
          seenIds: params.seenIds,
          timeBudgetMs: timeLeft,
        })
      )
    );

    const refill: Video[] = [];
    for (let i = 0; i < runnable.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled") {
        mergeReasons(dropReasons, { provider_error: 1 });
        addSourceWarning(sourceWarnings, runnable[i].source.id, result.reason instanceof Error ? result.reason.message : "Provider error.");
        continue;
      }
      mergeReasons(dropReasons, result.value.stats.dropReasons);
      addDropReasonWarnings(sourceWarnings, runnable[i].source.id, result.value.stats.dropReasons);
      refill.push(...filterPreviouslySeen(result.value.videos, params.seenIds));
    }
    appendSeenIds(params.seenIds, refill);

    rawVideos = [...rawVideos, ...refill];
    dedupedVideos = await params.runDedup(rawVideos);
    attempts++;
  }

  const videos = params.sources.flatMap((source) =>
    dedupedVideos.filter((video) => video.platform === source.id).slice(0, source.target)
  );
  const targetResults = totalTarget(params.sources);
  return {
    videos,
    status: videos.length >= targetResults ? "complete" : "partial",
    targetResults,
    sourceKinds: sourceKindsFor(params.sources),
    dropReasons,
    sourceWarnings,
  };
}

export function getSearchQueue(): Queue {
  if (!queueInstance) {
    queueInstance = new Queue(SEARCH_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
    logger.info("Search queue initialized");
  }
  return queueInstance;
}

// ─── Worker (Phase 0.8 — processes jobs) ─────────────────────────────────────
export async function processSearchJob(
  data: SearchJobData,
  updateProgress: (progress: number) => Promise<void> | void = () => undefined
): Promise<{ searchId: string; status: "done"; count: number }> {
      const { searchId, query, queryType, imageFile, showSeen } = data;
      logger.info({ searchId, query, queryType }, "Job received");
      emitSearchEvent(searchId, { stage: "validate", status: "done" });
      await updateProgress(10);

      try {
        // --- PHASE 1: PRODUCT RESOLVER ---
        const { scrapeProduct, resolveFromKeyword } = await import("../scraper/productScraper");
        let product;
        const treatAsKeyword = queryType === "keyword";
        const effectiveQuery = query;

        if (queryType === "url") {
          product = await scrapeProduct(query);
          if ("error" in product) {
            throw new Error(`Scraper Error: ${product.error.hint}`);
          }
        } else if (queryType === "image") {
          product = {
            title: query || "Uploaded product image",
            imageUrl: imageFile ?? "",
            description: "Product resolved from uploaded image.",
            extractedBy: "image-upload",
          };
        } else {
          product = resolveFromKeyword(effectiveQuery);
        }
        emitSearchEvent(searchId, {
          stage: "resolve",
          status: "done",
          product: {
            title: product.title,
            imageUrl: product.imageUrl,
            description: product.description,
          },
        });
        await updateProgress(20);

        if (!treatAsKeyword && !product.imageUrl) {
          throw new Error("Product resolver could not find an image URL.");
        }

        // --- PHASE 2: IMAGE BRAIN ---
        const { analyzeImage, analyzeKeyword, bulkScoreVideos } = await import("../brain/imageBrain");
        const brainData =
          treatAsKeyword
            ? await analyzeKeyword(effectiveQuery)
            : await analyzeImage(product.imageUrl, product.title, product.description);
        logger.info(
          {
            searchId,
            productTitle: product.title,
            productDescription: product.description,
            productType: brainData.attributes.productType,
            searchQueries: brainData.attributes.searchQueries,
            matchCriteria: brainData.attributes.matchCriteria,
          },
          "Product analysis complete"
        );
        emitSearchEvent(searchId, {
          stage: "brain",
          status: "done",
          attributes: brainData.attributes,
        });
        await updateProgress(40);

        // --- PHASE 3: VIDEO COLLECTORS ---
        const instagramQueries =
          treatAsKeyword
            ? buildInstagramHashtagQueries([effectiveQuery, ...brainData.attributes.searchQueries], env.KEYWORD_INSTAGRAM_QUERIES)
            : buildInstagramHashtagQueries([product.title, product.description, ...brainData.attributes.searchQueries], env.KEYWORD_INSTAGRAM_QUERIES);
        const metaQueries =
          treatAsKeyword
            ? [effectiveQuery]
            : uniqueQueries([product.title, ...brainData.attributes.adKeywords]).slice(0, 2);

        const sourcePlan = await buildSourceConfigsForSearch({
          requestedSources: env.SEARCH_SOURCES,
          instagramQueries,
          tiktokQueries: instagramQueries,
          metaQueries,
          target: env.TARGET_RESULTS,
        });
        const { sources } = sourcePlan;
        if (sources.length === 0) {
          throw new Error("SEARCH_SOURCES did not enable any supported collectors.");
        }

        logger.info(
          { sources: sources.map((source) => source.id), instagramQueries, metaQueries, target: env.TARGET_RESULTS },
          "Collector query plan"
        );
        const attributesForStorage = {
          ...brainData.attributes,
          queryPlan: {
            instagramQueries,
            tiktokQueries: instagramQueries,
            metaQueries,
            sources: sources.map((source) => source.id),
            sourceWarnings: sourcePlan.sourceWarnings,
          },
        };

        const seenIds = showSeen ? new Set<string>() : await getPreviouslySeenIds();

        const collectionResult = await collectWithRefill({
          sources,
          seenIds,
          searchId,
          timeBudgetMs: 60000,
          sourceWarnings: sourcePlan.sourceWarnings,
        });
        let rawVideos = collectionResult.videos.filter(eligibleOrganicVideo);

        await updateProgress(60);

        // --- PHASE 4: DEDUPLICATION ---
        const { runDedupPipeline } = await import("../dedup");
        const dedupResult = await dedupWithSourceRefill({
          rawVideos,
          sources,
          seenIds,
          searchId,
          timeBudgetMs: 60000,
          runDedup: runDedupPipeline,
          dropReasons: collectionResult.dropReasons,
          sourceWarnings: collectionResult.sourceWarnings,
        });
        const dedupedVideos = dedupResult.videos.filter(eligibleOrganicVideo);
        const engagementOrderingByPlatform = engagementOrderingByPlatformFor(dedupedVideos);
        const engagementOrdering = legacyEngagementOrdering(engagementOrderingByPlatform);
        for (const [platform, ordering] of Object.entries(engagementOrderingByPlatform)) {
          const platformRows = dedupedVideos.filter((video) => video.platform === platform);
          if (ordering === "disabled_low_coverage" && platformRows.length > 0) {
            logger.warn(
              {
                searchId,
                platform,
                usableViewCoverage: platformRows.filter((video) => video.views !== undefined && video.views !== null).length / platformRows.length,
              },
              "Engagement ordering disabled for source due to low usable view coverage"
            );
          }
        }
        emitSearchEvent(searchId, {
          contractVersion: 1,
          stage: "dedup",
          status: "done",
          before: rawVideos.length,
          after: dedupedVideos.length,
          resultStatus: dedupResult.status,
          targetResults: dedupResult.targetResults,
          sourceKinds: dedupResult.sourceKinds,
          dropReasons: dedupResult.dropReasons,
        });
        await updateProgress(70);

        // --- PHASE 2b: BULK SCORING ---
        const scoredResults = await bulkScoreVideos(
          product.imageUrl,
          brainData.embedding,
          brainData.attributes,
          dedupedVideos.map(v => ({
            id: v.platformId,
            thumbnailUrl: v.thumbnailUrl,
            videoUrl: v.url,
            caption: v.caption,
            author: v.author,
          })),
          env.VLM_TOP_N
        );
        const floors = platformFloors();
        const rankedResults = rankOrganicVideos(
          scoredResults.flatMap((scored) => {
            const video = dedupedVideos.find((candidate) => candidate.platformId === scored.id);
            if (!video) return [];
            return [{
              scored,
              video,
              platform: video.platform,
              score: scored.score.finalScore,
              label: scored.score.label,
              views: video.views,
              likes: video.likes,
            }];
          }),
          floors,
          env.MIN_VIDEO_VIEWS,
          engagementOrderingByPlatform
        ).slice(0, env.TARGET_RESULTS * Math.max(1, sources.length));
        emitSearchEvent(searchId, {
          contractVersion: 1,
          stage: "score",
          status: "done",
          scored: rankedResults.length,
          total: dedupedVideos.length,
          resultStatus: dedupResult.status,
          targetResults: dedupResult.targetResults,
        });
        await updateProgress(85);

        // --- PHASE 5: DATABASE SAVE ---
        const prisma = getPrisma();

        // 1. Save Search
        await prisma.search.update({
          where: { id: searchId },
          data: {
            productTitle: product.title,
            imageUrl: product.imageUrl,
            attributesJson: JSON.stringify(attributesForStorage),
          }
        });

        // 2. Save Videos and SearchResults
        for (const ranked of rankedResults) {
          const { scored, video } = ranked;

          const engagementUpdate =
            video.views !== undefined || video.likes !== undefined
              ? {
                  ...(video.views !== undefined ? { views: video.views } : {}),
                  ...(video.likes !== undefined ? { likes: video.likes } : {}),
                  engagementFetchedAt: new Date(video.engagementFetchedAt ?? Date.now()),
                }
              : {};

          // Upsert Video
          const dbVideo = await (prisma as any).video.upsert({
            where: {
              platform_platformId: { platform: video.platform, platformId: video.platformId }
            },
            update: {
              metaPath: video.metaPath,
              thumbnailUrl: video.thumbnailUrl,
              caption: video.caption,
              thumbPHash: video.thumbPHash ?? "",
              captionSimhash: video.captionSimhash ?? "",
              providerMediaId: video.providerMediaId,
              providerCreatorId: video.providerCreatorId,
              creatorHandle: video.creatorHandle,
              contentType: video.contentType ?? "unknown",
              sourceKind: video.sourceKind ?? (video.platform === "meta" ? "ads" : "unknown"),
              isPaidPartnership: video.isPaidPartnership ?? false,
              paidMarkerDetected: video.paidMarkerDetected,
              dropReason: video.dropReason,
              ...engagementUpdate,
            },
            create: {
              platform: video.platform,
              platformId: video.platformId,
              providerMediaId: video.providerMediaId,
              providerCreatorId: video.providerCreatorId,
              url: video.url,
              thumbnailUrl: video.thumbnailUrl,
              caption: video.caption,
              creatorHandle: video.creatorHandle,
              urlHash: video.urlHash || sha256(normalizeUrl(video.url || `${video.platform}:${video.platformId}`)),
              thumbPHash: video.thumbPHash ?? "",
              captionSimhash: video.captionSimhash ?? "",
              embedding: Buffer.from(JSON.stringify(video.embedding ?? [])),
              metaPath: video.metaPath,
              contentType: video.contentType ?? "unknown",
              sourceKind: video.sourceKind ?? (video.platform === "meta" ? "ads" : "unknown"),
              isPaidPartnership: video.isPaidPartnership ?? false,
              paidMarkerDetected: video.paidMarkerDetected,
              dropReason: video.dropReason,
              views: video.views,
              likes: video.likes,
              engagementFetchedAt: video.engagementFetchedAt ? new Date(video.engagementFetchedAt) : undefined,
            }
          });

          // Create SearchResult
          await prisma.searchResult.upsert({
            where: {
              searchId_videoId: {
                searchId: searchId,
                videoId: dbVideo.id,
              },
            },
            update: {
              score: scored.score.finalScore,
              label: scored.score.label,
              reason: scored.score.reason,
            },
            create: {
              searchId: searchId,
              videoId: dbVideo.id,
              score: scored.score.finalScore,
              label: scored.score.label,
              reason: scored.score.reason,
            }
          });
        }

        // Update search status to done
        await prisma.search.update({
          where: { id: searchId },
          data: { status: "done" }
        });
        emitSearchEvent(searchId, { stage: "persist", status: "done" });

        const responseResults = rankedResults.map(({ scored, video }) => {
          return [{
            id: video.platformId,
            videoId: video.platformId,
            platform: video.platform,
            platformId: video.platformId,
            url: video.url,
            thumbnailUrl: video.thumbnailUrl,
            caption: video.caption,
            score: scored.score.finalScore,
            label: scored.score.label,
            reason: scored.score.reason,
            metaPath: video.metaPath,
            contentType: video.contentType ?? "unknown",
            sourceKind: video.sourceKind ?? (video.platform === "meta" ? "ads" : "unknown"),
            isPaidPartnership: video.isPaidPartnership ?? false,
            paidMarkerDetected: video.paidMarkerDetected,
            dropReason: video.dropReason,
            views: video.views,
            likes: video.likes,
            engagementFetchedAt: video.engagementFetchedAt,
            engagementStatus: engagementStatus(video.views, floorForPlatform(video.platform, floors, env.MIN_VIDEO_VIEWS)),
            engagementOrdering,
          }];
        }).flat();
        const sourceWarnings = dedupResult.sourceWarnings ?? {};
        const qualityNotice = qualityNoticeFor({
          results: responseResults,
          targetResults: env.TARGET_RESULTS,
          sourceWarnings,
        });
        emitSearchEvent(searchId, {
          contractVersion: 1,
          stage: "done",
          status: dedupResult.status,
          targetResults: dedupResult.targetResults,
          sourceKinds: dedupResult.sourceKinds,
          dropReasons: dedupResult.dropReasons,
          results: responseResults,
          engagementOrdering,
          engagementOrderingByPlatform,
          engagementSummary: {
            aboveFloor: aboveFloorCount(responseResults, env.MIN_VIDEO_VIEWS),
            shown: responseResults.length,
            floor: env.MIN_VIDEO_VIEWS,
          },
          engagementSummaryByPlatform: engagementSummaryByPlatform(responseResults, floors),
          sourceWarnings,
          qualityNotice,
          productInfo: {
            title: product.title,
            imageUrl: product.imageUrl,
            description: product.description,
            attributes: brainData.attributes,
            diagnostics: attributesForStorage.queryPlan,
          },
        });

        await updateProgress(100);
        logger.info({ searchId, videosCount: rankedResults.length }, "Job completed successfully");
        return { searchId, status: "done", count: rankedResults.length };
      } catch (err) {
        logger.error({ err, searchId }, "Job failed in pipeline");
        emitSearchEvent(searchId, {
          stage: "error",
          error: {
            code: "JOB_FAILED",
            message: "Search pipeline failed",
            hint: err instanceof Error ? err.message : "Check backend logs for details.",
          },
        });
        
        // Mark search as failed
        await getPrisma().search.update({
          where: { id: searchId },
          data: { status: "failed" }
        }).catch((e: any) => logger.error({e}, "Failed to update search status to failed"));
        
        throw err;
      }
}

export function startSearchWorker(): Worker | null {
  if (env.QUEUE_MODE === "inline") {
    logger.info("Inline queue mode enabled; BullMQ worker not started");
    return null;
  }

  const worker = new Worker(
    SEARCH_QUEUE_NAME,
    async (job: Job) =>
      processSearchJob(job.data as SearchJobData, (progress) =>
        job.updateProgress(progress)
      ),
    {
      connection: getRedis(),
      concurrency: env.WORKER_CONCURRENCY,
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Job failed");
  });

  return worker;
}

