import { describe, expect, it } from "vitest";
import {
  engagementOrderingByPlatformFor,
  engagementOrderingFor,
  engagementStatus,
  parseEngagementCount,
  rankOrganicVideos,
  rankReels,
  relevanceBucket,
} from "../src/engagement/reels";
import { buildSourceConfigsForSearch } from "../src/jobs/searchQueue";
import { normalizeApifyTikTokItem } from "../src/collectors/tiktok";
import { env } from "../src/lib/env";

describe("reel engagement parsing", () => {
  it("parses zero, comma numbers, compact suffixes, and hidden values", () => {
    expect(parseEngagementCount(0)).toBe(0);
    expect(parseEngagementCount("1,234")).toBe(1234);
    expect(parseEngagementCount("12.4 k")).toBe(12400);
    expect(parseEngagementCount("7.5K")).toBe(7500);
    expect(parseEngagementCount(-1)).toBeUndefined();
    expect(parseEngagementCount("1,2 Mio")).toBeUndefined();
  });

  it("clamps values above 32-bit storage", () => {
    expect(parseEngagementCount("3B")).toBe(2_147_483_647);
  });
});

describe("reel engagement ranking", () => {
  const row = (id: string, label: "match" | "possible" | "discard", score: number, views?: number, likes?: number) => ({
    id,
    label,
    score,
    views,
    likes,
  });

  it("uses deterministic score buckets at floating point edges", () => {
    expect(relevanceBucket(0.149999999)).toBe(3);
    expect(relevanceBucket(0.150000001)).toBe(3);
    expect(relevanceBucket(1)).toBe(20);
    expect(relevanceBucket(2)).toBe(20);
  });

  it("keeps tier and near-equivalent relevance ahead of engagement", () => {
    const ranked = rankReels(
      [
        row("possible-viral", "possible", 0.95, 2_000_000),
        row("match-low", "match", 0.61, 200),
        row("match-high", "match", 0.62, 10_000),
      ],
      7500,
      "enabled"
    );

    expect(ranked.map((item) => item.id)).toEqual(["match-high", "match-low", "possible-viral"]);
  });

  it("falls back at below 60 percent usable views and stays enabled at exactly 60 percent", () => {
    expect(engagementOrderingFor([{ views: 1 }, { views: 2 }, { views: 3 }, {}, {}])).toBe("enabled");
    expect(engagementOrderingFor([{ views: 1 }, { views: 2 }, {}, {}, {}])).toBe("disabled_low_coverage");
  });

  it("derives status from the current floor", () => {
    expect(engagementStatus(7500, 7500)).toBe("high");
    expect(engagementStatus(7499, 7500)).toBe("below_floor");
    expect(engagementStatus(undefined, 7500)).toBe("unknown");
  });

  it("uses platform coverage fallback without globally demoting the fallback platform", () => {
    const rows = [
      { id: "ig-unknown", platform: "instagram", label: "match", score: 0.82, views: undefined },
      { id: "tt-known", platform: "tiktok", label: "match", score: 0.81, views: 1_000_000 },
    ];

    const ranked = rankOrganicVideos(
      rows,
      { instagram: 7500, tiktok: 7500 },
      7500,
      { instagram: "disabled_low_coverage", tiktok: "enabled" }
    );

    expect(ranked.map((row) => row.id)).toEqual(["ig-unknown", "tt-known"]);
  });

  it("computes ordering coverage per platform", () => {
    expect(
      engagementOrderingByPlatformFor([
        { platform: "instagram" },
        { platform: "instagram" },
        { platform: "tiktok", views: 1 },
        { platform: "tiktok", views: 2 },
      ])
    ).toEqual({ instagram: "disabled_low_coverage", tiktok: "enabled" });
  });
});

describe("reels-only source construction", () => {
  it("supports instagram and warns when tiktok config is missing", async () => {
    const previous = { ...env };
    try {
      (env as any).APIFY_API_TOKEN = "";
      (env as any).TIKTOK_ACTOR_ID = "";
      const plan = await buildSourceConfigsForSearch({
        requestedSources: ["instagram", "meta"],
        instagramQueries: ["dress"],
        tiktokQueries: ["dress"],
        metaQueries: ["dress"],
        target: 20,
      });

      expect(plan.sources.map((source) => source.id)).toEqual(["instagram"]);
      expect(plan.sourceWarnings.meta).toBeTruthy();
    } finally {
      Object.assign(env, previous);
    }
  });

  it("enables tiktok when explicitly configured", async () => {
    const previous = { ...env };
    try {
      (env as any).APIFY_API_TOKEN = "token";
      (env as any).TIKTOK_ACTOR_ID = "actor/id";
      const plan = await buildSourceConfigsForSearch({
        requestedSources: [" tiktok "],
        instagramQueries: ["dress"],
        tiktokQueries: ["dress"],
        metaQueries: [],
        target: 20,
      });

      expect(plan.sources.map((source) => source.id)).toEqual(["tiktok"]);
    } finally {
      Object.assign(env, previous);
    }
  });
});

describe("TikTok normalization", () => {
  it("keeps 64-bit video IDs as strings", () => {
    const video = normalizeApifyTikTokItem({
      id: "9007199254740993123",
      webVideoUrl: "https://www.tiktok.com/@creator/video/9007199254740993123",
      desc: "demo",
      playCount: "12.4K",
      diggCount: "1,234",
    });

    expect(video?.platformId).toBe("9007199254740993123");
    expect(video?.views).toBe(12400);
    expect(video?.likes).toBe(1234);
  });
});
