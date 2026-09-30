import { describe, expect, it } from "vitest";
import { evaluateOrganicReel, NormalizedProviderItem, underCreatorCap } from "../src/collectors/organicEligibility";
import { apifyInstagramCanary, normalizeApifyInstagramItem } from "../src/collectors/instagram";
import {
  createProviderRunBudget,
  readProviderCache,
  resetProviderRuntimeForTests,
  tryConsumeProviderRun,
  writeProviderCache,
} from "../src/collectors/providerRuntime";

function item(overrides: Partial<NormalizedProviderItem> = {}): NormalizedProviderItem {
  return {
    id: "1",
    platformId: "abc",
    providerMediaId: "media-1",
    providerCreatorId: "creator-1",
    creatorHandle: "@creator",
    url: "https://www.instagram.com/reel/abc/",
    thumbnailUrl: "",
    caption: "",
    hashtags: [],
    contentType: "reel",
    productType: "clips",
    paidPartnershipFlag: false,
    paginationDepth: 0,
    ...overrides,
  };
}

describe("organic reel eligibility", () => {
  it("drops exact paid hashtags and keeps non-marker substrings", () => {
    expect(evaluateOrganicReel(item({ caption: "Great product #ad" })).dropReason).toBe("paid_marker");
    expect(evaluateOrganicReel(item({ caption: "Great product #Sponsored" })).dropReason).toBe("paid_marker");
    expect(evaluateOrganicReel(item({ caption: "Trail day #adventure #add #नया" })).item).toBeTruthy();
  });

  it("keeps /p/ URLs when provider product type is clips", () => {
    const result = evaluateOrganicReel(
      item({
        url: "https://www.instagram.com/p/abc/",
        contentType: "unknown",
        productType: "clips",
      })
    );

    expect(result.item?.contentType).toBe("reel");
  });

  it("drops carousel and image items and emits drop reasons", () => {
    expect(evaluateOrganicReel(item({ contentType: "carousel", productType: "feed_carousel" })).dropReason).toBe("not_reel");
    expect(evaluateOrganicReel(item({ contentType: "image", productType: "feed_photo" })).dropReason).toBe("not_reel");
  });

  it("normalizes real Apify-style clips rows and canaries expected shape", () => {
    const raw = {
      id: "ig-media-1",
      shortcode: "abc123",
      url: "https://www.instagram.com/p/abc123/",
      productType: "clips",
      ownerUsername: "creator",
      caption: "Demo reel",
      displayUrl: "https://cdn.example/thumb.jpg",
    };

    expect(apifyInstagramCanary(raw).ok).toBe(true);
    const normalized = normalizeApifyInstagramItem(raw);
    expect(normalized?.contentType).toBe("reel");
    expect(evaluateOrganicReel(normalized!).item).toBeTruthy();
  });

  it("enforces a per-creator cap", () => {
    const counts = new Map<string, number>();
    expect(underCreatorCap(item({ providerCreatorId: "creator-a" }), counts, 2)).toBe(true);
    expect(underCreatorCap(item({ providerCreatorId: "creator-a" }), counts, 2)).toBe(true);
    expect(underCreatorCap(item({ providerCreatorId: "creator-a" }), counts, 2)).toBe(false);
  });
});

describe("provider runtime", () => {
  it("cache hits do not consume provider run caps", () => {
    resetProviderRuntimeForTests();
    writeProviderCache("provider:tag:0", [{ id: "cached" }], 10000);
    expect(readProviderCache("provider:tag:0")).toEqual([{ id: "cached" }]);

    const budget = createProviderRunBudget("test-provider", 1);
    expect(tryConsumeProviderRun(budget).ok).toBe(true);
    expect(tryConsumeProviderRun(budget)).toEqual({ ok: false, reason: "per_job_run_cap" });
  });
});
