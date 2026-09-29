/**
 * Meta Ad Library Collector (Phase 3B)
 * Tries the official API first; falls back to Apify scraper if < 5 results.
 *
 * RATE LIMIT NOTE (documented per ToS compliance):
 * Official Meta Ad Library API: 200 calls/hour per app
 * Source: https://developers.facebook.com/docs/marketing-api/reference/ads-archive/
 *
 * Fallback: Apify meta-ads-scraper — respects Meta's published rate limits.
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
import { withRetry } from "../lib/utils";

const META_API_VERSION = "v19.0";
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const FALLBACK_ACTOR_ID = "apify~facebook-ads-scraper";

const FALLBACK_TRIGGER_THRESHOLD = 5; // 3B.2 — trigger if official < 5 results

interface MetaAdItem {
  id: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_snapshot_url?: string;
  ad_delivery_start_time?: string;
  impressions?: { lower_bound: string; upper_bound: string };
}

interface ApifyMetaItem {
  error?: string;
  errorDescription?: string;
  totalCount?: number;
  results?: ApifyMetaItem[];
  adArchiveID?: string;
  adId?: string;
  libraryId?: string;
  adUrl?: string;
  pageName?: string;
  page_name?: string;
  pageID?: string;
  advertiserName?: string;
  adText?: string;
  bodyText?: string;
  headline?: string;
  videoUrl?: string;
  videoUrls?: string[];
  videoThumbnailUrls?: string[];
  imageUrls?: string[];
  thumbnail?: string;
  startDate?: string;
  startDateFormatted?: string;
  impressions?: string;
  metaPath?: string;
  snapshot?: {
    body?: { text?: string };
    title?: string;
    linkUrl?: string;
    videos?: Array<{
      videoHdUrl?: string;
      videoSdUrl?: string;
      videoPreviewImageUrl?: string;
      originalVideoUrl?: string;
    }>;
    images?: Array<{
      originalImageUrl?: string;
      resizedImageUrl?: string;
    }>;
    cards?: Array<{
      body?: string;
      title?: string;
      linkUrl?: string;
      originalImageUrl?: string;
      resizedImageUrl?: string;
      videoPreviewImageUrl?: string;
      videoHdUrl?: string;
      videoSdUrl?: string;
    }>;
  };
}

function normalizeMetaOfficial(item: MetaAdItem): Video {
  return {
    id: uuidv4(),
    platform: "meta",
    platformId: item.id,
    url: item.ad_snapshot_url ?? "",
    thumbnailUrl: item.ad_snapshot_url ?? "",
    caption: (item.ad_creative_bodies ?? []).join(" "),
    author: item.page_name,
    metaPath: "official",
    createdAt: item.ad_delivery_start_time,
  };
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function fixtureScope(queries: string[]): string {
  return (queries[0] ?? "fixture").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]+/g, "") || "fixture";
}

function fallbackThumbnail(seed: string): string {
  return "";
}

function pickFallbackVideoUrl(item: ApifyMetaItem): string {
  const snapshot = item.snapshot;
  const video = snapshot?.videos?.[0];
  const cardWithVideo = snapshot?.cards?.find(
    (card) => card.videoHdUrl || card.videoSdUrl || card.videoPreviewImageUrl
  );

  return firstNonEmpty(
    item.videoUrl,
    item.videoUrls?.[0],
    video?.videoHdUrl,
    video?.videoSdUrl,
    video?.originalVideoUrl,
    cardWithVideo?.videoHdUrl,
    cardWithVideo?.videoSdUrl,
    item.adUrl
  );
}

function buildSingleAdLibraryUrl(platformId: string): string {
  if (!platformId) return "";
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("id", platformId);
  return url.toString();
}

function pickFallbackThumbnail(item: ApifyMetaItem): string {
  const snapshot = item.snapshot;
  const video = snapshot?.videos?.[0];
  const card = snapshot?.cards?.[0];
  const image = snapshot?.images?.[0];

  return firstNonEmpty(
    item.thumbnail,
    item.videoThumbnailUrls?.[0],
    item.imageUrls?.[0],
    video?.videoPreviewImageUrl,
    card?.videoPreviewImageUrl,
    card?.originalImageUrl,
    card?.resizedImageUrl,
    image?.originalImageUrl,
    image?.resizedImageUrl
  );
}

function normalizeMetaFallback(item: ApifyMetaItem, index: number): Video | null {
  if (item.error || item.errorDescription) return null;
  const platformId = firstNonEmpty(item.adId, item.adArchiveID, item.libraryId);
  if (!platformId) return null;
  const caption = firstNonEmpty(
    item.adText,
    item.bodyText,
    item.headline,
    item.snapshot?.body?.text,
    item.snapshot?.title,
    item.snapshot?.cards?.[0]?.body,
    item.snapshot?.cards?.[0]?.title
  );

  return {
    id: uuidv4(),
    platform: "meta",
    platformId,
    url: firstNonEmpty(pickFallbackVideoUrl(item), buildSingleAdLibraryUrl(platformId)),
    thumbnailUrl: firstNonEmpty(pickFallbackThumbnail(item), fallbackThumbnail(platformId)),
    caption,
    author: firstNonEmpty(item.advertiserName, item.pageName, item.page_name, item.pageID),
    metaPath: "fallback",
    createdAt: firstNonEmpty(item.startDate, item.startDateFormatted),
  };
}

function expandFixtureVideos(videos: Video[], target: number): Video[] {
  if (videos.length === 0) return videos;
  const expanded: Video[] = [];
  for (let i = 0; expanded.length < target; i++) {
    const base = videos[i % videos.length];
    const suffix = i + 1;
    const uniqueTerms = `uniquefixture${suffix} creative${suffix} audience${suffix} scene${suffix} proof${suffix} offer${suffix} product${suffix} match${suffix}`;
    expanded.push({
      ...base,
      id: uuidv4(),
      platformId: `${base.platformId}-fixture-${suffix}`,
      url: `${base.url}${base.url.includes("?") ? "&" : "?"}fixture=${suffix}`,
      thumbnailUrl: base.thumbnailUrl.replace(/seed\/([^/]+)/, `seed/$1-${suffix}`),
      caption: uniqueTerms,
      metaPath: base.metaPath ?? "fallback",
    });
  }
  return expanded;
}

function buildAdLibraryUrl(query: string): string {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("active_status", "active");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", env.META_FALLBACK_COUNTRY);
  url.searchParams.set("q", query.replace(/^#/, ""));
  url.searchParams.set("media_type", "video");
  return url.toString();
}

export class MetaCollector implements Collector {
  private officialDisabled = false;

  async collect(
    queries: string[],
    opts: CollectorOptions
  ): Promise<CollectorResult> {
    const triedQueries: string[] = [];
    const videos: Video[] = [];
    const localSeen = new Set(opts.seenIds);
    let resolvedMetaPath: "official" | "fallback" = "official";

    // 0.9 — Fixture mode
    if (env.USE_FIXTURES) {
      logger.info("Meta collector: USE_FIXTURES=true, loading fixture data");
      const fixturePath = path.resolve(
        __dirname,
        "../../fixtures/meta-sample.json"
      );
      const raw: ApifyMetaItem[] = JSON.parse(
        fs.readFileSync(fixturePath, "utf-8")
      );
      const normalized = raw
        .map((item, i) => normalizeMetaFallback(item, i))
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
          metaPath: "fallback",
        },
      };
    }

    for (const query of queries) {
      if (videos.length >= opts.target) break;
      triedQueries.push(query);

      // 3B.1 — Try official API first
      let officialResults: Video[] = [];
      if (env.META_ENABLE_OFFICIAL) {
        try {
          officialResults = await this.fetchOfficial(query);
          logger.info(
            { query, count: officialResults.length },
            "Meta official API results"
          );
        } catch (err: any) {
          const status = err?.response?.status ?? err?.status;
          const metaError = err?.response?.data?.error;
          if (metaError?.code === 190 || metaError?.code === 10 || status === 401 || status === 403) {
            this.officialDisabled = true;
          }
          logger.warn(
            {
              query,
              status,
              metaCode: metaError?.code,
              metaSubcode: metaError?.error_subcode,
              message: metaError?.message ?? err?.message,
            },
            "Meta official API failed"
          );
        }
      }

      // 3B.2 — If official < 5, switch to fallback immediately (not lazily)
      let sourcedVideos: Video[];
      if (officialResults.length >= FALLBACK_TRIGGER_THRESHOLD) {
        sourcedVideos = officialResults;
        resolvedMetaPath = "official";
      } else {
        logger.info(
          { query, officialCount: officialResults.length },
          `Meta: official returned < ${FALLBACK_TRIGGER_THRESHOLD} results — switching to fallback`
        );
        resolvedMetaPath = "fallback";
        try {
          sourcedVideos = await withRetry(
            () => this.fetchFallback(query, opts.target - videos.length),
            { maxAttempts: 2, baseDelay: 1500 }
          );
        } catch (err) {
          logger.error({ err, query }, "Meta fallback also failed");
          sourcedVideos = [];
        }
      }

      // 3B.5 — Same-creative collapse (advertiser + caption dedup)
      const creativeSeen = new Set<string>();
      for (const video of sourcedVideos) {
        const creativeKey = `${video.author ?? ""}|${video.caption.slice(0, 100)}`;
        if (creativeSeen.has(creativeKey)) continue;
        creativeSeen.add(creativeKey);

        const seenKey = makeSeenKey("meta", video.platformId);
        if (localSeen.has(seenKey)) continue;
        localSeen.add(seenKey);

        videos.push(video);
        if (videos.length >= opts.target) break;
      }
    }

    return {
      videos,
      stats: {
        got: videos.length,
        wanted: opts.target,
        triedQueries,
        metaPath: resolvedMetaPath,
      },
    };
  }

  private async fetchOfficial(query: string): Promise<Video[]> {
    if (!env.META_ENABLE_OFFICIAL) {
      return [];
    }

    if (this.officialDisabled) {
      return [];
    }

    if (!env.META_AD_LIBRARY_ACCESS_TOKEN) {
      logger.warn("META_AD_LIBRARY_ACCESS_TOKEN not set — skipping official API");
      return [];
    }

    const resp = await axios.get(`${META_API_BASE}/ads_archive`, {
      params: {
        access_token: env.META_AD_LIBRARY_ACCESS_TOKEN,
        ad_type: "ALL",
        search_terms: query.replace(/^#/, ""),
        ad_reached_countries: JSON.stringify([env.META_FALLBACK_COUNTRY]),
        fields:
          "id,page_name,ad_creative_bodies,ad_snapshot_url,ad_delivery_start_time,impressions",
        limit: 50,
      },
      timeout: 10000,
    });

    const items: MetaAdItem[] = resp.data?.data ?? [];
    return items.map(normalizeMetaOfficial);
  }

  private async fetchFallback(query: string, limit: number): Promise<Video[]> {
    if (!env.APIFY_API_TOKEN) {
      logger.warn("APIFY_API_TOKEN not set — Meta fallback unavailable");
      return [];
    }

    const adLibraryUrl = buildAdLibraryUrl(query);
    const runResp = await axios.post(
      `https://api.apify.com/v2/acts/${FALLBACK_ACTOR_ID}/runs`,
      {
        startUrls: [{ url: adLibraryUrl }],
        resultsLimit: Math.min(limit, 50),
        activeStatus: "active",
      },
      {
        headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
        timeout: 30000,
      }
    );

    const runId: string = runResp.data.data.id;
    logger.info({ runId, query, limit }, "Apify Meta fallback actor started");

    // Poll for completion. Keep this bounded so sparse ad searches do not stall the UI.
    let status = "READY";
    let attempts = 0;
    while ((status === "READY" || status === "RUNNING") && attempts < env.META_FALLBACK_MAX_POLLS) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` } }
      );
      status = s.data.data.status;
      attempts++;
    }

    if (status !== "SUCCEEDED") {
      logger.warn({ query, runId, status }, "Meta fallback finished without SUCCEEDED status");
    }

    const datasetResp = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items`,
      {
        headers: { Authorization: `Bearer ${env.APIFY_API_TOKEN}` },
        params: { clean: true, limit },
      }
    );

    const rows: ApifyMetaItem[] = datasetResp.data;
    const items = rows.flatMap((item) => (Array.isArray(item.results) ? item.results : [item]));
    return items
      .map((item, i) => normalizeMetaFallback(item, i))
      .filter((video): video is Video => video !== null);
  }
}
