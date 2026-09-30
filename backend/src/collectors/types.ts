/**
 * Common Collector Interface (Phase 3)
 * All video collectors implement this contract.
 */

export interface Video {
  id: string;
  platform: "instagram" | "meta" | "tiktok";
  platformId: string;
  providerMediaId?: string;
  providerCreatorId?: string;
  url: string;
  thumbnailUrl: string;
  caption: string;
  author?: string;
  creatorHandle?: string;
  likes?: number;
  views?: number;
  metaPath?: "official" | "fallback";
  contentType?: "reel" | "video" | "image" | "carousel" | "unknown";
  sourceKind?: "organic" | "ads" | "unknown";
  isPaidPartnership?: boolean;
  paidMarkerDetected?: string;
  dropReason?: string;
  createdAt?: string;
  urlHash?: string;
  thumbPHash?: string;
  captionSimhash?: string;
  embedding?: number[];
}

export interface CollectorStats {
  got: number;
  wanted: number;
  triedQueries: string[];
  metaPath?: "official" | "fallback";
  targetResults?: number;
  status?: "complete" | "partial";
  sourceKinds?: Record<string, "organic" | "ads" | "unknown">;
  dropReasons?: Record<string, number>;
  cacheHits?: number;
  liveRuns?: number;
}

export interface CollectorResult {
  videos: Video[];
  stats: CollectorStats;
}

export interface CollectorOptions {
  target: number;
  seenIds: Set<string>;
  timeBudgetMs: number;
}

export interface Collector {
  collect(queries: string[], opts: CollectorOptions): Promise<CollectorResult>;
}

/** Normalize a platformId for cross-source dedup tracking */
export function makeSeenKey(platform: string, platformId: string): string {
  return `${platform}:${platformId}`;
}
