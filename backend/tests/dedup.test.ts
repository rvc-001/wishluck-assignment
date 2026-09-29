import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { Video } from "../src/collectors/types";
import { dedupExact } from "../src/dedup/exact";
import { runDedupPipeline } from "../src/dedup";
import { dedupTextual } from "../src/dedup/textual";
import { filterPreviouslySeen } from "../src/dedup/crossSearch";
import { collectWithRefill } from "../src/jobs/searchQueue";

function video(overrides: Partial<Video>): Video {
  return {
    id: overrides.id ?? randomUUID(),
    platform: overrides.platform ?? "instagram",
    platformId: overrides.platformId ?? randomUUID(),
    url: overrides.url ?? `https://example.com/${randomUUID()}`,
    thumbnailUrl: overrides.thumbnailUrl ?? "",
    caption: overrides.caption ?? "floral midi dress demo",
    author: overrides.author,
    metaPath: overrides.metaPath,
    thumbPHash: overrides.thumbPHash,
    captionSimhash: overrides.captionSimhash,
    embedding: overrides.embedding,
  };
}

describe("deduplication", () => {
  it("exact-id-collision keeps one video for the same platformId", () => {
    const result = dedupExact([
      video({ platform: "instagram", platformId: "abc", url: "https://example.com/a" }),
      video({ platform: "instagram", platformId: "abc", url: "https://example.com/b" }),
    ]);

    expect(result).toHaveLength(1);
  });

  it("url-hash-collision deduplicates different IDs with the same media URL", () => {
    const result = dedupExact([
      video({ platformId: "a", url: "https://cdn.example.com/video.mp4" }),
      video({ platformId: "b", url: "https://cdn.example.com/video.mp4" }),
    ]);

    expect(result).toHaveLength(1);
  });

  it("resized-thumbnail-near-dup removes pHash-near duplicate thumbnails", async () => {
    const result = await runDedupPipeline([
      video({ platformId: "a", thumbPHash: "1111000011110000111100001111000011110000111100001111000011110000" }),
      video({ platformId: "b", thumbPHash: "1111000011110000111100001111000011110000111100001111000011110011" }),
    ]);

    expect(result).toHaveLength(1);
  });

  it("same-ad-different-id-collapse removes same advertiser and creative text", () => {
    const result = dedupTextual([
      video({ platform: "meta", platformId: "a", author: "Brand", caption: "Shop the new floral dress today" }),
      video({ platform: "meta", platformId: "b", author: "Brand", caption: "Shop the new floral dress today" }),
    ]);

    expect(result).toHaveLength(1);
  });

  it("refill-loop-tops-up after initial shortfall", async () => {
    let calls = 0;
    const makeCollector = (platform: "instagram" | "meta") => ({
      collect: async (_queries: string[], opts: { target: number }) => {
        calls++;
        const count = calls <= 2 ? 3 : opts.target;
        return {
          videos: Array.from({ length: count }, (_, i) =>
            video({ platform, platformId: `${platform}-${calls}-${i}` })
          ),
          stats: { got: count, wanted: opts.target, triedQueries: ["fixture"] },
        };
      },
    });

    const result = await collectWithRefill({
      instagram: makeCollector("instagram"),
      meta: makeCollector("meta"),
      instagramQueries: ["dress"],
      metaQueries: ["dress"],
      targetPerSource: 5,
      seenIds: new Set(),
      searchId: "test-search",
      timeBudgetMs: 5000,
    });

    expect(result.length).toBeGreaterThanOrEqual(10);
  });

  it("cross-search-exclusion hides previously seen videos by default", () => {
    const result = filterPreviouslySeen(
      [
        video({ platform: "instagram", platformId: "seen" }),
        video({ platform: "instagram", platformId: "fresh" }),
      ],
      new Set(["instagram:seen"])
    );

    expect(result.map((item) => item.platformId)).toEqual(["fresh"]);
  });

  it("seen-toggle-includes previously seen videos", () => {
    const result = filterPreviouslySeen(
      [
        video({ platform: "instagram", platformId: "seen" }),
        video({ platform: "instagram", platformId: "fresh" }),
      ],
      new Set(["instagram:seen"]),
      true
    );

    expect(result.map((item) => item.platformId)).toEqual(["seen", "fresh"]);
  });
});
