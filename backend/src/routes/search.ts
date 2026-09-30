import { Router, Request, Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getSearchQueue, processSearchJob } from "../jobs/searchQueue";
import { logger } from "../lib/logger";
import { getSearchEvents, subscribeSearchEvents } from "../jobs/progressEvents";
import { env } from "../lib/env";
import {
  aboveFloorCount,
  engagementOrderingByPlatformFor,
  engagementStatus,
  floorForPlatform,
  rankOrganicVideos,
} from "../engagement/reels";

const router = Router();

function parseAttributesJson(value?: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractUrlFromText(value: string): string {
  const markdownMatch = value.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i);
  if (markdownMatch?.[1]) return markdownMatch[1].replace(/\\&/g, "&");

  const rawUrlMatch = value.match(/https?:\/\/[^\s)]+/i);
  if (rawUrlMatch?.[0]) return rawUrlMatch[0].replace(/\\&/g, "&");

  return value.trim();
}

function isSocialVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host.includes("instagram.com") ||
      host.includes("tiktok.com") ||
      host.includes("youtube.com") ||
      host.includes("youtu.be")
    );
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function platformFloors(): Record<string, number> {
  return {
    instagram: env.MIN_INSTAGRAM_VIEWS,
    tiktok: env.MIN_TIKTOK_VIEWS,
  };
}

function isOrganicVideoRow(row: any): boolean {
  if (row.video?.sourceKind !== "organic") return false;
  if (row.video?.platform === "instagram") return row.video?.contentType === "reel";
  if (row.video?.platform === "tiktok") return row.video?.contentType === "video";
  return false;
}

function rankedResponseRows(rows: any[]) {
  const eligible = rows.filter(isOrganicVideoRow);
  const orderingByPlatform = engagementOrderingByPlatformFor(eligible.map((row) => row.video));
  const ordering: "enabled" | "disabled_low_coverage" = Object.values(orderingByPlatform).length > 0 && Object.values(orderingByPlatform).every((value) => value === "enabled")
    ? "enabled"
    : "disabled_low_coverage";
  const floors = platformFloors();
  const ranked = rankOrganicVideos(
    eligible.map((row) => ({
      row,
      platform: row.video.platform,
      score: row.score,
      label: row.label,
      views: row.video.views,
      likes: row.video.likes,
    })),
    floors,
    env.MIN_VIDEO_VIEWS,
    orderingByPlatform
  ).slice(0, env.TARGET_RESULTS * Math.max(1, Object.keys(orderingByPlatform).length));
  return { rows: ranked.map((item) => item.row), ordering, orderingByPlatform, floors };
}

function serializeResult(row: any, engagementOrdering: "enabled" | "disabled_low_coverage", floors = platformFloors()) {
  return {
    id: row.videoId,
    videoId: row.videoId,
    platform: row.video.platform,
    platformId: row.video.platformId,
    url: row.video.url,
    thumbnailUrl: row.video.thumbnailUrl,
    caption: row.video.caption,
    score: row.score,
    label: row.label,
    reason: row.reason,
    metaPath: row.video.metaPath,
    contentType: row.video.contentType ?? "unknown",
    sourceKind: row.video.sourceKind ?? "unknown",
    isPaidPartnership: row.video.isPaidPartnership ?? false,
    paidMarkerDetected: row.video.paidMarkerDetected,
    dropReason: row.video.dropReason,
    views: row.video.views ?? undefined,
    likes: row.video.likes ?? undefined,
    engagementFetchedAt: row.video.engagementFetchedAt?.toISOString?.() ?? row.video.engagementFetchedAt,
    engagementStatus: engagementStatus(row.video.views, floorForPlatform(row.video.platform, floors, env.MIN_VIDEO_VIEWS)),
    engagementOrdering,
    shortlisted: row.shortlisted,
  };
}

function engagementSummaryByPlatform(rows: Array<{ platform: string; views?: number | null }>, floors = platformFloors()) {
  const byPlatform = new Map<string, Array<{ views?: number | null }>>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }
  return Object.fromEntries([...byPlatform.entries()].map(([platform, items]) => {
    const floor = floorForPlatform(platform, floors, env.MIN_VIDEO_VIEWS);
    return [platform, { aboveFloor: aboveFloorCount(items, floor), shown: items.length, floor }];
  }));
}

function qualityNoticeFor(params: {
  results: Array<{ label?: string; score?: number; engagementStatus?: string; reason?: string }>;
  targetResults: number;
  sourceWarnings?: Record<string, string[]>;
}) {
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

// ─── Input validation schema (Phase 1.1) ─────────────────────────────────────
const SearchInputSchema = z.discriminatedUnion("queryType", [
  z.object({
    queryType: z.literal("keyword"),
    query: z.string().min(1).max(200),
    showSeen: z.boolean().optional(),
  }),
  z.object({
    queryType: z.literal("url"),
    query: z.string().url("Must be a valid URL"),
    showSeen: z.boolean().optional(),
  }),
  z.object({
    queryType: z.literal("image"),
    query: z.string().optional(),
    imageFile: z.string().min(1, "imageFile base64 required for image type"),
    showSeen: z.boolean().optional(),
  }),
]);

// ─── POST /api/search ─────────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  const body =
    typeof req.body?.query === "string"
      ? (() => {
          const query = extractUrlFromText(req.body.query);
          return {
            ...req.body,
            query,
            queryType: req.body.queryType === "keyword" && isHttpUrl(query) ? "url" : req.body.queryType,
          };
        })()
      : req.body;

  const parsed = SearchInputSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid input",
        hint: parsed.error.flatten().formErrors.join("; ") ||
          Object.entries(parsed.error.flatten().fieldErrors)
            .map(([field, msgs]) => `${field}: ${(msgs ?? []).join(", ")}`)
            .join("; "),
      },
    });
  }

  if (parsed.data.queryType === "url" && isSocialVideoUrl(parsed.data.query)) {
    return res.status(400).json({
      error: {
        code: "UNSUPPORTED_URL",
        message: "Social video URLs are not product page URLs",
        hint: "Search by the product name instead, or paste a product page URL with a product image.",
      },
    });
  }

  const { queryType, query } = parsed.data as {
    queryType: string;
    query?: string;
    imageFile?: string;
    showSeen?: boolean;
  };
  const imageFile = (parsed.data as { imageFile?: string }).imageFile;
  const showSeen = (parsed.data as { showSeen?: boolean }).showSeen ?? false;

  const searchId = uuidv4();
  
  // Phase 5: Create the search record in DB so worker can update it
  const { getPrisma } = await import("../lib/prisma");
  await getPrisma().search.create({
    data: {
      id: searchId,
      query: query ?? "",
      queryType: queryType,
      productTitle: "", // filled in by worker
      imageUrl: "", // filled in by worker
      status: "running"
    }
  });

  const jobData = {
    searchId,
    query: query ?? "",
    queryType: queryType as "keyword" | "url" | "image",
    imageFile,
    showSeen,
  };

  logger.info(
    {
      searchId,
      queryType,
      query,
      queueMode: env.QUEUE_MODE,
      searchSources: env.SEARCH_SOURCES,
      enableTikTok: env.ENABLE_TIKTOK,
      hasTikTokActorId: Boolean(env.TIKTOK_ACTOR_ID),
      hasApifyToken: Boolean(env.APIFY_API_TOKEN),
    },
    "Search request accepted"
  );

  if (env.QUEUE_MODE === "inline") {
    void processSearchJob(jobData).catch((err) =>
      logger.error({ err, searchId }, "Inline search job failed")
    );
  } else {
    const queue = getSearchQueue();
    await queue.add("search", jobData);
  }

  logger.info({ searchId, queryType, query }, "Search job enqueued");

  return res.status(202).json({ searchId });
});

// ─── GET /api/search/:id (poll results) ──────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { getPrisma } = await import("../lib/prisma");
  const prisma = getPrisma();

  const search = await prisma.search.findUnique({
    where: { id },
    include: {
      results: {
        include: {
          video: true,
        },
        orderBy: { score: "desc" },
      }
    }
  }) as any;

  if (!search) {
    return res.status(404).json({ error: "Search not found" });
  }

  const ranked = rankedResponseRows(search.results);
  const serializedResults = ranked.rows.map((row: any) => serializeResult(row, ranked.ordering, ranked.floors));

  return res.json({
    contractVersion: 1,
    searchId: id,
    status: search.status === "completed" ? "done" : search.status,
    results: serializedResults,
    targetResults: env.TARGET_RESULTS,
    engagementOrdering: ranked.ordering,
    engagementOrderingByPlatform: ranked.orderingByPlatform,
    engagementSummary: {
      aboveFloor: aboveFloorCount(serializedResults, env.MIN_VIDEO_VIEWS),
      shown: serializedResults.length,
      floor: env.MIN_VIDEO_VIEWS,
    },
    engagementSummaryByPlatform: engagementSummaryByPlatform(serializedResults, ranked.floors),
    qualityNotice: qualityNoticeFor({ results: serializedResults, targetResults: env.TARGET_RESULTS }),
    sourceKinds: Object.fromEntries(Array.from(new Set(serializedResults.map((row: any) => row.platform))).map((platform) => [platform, "organic"])),
    productInfo: {
      title: search.productTitle,
      imageUrl: search.imageUrl,
      attributes: parseAttributesJson(search.attributesJson),
    },
  });
});

const ShortlistInputSchema = z.object({
  searchId: z.string().min(1),
  videoIds: z.array(z.string()).default([]),
});

router.post("/../shortlist", async (req: Request, res: Response) => {
  const parsed = ShortlistInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid shortlist payload",
        hint: "Send { searchId, videoIds: [] }.",
      },
    });
  }

  const { searchId, videoIds } = parsed.data;
  const { getPrisma } = await import("../lib/prisma");
  const prisma = getPrisma();
  const wanted = new Set(videoIds);

  const rows = await prisma.searchResult.findMany({
    where: { searchId },
    select: { videoId: true, video: { select: { platformId: true } } },
  });

  await Promise.all(
    rows.map((row) =>
      prisma.searchResult.update({
        where: { searchId_videoId: { searchId, videoId: row.videoId } },
        data: { shortlisted: wanted.has(row.videoId) || wanted.has(row.video.platformId) },
      })
    )
  );

  return res.json({ ok: true, count: rows.filter((row) => wanted.has(row.videoId) || wanted.has(row.video.platformId)).length });
});

router.get("/../shortlist/export", async (req: Request, res: Response) => {
  const searchId = String(req.query.searchId ?? "");
  const format = String(req.query.format ?? "json").toLowerCase();
  if (!searchId) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Missing searchId",
        hint: "Use /api/shortlist/export?searchId=<id>&format=csv or json.",
      },
    });
  }

  const { getPrisma } = await import("../lib/prisma");
  const rows = await getPrisma().searchResult.findMany({
    where: { searchId, shortlisted: true },
    include: { video: true },
    orderBy: { score: "desc" },
  });

  const ranked = rankedResponseRows(rows);
  const payload = ranked.rows.map((row) => ({
    platform: row.video.platform,
    platformId: row.video.platformId,
    url: row.video.url,
    thumbnailUrl: row.video.thumbnailUrl,
    caption: row.video.caption,
    score: row.score,
    label: row.label,
    reason: row.reason,
    metaPath: row.video.metaPath,
    contentType: (row.video as any).contentType ?? "unknown",
    sourceKind: (row.video as any).sourceKind ?? (row.video.platform === "meta" ? "ads" : "unknown"),
    isPaidPartnership: (row.video as any).isPaidPartnership ?? false,
    paidMarkerDetected: (row.video as any).paidMarkerDetected,
    dropReason: (row.video as any).dropReason,
    views: (row.video as any).views ?? "",
    likes: (row.video as any).likes ?? "",
    engagementFetchedAt: (row.video as any).engagementFetchedAt?.toISOString?.() ?? (row.video as any).engagementFetchedAt ?? "",
    engagementStatus: engagementStatus((row.video as any).views, floorForPlatform(row.video.platform, ranked.floors, env.MIN_VIDEO_VIEWS)),
    engagementOrdering: ranked.ordering,
  }));

  if (format === "csv") {
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const header = ["platform", "platformId", "url", "thumbnailUrl", "caption", "score", "label", "reason", "metaPath", "contentType", "sourceKind", "isPaidPartnership", "paidMarkerDetected", "dropReason", "views", "likes", "engagementFetchedAt", "engagementStatus", "engagementOrdering"];
    const lines = [
      header.join(","),
      ...payload.map((row) => header.map((key) => escape(row[key as keyof typeof row])).join(",")),
    ];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="wishluck-shortlist-${searchId}.csv"`);
    return res.send(lines.join("\n"));
  }

  res.setHeader("Content-Disposition", `attachment; filename="wishluck-shortlist-${searchId}.json"`);
  return res.json({ searchId, videos: payload });
});

// ─── GET /api/search/:id/events (SSE stream) ──────────────────────────────────
router.get("/:id/events", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const id = String(req.params.id);
  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let alreadyTerminal = false;
  for (const event of getSearchEvents(id)) {
    send(event);
    if (event.stage === "done" || event.stage === "error") alreadyTerminal = true;
  }
  if (alreadyTerminal) {
    res.end();
    return;
  }

  const unsubscribe = subscribeSearchEvents(id, (event) => {
    send(event);
    if ("stage" in event && (event.stage === "done" || event.stage === "error")) {
      unsubscribe();
      res.end();
    }
  });

  req.on("close", () => {
    unsubscribe();
  });
});

// ─── GET /api/history ─────────────────────────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  const page = parseInt((req.query.page as string) ?? "1", 10);
  const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 100);
  const { getPrisma } = await import("../lib/prisma");
  const prisma = getPrisma();
  const [searches, total] = await Promise.all([
    prisma.search.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        query: true,
        queryType: true,
        productTitle: true,
        imageUrl: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.search.count(),
  ]);
  return res.json({ searches, page, limit, total });
});

export default router;
