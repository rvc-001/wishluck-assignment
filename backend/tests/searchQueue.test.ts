import { describe, expect, it } from "vitest";
import { collectWithRefill } from "../src/jobs/searchQueue";
import { CollectorResult } from "../src/collectors/types";

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

describe("collectWithRefill", () => {
  it("does not repeat scraper queries across refill attempts", async () => {
    const instagramQueries: string[] = [];
    const metaQueries: string[] = [];

    await collectWithRefill({
      instagram: emptyCollector(instagramQueries),
      meta: emptyCollector(metaQueries),
      instagramQueries: ["oneplusbuds"],
      metaQueries: ["oneplus buds"],
      targetPerSource: 2,
      seenIds: new Set(),
      searchId: "test-search",
      timeBudgetMs: 5000,
    });

    expect(instagramQueries.length).toBeGreaterThan(1);
    expect(metaQueries.length).toBeGreaterThan(1);
    expect(new Set(instagramQueries).size).toBe(instagramQueries.length);
    expect(new Set(metaQueries).size).toBe(metaQueries.length);
  });
});
