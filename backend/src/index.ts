import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "./lib/env";
import { validateStartupConfig } from "./lib/env";
import { logger } from "./lib/logger";
import { getRedis } from "./lib/redis";
import { startSearchWorker } from "./jobs/searchQueue";
import searchRoutes from "./routes/search";

const app = express();

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json({ limit: "10mb" }));
app.use(pinoHttp({ logger, autoLogging: false }));

// ─── Rate limiting (Phase 5) ──────────────────────────────────────────────────
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
      hint: "Max 30 search requests per minute",
    },
  },
});

// ─── Health check (Phase 0.4) ─────────────────────────────────────────────────
async function healthPayload() {
  let redisOk = false;
  try {
    const redis = getRedis();
    await redis.ping();
    redisOk = true;
  } catch {
    /* Redis may not be running in dev without Docker */
  }

  let instagramProviderShape: "ok" | "warning" = "ok";
  try {
    const { apifyInstagramCanary } = await import("./collectors/instagram");
    const fixturePath = path.resolve(__dirname, "../fixtures/instagram-sample.json");
    const rows = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
    instagramProviderShape = apifyInstagramCanary(rows[0]).ok ? "ok" : "warning";
  } catch {
    instagramProviderShape = "warning";
  }

  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    redis: redisOk ? "connected" : "unavailable",
    queueMode: env.QUEUE_MODE,
    useFixtures: env.USE_FIXTURES,
    sources: env.SEARCH_SOURCES,
    targetResults: env.TARGET_RESULTS,
    instagramProviderShape,
  };
}

app.get("/health", async (_req, res) => {
  res.json(await healthPayload());
});

app.get("/api/health", async (_req, res) => {
  res.json(await healthPayload());
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/search", searchLimiter, searchRoutes);

app.get("/api/history", async (req, res, next) => {
  try {
    const page = parseInt(String(req.query.page ?? "1"), 10);
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
    const { getPrisma } = await import("./lib/prisma");
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
    res.json({ searches, page, limit, total });
  } catch (err) {
    next(err);
  }
});

const ShortlistInputSchema = z.object({
  searchId: z.string().min(1),
  videoIds: z.array(z.string()).default([]),
});

app.post("/api/shortlist", async (req, res, next) => {
  try {
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
    const wanted = new Set(videoIds);
    const { getPrisma } = await import("./lib/prisma");
    const prisma = getPrisma();

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

    res.json({
      ok: true,
      count: rows.filter((row) => wanted.has(row.videoId) || wanted.has(row.video.platformId)).length,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/shortlist/export", async (req, res, next) => {
  try {
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

    const { getPrisma } = await import("./lib/prisma");
    const rows = await getPrisma().searchResult.findMany({
      where: { searchId, shortlisted: true },
      include: { video: true },
      orderBy: { score: "desc" },
    });

    const payload = rows.map((row) => ({
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
    }));

    if (format === "csv") {
      const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
      const header = ["platform", "platformId", "url", "thumbnailUrl", "caption", "score", "label", "reason", "metaPath", "contentType", "sourceKind", "isPaidPartnership", "paidMarkerDetected", "dropReason"] as const;
      const lines = [
        header.join(","),
        ...payload.map((row) => header.map((key) => escape(row[key])).join(",")),
      ];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="wishluck-shortlist-${searchId}.csv"`);
      return res.send(lines.join("\n"));
    }

    res.setHeader("Content-Disposition", `attachment; filename="wishluck-shortlist-${searchId}.json"`);
    return res.json({ searchId, videos: payload });
  } catch (err) {
    next(err);
  }
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        hint: "Check server logs for details",
      },
    });
  }
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  validateStartupConfig();
  // Start BullMQ worker (Phase 0.8)
  try {
    const worker = startSearchWorker();
    logger.info(worker ? "BullMQ worker started" : "Inline queue mode active");
  } catch (err) {
    logger.warn({ err }, "BullMQ worker failed to start (Redis unavailable?) — continuing without queue");
  }

  app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, useFixtures: env.USE_FIXTURES },
      `Backend server running on http://localhost:${env.PORT}`
    );
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

export default app;
