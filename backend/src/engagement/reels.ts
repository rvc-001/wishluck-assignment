import { logger } from "../lib/logger";

export type EngagementStatus = "high" | "below_floor" | "unknown";
export type EngagementOrdering = "enabled" | "disabled_low_coverage";

const MAX_INT = 2_147_483_647;
const MIN_COVERAGE = 0.6;
const TIER_ORDER: Record<string, number> = { match: 2, possible: 1, discard: 0 };
const STATUS_ORDER: Record<EngagementStatus, number> = { high: 2, below_floor: 1, unknown: 0 };

export const CANONICAL_VIEW_FIELDS = ["videoPlayCount", "playCount", "videoViewCount", "views"] as const;
export const LIKE_FIELDS = ["likesCount", "likes"] as const;

export interface RankedResultLike {
  score: number;
  label: string;
  views?: number | null;
  likes?: number | null;
}

export interface RankedOrganicResultLike extends RankedResultLike {
  platform: string;
}

export function parseEngagementCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return clampEngagementCount(Math.round(value));
  }

  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const compact = trimmed.replace(/,/g, "");
  const match = compact.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return undefined;

  const base = Number(match[1]);
  if (!Number.isFinite(base) || base < 0) return undefined;
  const suffix = (match[2] ?? "").toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return clampEngagementCount(Math.round(base * multiplier));
}

export function clampEngagementCount(value: number): number {
  if (value > MAX_INT) {
    logger.warn({ value, clampedTo: MAX_INT }, "Engagement count exceeded 32-bit storage; clamped");
    return MAX_INT;
  }
  return value;
}

export function firstUsableCount(record: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const parsed = parseEngagementCount(record[field]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function engagementStatus(views: number | null | undefined, floor: number): EngagementStatus {
  if (views === null || views === undefined) return "unknown";
  return views >= floor ? "high" : "below_floor";
}

export function usableViewCoverage(items: Array<{ views?: number | null }>): number {
  if (items.length === 0) return 0;
  return items.filter((item) => item.views !== null && item.views !== undefined).length / items.length;
}

export function engagementOrderingFor(items: Array<{ views?: number | null }>): EngagementOrdering {
  return usableViewCoverage(items) >= MIN_COVERAGE ? "enabled" : "disabled_low_coverage";
}

export function relevanceBucket(score: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  return Math.floor(Math.round(clamped * 1000) / 50);
}

export function rankReels<T extends RankedResultLike>(
  rows: T[],
  floor: number,
  ordering: EngagementOrdering = engagementOrderingFor(rows)
): T[] {
  return [...rows].sort((a, b) => {
    const tierDelta = (TIER_ORDER[b.label] ?? 0) - (TIER_ORDER[a.label] ?? 0);
    if (tierDelta !== 0) return tierDelta;

    const bucketDelta = relevanceBucket(b.score) - relevanceBucket(a.score);
    if (bucketDelta !== 0) return bucketDelta;

    if (ordering === "enabled") {
      const statusDelta = STATUS_ORDER[engagementStatus(b.views, floor)] - STATUS_ORDER[engagementStatus(a.views, floor)];
      if (statusDelta !== 0) return statusDelta;

      const viewDelta = (b.views ?? -1) - (a.views ?? -1);
      if (viewDelta !== 0) return viewDelta;

      const likeDelta = (b.likes ?? -1) - (a.likes ?? -1);
      if (likeDelta !== 0) return likeDelta;
    }

    return Math.max(0, Math.min(1, b.score)) - Math.max(0, Math.min(1, a.score));
  });
}

export function aboveFloorCount(items: Array<{ views?: number | null }>, floor: number): number {
  return items.filter((item) => engagementStatus(item.views, floor) === "high").length;
}

function percentileMaps<T extends RankedOrganicResultLike>(rows: T[]): Map<T, number> {
  const byPlatform = new Map<string, T[]>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }

  const percentiles = new Map<T, number>();
  for (const platformRows of byPlatform.values()) {
    const known = platformRows
      .filter((row) => row.views !== null && row.views !== undefined)
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    const denom = Math.max(1, known.length - 1);
    known.forEach((row, index) => {
      percentiles.set(row, known.length === 1 ? 1 : 1 - index / denom);
    });
  }
  return percentiles;
}

export function floorForPlatform(platform: string, floors: Record<string, number>, fallback: number): number {
  return floors[platform] ?? fallback;
}

export function engagementOrderingByPlatformFor(
  rows: Array<{ platform: string; views?: number | null }>
): Record<string, EngagementOrdering> {
  const byPlatform = new Map<string, Array<{ views?: number | null }>>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }
  return Object.fromEntries(
    [...byPlatform.entries()].map(([platform, items]) => [platform, engagementOrderingFor(items)])
  );
}

export function rankOrganicVideos<T extends RankedOrganicResultLike>(
  rows: T[],
  floors: Record<string, number>,
  fallbackFloor: number,
  orderingByPlatform: Record<string, EngagementOrdering> = engagementOrderingByPlatformFor(rows)
): T[] {
  const percentiles = percentileMaps(rows);
  return [...rows].sort((a, b) => {
    const tierDelta = (TIER_ORDER[b.label] ?? 0) - (TIER_ORDER[a.label] ?? 0);
    if (tierDelta !== 0) return tierDelta;

    const bucketDelta = relevanceBucket(b.score) - relevanceBucket(a.score);
    if (bucketDelta !== 0) return bucketDelta;

    const aOrdering = orderingByPlatform[a.platform] ?? "disabled_low_coverage";
    const bOrdering = orderingByPlatform[b.platform] ?? "disabled_low_coverage";
    if (aOrdering === "enabled" && bOrdering === "enabled") {
      const aFloor = floorForPlatform(a.platform, floors, fallbackFloor);
      const bFloor = floorForPlatform(b.platform, floors, fallbackFloor);
      const statusDelta = STATUS_ORDER[engagementStatus(b.views, bFloor)] - STATUS_ORDER[engagementStatus(a.views, aFloor)];
      if (statusDelta !== 0) return statusDelta;

      const percentileDelta = (percentiles.get(b) ?? -1) - (percentiles.get(a) ?? -1);
      if (percentileDelta !== 0) return percentileDelta;

      const likeDelta = (b.likes ?? -1) - (a.likes ?? -1);
      if (likeDelta !== 0) return likeDelta;
    }

    return Math.max(0, Math.min(1, b.score)) - Math.max(0, Math.min(1, a.score));
  });
}
