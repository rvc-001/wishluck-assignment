import { Queue, Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis";
import { logger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import { env } from "../lib/env";
import { emitSearchEvent } from "./progressEvents";
import { CollectorResult, Video } from "../collectors/types";
import { filterPreviouslySeen } from "../dedup/crossSearch";
import { normalizeUrl, sha256 } from "../lib/utils";

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
}

function mergeReasons(target: Record<string, number>, source?: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source ?? {})) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function totalTarget(sources: SourceCollectorConfig[]): number {
  return sources.reduce((sum, source) => sum + source.target, 0);
}

function sourceKindsFor(sources: SourceCollectorConfig[]): Record<string, "organic" | "ads" | "unknown"> {
  return Object.fromEntries(sources.map((source) => [source.id, source.kind]));
}

function hasProviderBudgetStop(dropReasons: Record<string, number>): boolean {
  return Boolean(dropReasons.per_job_run_cap || dropReasons.daily_run_budget);
}

export async function collectWithRefill(params: {
  sources: SourceCollectorConfig[];
  seenIds: Set<string>;
  searchId: string;
  timeBudgetMs: number;
}): Promise<CollectionPipelineResult> {
  const started = Date.now();
  const rawVideos: Video[] = [];
  const attemptedQueries = new Map<string, Set<string>>();
  const dropReasons: Record<string, number> = {};
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
        task.source.collector.collect(task.queries, {
          target: task.missing,
          seenIds: params.seenIds,
          timeBudgetMs: timeLeft,
        })
      )
    );

    for (let i = 0; i < runnable.length; i++) {
      const task = runnable[i];
      const result = results[i];
      if (result.status !== "fulfilled") {
        mergeReasons(dropReasons, { provider_error: 1 });
        continue;
      }

      mergeReasons(dropReasons, result.value.stats.dropReasons);
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
    shortfall: Math.max(0, targetResults - rawVideos.length),
  });

  return {
    videos: rawVideos,
    status,
    targetResults,
    sourceKinds: sourceKindsFor(params.sources),
    dropReasons,
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
}): Promise<CollectionPipelineResult> {
  const started = Date.now();
  let rawVideos = params.rawVideos;
  let dedupedVideos = await params.runDedup(rawVideos);
  const dropReasons = { ...(params.dropReasons ?? {}) };
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
        continue;
      }
      mergeReasons(dropReasons, result.value.stats.dropReasons);
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
            : await analyzeImage(product.imageUrl, product.title);
        emitSearchEvent(searchId, {
          stage: "brain",
          status: "done",
          attributes: brainData.attributes,
        });
        await updateProgress(40);

        // --- PHASE 3: VIDEO COLLECTORS ---
        const { InstagramCollector } = await import("../collectors/instagram");
        const { MetaCollector } = await import("../collectors/meta");

        const instagramQueries =
          treatAsKeyword
            ? buildInstagramHashtagQueries([effectiveQuery, ...brainData.attributes.searchQueries], env.KEYWORD_INSTAGRAM_QUERIES)
            : buildInstagramHashtagQueries(brainData.attributes.searchQueries, env.KEYWORD_INSTAGRAM_QUERIES);
        const metaQueries =
          treatAsKeyword
            ? [effectiveQuery]
            : uniqueQueries([product.title, ...brainData.attributes.adKeywords]).slice(0, 2);

        const activeSources = new Set(env.SEARCH_SOURCES);
        const sources: SourceCollectorConfig[] = [];
        if (activeSources.has("instagram")) {
          sources.push({
            id: "instagram",
            label: "Instagram Reels",
            kind: "organic",
            collector: new InstagramCollector(),
            queries: instagramQueries,
            target: env.TARGET_RESULTS,
          });
        }
        if (activeSources.has("meta")) {
          sources.push({
            id: "meta",
            label: "Meta Ad Library",
            kind: "ads",
            collector: new MetaCollector(),
            queries: metaQueries,
            target: env.TARGET_RESULTS,
          });
        }
        if (sources.length === 0) {
          throw new Error("SEARCH_SOURCES did not enable any supported collectors.");
        }

        logger.info(
          { sources: sources.map((source) => source.id), instagramQueries, metaQueries, target: env.TARGET_RESULTS },
          "Collector query plan"
        );

        const seenIds = showSeen ? new Set<string>() : await getPreviouslySeenIds();

        const collectionResult = await collectWithRefill({
          sources,
          seenIds,
          searchId,
          timeBudgetMs: 60000,
        });
        let rawVideos = collectionResult.videos;

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
        });
        const dedupedVideos = dedupResult.videos;
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
        emitSearchEvent(searchId, {
          contractVersion: 1,
          stage: "score",
          status: "done",
          scored: scoredResults.length,
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
            attributesJson: JSON.stringify(brainData.attributes),
          }
        });

        // 2. Save Videos and SearchResults
        for (const scored of scoredResults) {
          const video = dedupedVideos.find(v => v.platformId === scored.id);
          if (!video) continue;

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

        const responseResults = scoredResults.flatMap((scored) => {
          const video = dedupedVideos.find((candidate) => candidate.platformId === scored.id);
          if (!video) return [];
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
          }];
        });
        emitSearchEvent(searchId, {
          contractVersion: 1,
          stage: "done",
          status: dedupResult.status,
          targetResults: dedupResult.targetResults,
          sourceKinds: dedupResult.sourceKinds,
          dropReasons: dedupResult.dropReasons,
          results: responseResults,
          productInfo: {
            title: product.title,
            imageUrl: product.imageUrl,
            description: product.description,
            attributes: brainData.attributes,
          },
        });

        await updateProgress(100);
        logger.info({ searchId, videosCount: scoredResults.length }, "Job completed successfully");
        return { searchId, status: "done", count: scoredResults.length };
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

