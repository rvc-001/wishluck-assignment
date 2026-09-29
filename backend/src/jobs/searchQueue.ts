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
  const broadTerms = ["review", "unboxing", "demo", "style", "product"];
  return uniqueQueries([
    ...baseQueries.map((query) => `${query} ${broadTerms[(attempt - 1) % broadTerms.length]}`),
    ...baseQueries,
  ]).slice(0, 4);
}

export async function collectWithRefill(params: {
  instagram: { collect: (queries: string[], opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }) => Promise<CollectorResult> };
  meta: { collect: (queries: string[], opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }) => Promise<CollectorResult> };
  instagramQueries: string[];
  metaQueries: string[];
  targetPerSource: number;
  seenIds: Set<string>;
  searchId: string;
  timeBudgetMs: number;
}): Promise<Video[]> {
  const started = Date.now();
  const rawVideos: Video[] = [];
  const attemptedInstagramQueries = new Set<string>();
  const attemptedMetaQueries = new Set<string>();
  let attempts = 0;

  while (attempts < 10 && Date.now() - started < params.timeBudgetMs) {
    const instagramMissing = Math.max(0, params.targetPerSource - platformCount(rawVideos, "instagram"));
    const metaMissing = Math.max(0, params.targetPerSource - platformCount(rawVideos, "meta"));
    if (instagramMissing === 0 && metaMissing === 0) break;

    const timeLeft = Math.max(1000, params.timeBudgetMs - (Date.now() - started));
    const igQueries = nextQueryBatch(params.instagramQueries, attempts).filter((query) => {
      if (attemptedInstagramQueries.has(query)) return false;
      attemptedInstagramQueries.add(query);
      return true;
    });
    const metaQueries = nextQueryBatch(params.metaQueries, attempts).filter((query) => {
      if (attemptedMetaQueries.has(query)) return false;
      attemptedMetaQueries.add(query);
      return true;
    });

    if (igQueries.length === 0 && metaQueries.length === 0) break;

    const [igRes, metaRes] = await Promise.allSettled([
      igQueries.length > 0 && instagramMissing > 0
        ? params.instagram.collect(igQueries, {
            target: instagramMissing,
            seenIds: params.seenIds,
            timeBudgetMs: timeLeft,
          })
        : Promise.resolve({ videos: [], stats: { got: 0, wanted: instagramMissing, triedQueries: [] } } satisfies CollectorResult),
      metaQueries.length > 0 && metaMissing > 0
        ? params.meta.collect(metaQueries, {
            target: metaMissing,
            seenIds: params.seenIds,
            timeBudgetMs: timeLeft,
          })
        : Promise.resolve({ videos: [], stats: { got: 0, wanted: metaMissing, triedQueries: [] } } satisfies CollectorResult),
    ]);

    if (igRes.status === "fulfilled") {
      const videos = filterPreviouslySeen(igRes.value.videos, params.seenIds);
      rawVideos.push(...videos);
      appendSeenIds(params.seenIds, videos);
      emitSearchEvent(params.searchId, {
        stage: "collect",
        status: "progress",
        source: "instagram",
        got: rawVideos.filter((video) => video.platform === "instagram").length,
        wanted: params.targetPerSource,
      });
    }

    if (metaRes.status === "fulfilled") {
      const videos = filterPreviouslySeen(metaRes.value.videos, params.seenIds);
      rawVideos.push(...videos);
      appendSeenIds(params.seenIds, videos);
      emitSearchEvent(params.searchId, {
        stage: "collect",
        status: "progress",
        source: "meta",
        got: rawVideos.filter((video) => video.platform === "meta").length,
        wanted: params.targetPerSource,
      });
    }

    if (
      platformCount(rawVideos, "instagram") >= params.targetPerSource &&
      platformCount(rawVideos, "meta") >= params.targetPerSource
    ) break;
    attempts++;
  }

  emitSearchEvent(params.searchId, {
    stage: "collect",
    status: "done",
    got: rawVideos.length,
    wanted: params.targetPerSource * 2,
    shortfall: Math.max(0, params.targetPerSource * 2 - rawVideos.length),
  });

  return rawVideos;
}

export async function dedupWithSourceRefill(params: {
  rawVideos: Video[];
  instagram: { collect: (queries: string[], opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }) => Promise<CollectorResult> };
  meta: { collect: (queries: string[], opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }) => Promise<CollectorResult> };
  instagramQueries: string[];
  metaQueries: string[];
  targetPerSource: number;
  seenIds: Set<string>;
  searchId: string;
  timeBudgetMs: number;
  runDedup: (videos: Video[]) => Promise<Video[]>;
}): Promise<Video[]> {
  const started = Date.now();
  let rawVideos = params.rawVideos;
  let dedupedVideos = await params.runDedup(rawVideos);
  let attempts = 0;

  while (attempts < 5 && Date.now() - started < params.timeBudgetMs) {
    const instagramMissing = Math.max(0, params.targetPerSource - platformCount(dedupedVideos, "instagram"));
    const metaMissing = Math.max(0, params.targetPerSource - platformCount(dedupedVideos, "meta"));
    if (instagramMissing === 0 && metaMissing === 0) break;

    emitSearchEvent(params.searchId, {
      stage: "collect",
      status: "progress",
      source: "post-dedup-refill",
      got: dedupedVideos.length,
      wanted: params.targetPerSource * 2,
      shortfall: instagramMissing + metaMissing,
    });

    const timeLeft = Math.max(1000, params.timeBudgetMs - (Date.now() - started));
    const [igRefill, metaRefill] = await Promise.allSettled([
      instagramMissing > 0
        ? params.instagram.collect(nextQueryBatch(params.instagramQueries, attempts + 1), {
            target: instagramMissing,
            seenIds: params.seenIds,
            timeBudgetMs: timeLeft,
          })
        : Promise.resolve({ videos: [], stats: { got: 0, wanted: 0, triedQueries: [] } } satisfies CollectorResult),
      metaMissing > 0
        ? params.meta.collect(nextQueryBatch(params.metaQueries, attempts + 1), {
            target: metaMissing,
            seenIds: params.seenIds,
            timeBudgetMs: timeLeft,
          })
        : Promise.resolve({ videos: [], stats: { got: 0, wanted: 0, triedQueries: [] } } satisfies CollectorResult),
    ]);

    const refill = [
      ...(igRefill.status === "fulfilled" ? filterPreviouslySeen(igRefill.value.videos, params.seenIds) : []),
      ...(metaRefill.status === "fulfilled" ? filterPreviouslySeen(metaRefill.value.videos, params.seenIds) : []),
    ];
    appendSeenIds(params.seenIds, refill);

    rawVideos = [...rawVideos, ...refill];
    dedupedVideos = await params.runDedup(rawVideos);
    attempts++;
  }

  return [
    ...dedupedVideos.filter((video) => video.platform === "instagram").slice(0, params.targetPerSource),
    ...dedupedVideos.filter((video) => video.platform === "meta").slice(0, params.targetPerSource),
    ...dedupedVideos.filter((video) => video.platform !== "instagram" && video.platform !== "meta"),
  ];
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
            ? uniqueQueries([effectiveQuery, ...brainData.attributes.searchQueries]).slice(0, Math.max(1, env.KEYWORD_INSTAGRAM_QUERIES))
            : uniqueQueries(brainData.attributes.searchQueries).slice(0, Math.max(1, env.KEYWORD_INSTAGRAM_QUERIES));
        const metaQueries =
          treatAsKeyword
            ? [effectiveQuery]
            : uniqueQueries([product.title, ...brainData.attributes.adKeywords]).slice(0, 2);

        logger.info({ instagramQueries, metaQueries }, "Collector query plan");

        const igCollector = new InstagramCollector();
        const metaCollector = new MetaCollector();
        const seenIds = showSeen ? new Set<string>() : await getPreviouslySeenIds();

        let rawVideos = await collectWithRefill({
          instagram: igCollector,
          meta: metaCollector,
          instagramQueries,
          metaQueries,
          targetPerSource: 20,
          seenIds,
          searchId,
          timeBudgetMs: 60000,
        });

        await updateProgress(60);

        // --- PHASE 4: DEDUPLICATION ---
        const { runDedupPipeline } = await import("../dedup");
        const dedupedVideos = await dedupWithSourceRefill({
          rawVideos,
          instagram: igCollector,
          meta: metaCollector,
          instagramQueries,
          metaQueries,
          targetPerSource: 20,
          seenIds,
          searchId,
          timeBudgetMs: 60000,
          runDedup: runDedupPipeline,
        });
        emitSearchEvent(searchId, {
          stage: "dedup",
          status: "done",
          before: rawVideos.length,
          after: dedupedVideos.length,
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
          stage: "score",
          status: "done",
          scored: scoredResults.length,
          total: dedupedVideos.length,
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
          const dbVideo = await prisma.video.upsert({
            where: {
              platform_platformId: { platform: video.platform, platformId: video.platformId }
            },
            update: {
              metaPath: video.metaPath,
              thumbnailUrl: video.thumbnailUrl,
              caption: video.caption,
              thumbPHash: video.thumbPHash ?? "",
              captionSimhash: video.captionSimhash ?? "",
            },
            create: {
              platform: video.platform,
              platformId: video.platformId,
              url: video.url,
              thumbnailUrl: video.thumbnailUrl,
              caption: video.caption,
              urlHash: video.urlHash || sha256(normalizeUrl(video.url || `${video.platform}:${video.platformId}`)),
              thumbPHash: video.thumbPHash ?? "",
              captionSimhash: video.captionSimhash ?? "",
              embedding: Buffer.from(JSON.stringify(video.embedding ?? [])),
              metaPath: video.metaPath,
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
          }];
        });
        emitSearchEvent(searchId, {
          stage: "done",
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

