import { Video } from "./types";

export interface NormalizedProviderItem {
  id: string;
  platformId: string;
  providerMediaId?: string;
  providerCreatorId?: string;
  creatorHandle?: string;
  url: string;
  thumbnailUrl: string;
  caption: string;
  hashtags: string[];
  contentType: Video["contentType"];
  productType?: string;
  paidPartnershipFlag?: boolean;
  likes?: number;
  views?: number;
  createdAt?: string;
  paginationDepth: number;
}

export interface EligibilityResult {
  item?: NormalizedProviderItem;
  dropReason?: string;
  paidMarkerDetected?: string;
}

const PAID_HASHTAGS = new Set([
  "ad",
  "sponsored",
  "paidpartnership",
  "gifted",
  "collab",
  "partner",
]);

const PAID_PHRASES = [
  "paid partnership",
  "sponsored by",
  "brand partner",
  "affiliate link",
  "link in bio",
];

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return matches.map((tag) => tag.slice(1).toLocaleLowerCase());
}

export function hashtagsFor(caption: string, explicit: string[] = []): string[] {
  return [...explicit, ...extractHashtags(caption)]
    .map((tag) => tag.replace(/^#/, "").toLocaleLowerCase())
    .filter(Boolean);
}

function detectedPaidMarker(caption: string, hashtags: string[]): string | undefined {
  for (const tag of hashtags) {
    if (PAID_HASHTAGS.has(tag.toLocaleLowerCase())) return `#${tag}`;
  }

  const normalizedCaption = caption.toLocaleLowerCase();
  for (const phrase of PAID_PHRASES) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "u").test(normalizedCaption)) {
      return phrase;
    }
  }
  return undefined;
}

function looksLikeReel(item: NormalizedProviderItem): boolean {
  const productType = (item.productType ?? "").toLocaleLowerCase();
  if (["clips", "reel", "reels"].includes(productType)) return true;
  if (item.contentType === "reel") return true;
  if (item.contentType === "image" || item.contentType === "carousel") return false;
  return /instagram\.com\/reel\//i.test(item.url);
}

export function evaluateOrganicReel(item: NormalizedProviderItem): EligibilityResult {
  const hashtags = hashtagsFor(item.caption, item.hashtags);

  if (!looksLikeReel(item)) {
    return { dropReason: "not_reel" };
  }

  if (item.paidPartnershipFlag) {
    return { dropReason: "paid_partnership_flag" };
  }

  const marker = detectedPaidMarker(item.caption, hashtags);
  if (marker) {
    return { dropReason: "paid_marker", paidMarkerDetected: marker };
  }

  return {
    item: {
      ...item,
      hashtags,
      contentType: "reel",
    },
  };
}

export function incrementDrop(reasons: Record<string, number>, reason?: string): void {
  if (!reason) return;
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

export function creatorKeyFor(item: Pick<NormalizedProviderItem, "providerCreatorId" | "creatorHandle">): string {
  return item.providerCreatorId ?? item.creatorHandle ?? "unknown";
}

export function underCreatorCap(
  item: Pick<NormalizedProviderItem, "providerCreatorId" | "creatorHandle">,
  counts: Map<string, number>,
  cap: number
): boolean {
  const key = creatorKeyFor(item);
  const count = counts.get(key) ?? 0;
  if (count >= cap) return false;
  counts.set(key, count + 1);
  return true;
}
