import { describe, expect, it } from "vitest";
import { buildInstagramHashtagQueries, collectWithRefill, dedupWithSourceRefill, SourceCollectorConfig } from "../src/jobs/searchQueue";
import { CollectorResult, Video } from "../src/collectors/types";
import { randomUUID } from "crypto";

function emptyCollector(seenQueries: string[]) {
  return {
    collect: async (
      queries: string[],
      opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }
    ): Promise<CollectorResult> => {
      void opts;
      seenQueries.push(...queries);
      return {
        videos: [],
        stats: {
          got: 0,
          wanted: 0,
          triedQueries: queries,
        },
      };
    },
  };
}

function source(id: Video["platform"], seenQueries: string[]): SourceCollectorConfig {
  return {
    id,
    label: id,
    kind: id === "meta" ? "ads" : "organic",
    collector: emptyCollector(seenQueries),
    queries: id === "instagram" ? ["oneplusbuds"] : ["oneplus buds"],
    target: 2,
  };
}

function video(platform: Video["platform"], platformId = randomUUID()): Video {
  return {
    id: randomUUID(),
    platform,
    platformId,
    providerMediaId: platformId,
    url: `https://example.com/${platformId}`,
    thumbnailUrl: "",
    caption: "",
    contentType: platform === "instagram" ? "reel" : "video",
    sourceKind: platform === "meta" ? "ads" : "organic",
  };
}

describe("collectWithRefill", () => {
  it("builds realistic Instagram hashtag queries from long product keywords", () => {
    const queries = buildInstagramHashtagQueries(
      ["Smart Readers TM Early Learning Study Ebook WishLuck"],
      8
    );

    expect(queries).toEqual([
      "smartreaders",
      "readersearly",
      "earlylearning",
      "learningstudy",
      "studyebook",
      "ebookwishluck",
      "smart",
      "readers",
    ]);
    expect(queries).toContain("earlylearning");
    expect(queries).not.toContain("kidsbooks");
    expect(queries).not.toContain("educationaltoys");
    expect(queries).not.toContain("smartreaderstmearlylearningstudyebookwishluck");
    expect(queries.every((query) => query.length <= 30)).toBe(true);
  });

  it("does not synthesize scraper queries across refill attempts", async () => {
    const instagramQueries: string[] = [];
    const metaQueries: string[] = [];

    await collectWithRefill({
      sources: [source("instagram", instagramQueries), source("meta", metaQueries)],
      seenIds: new Set(),
      searchId: "test-search",
      timeBudgetMs: 5000,
    });

    expect(instagramQueries).toEqual(["oneplusbuds"]);
    expect(metaQueries).toEqual(["oneplus buds", "oneplusbuds"]);
  });

  it("does not call meta collector when default source list only includes instagram", async () => {
    const instagramQueries: string[] = [];
    const metaQueries: string[] = [];

    const result = await collectWithRefill({
      sources: [
        {
          ...source("instagram", instagramQueries),
          collector: {
            collect: async () => ({
              videos: [video("instagram", "ig-1")],
              stats: { got: 1, wanted: 1, triedQueries: ["oneplusbuds"] },
            }),
          },
          target: 1,
        },
      ],
      seenIds: new Set(),
      searchId: "test-search",
      timeBudgetMs: 5000,
    });

    expect(result.videos.map((item) => item.platform)).toEqual(["instagram"]);
    expect(metaQueries).toHaveLength(0);
  });

  it("post-dedup refill stops cleanly when provider run cap was already hit", async () => {
    let calls = 0;
    const result = await dedupWithSourceRefill({
      rawVideos: [],
      sources: [
        {
          id: "instagram",
          label: "Instagram",
          kind: "organic",
          queries: ["dress"],
          target: 2,
          collector: {
            collect: async () => {
              calls++;
              return {
                videos: [video("instagram", `ig-${calls}`)],
                stats: { got: 1, wanted: 2, triedQueries: ["dress"] },
              };
            },
          },
        },
      ],
      seenIds: new Set(),
      searchId: "test-search",
      timeBudgetMs: 5000,
      runDedup: async (videos) => videos,
      dropReasons: { per_job_run_cap: 1 },
    });

    expect(calls).toBe(0);
    expect(result.status).toBe("partial");
    expect(result.dropReasons.per_job_run_cap).toBe(1);
  });
});
