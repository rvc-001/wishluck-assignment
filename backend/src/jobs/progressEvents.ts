import { EventEmitter } from "events";

export type SearchProgressEvent =
  | { stage: "validate"; status: "done" }
  | { stage: "resolve"; status: "done"; product: { title: string; imageUrl: string; description?: string } }
  | { stage: "brain"; status: "done"; attributes: unknown }
  | {
      contractVersion?: 1;
      stage: "collect";
      status: "progress" | "done";
      resultStatus?: "complete" | "partial";
      source?: string;
      got: number;
      wanted: number;
      targetResults?: number;
      sourceKinds?: Record<string, "organic" | "ads" | "unknown">;
      dropReasons?: Record<string, number>;
      sourceWarnings?: Record<string, string[]>;
      shortfall?: number;
    }
  | {
      contractVersion?: 1;
      stage: "dedup";
      status: "done";
      before: number;
      after: number;
      resultStatus?: "complete" | "partial";
      targetResults?: number;
      sourceKinds?: Record<string, "organic" | "ads" | "unknown">;
      dropReasons?: Record<string, number>;
    }
  | {
      contractVersion?: 1;
      stage: "score";
      status: "progress" | "done";
      scored?: number;
      total?: number;
      resultStatus?: "complete" | "partial";
      targetResults?: number;
    }
  | { stage: "persist"; status: "done" }
  | {
      contractVersion?: 1;
      stage: "done";
      status?: "complete" | "partial";
      targetResults?: number;
      sourceKinds?: Record<string, "organic" | "ads" | "unknown">;
      dropReasons?: Record<string, number>;
      results: unknown[];
      engagementOrdering?: "enabled" | "disabled_low_coverage";
      engagementSummary?: { aboveFloor: number; shown: number; floor: number };
      engagementOrderingByPlatform?: Record<string, "enabled" | "disabled_low_coverage">;
      engagementSummaryByPlatform?: Record<string, { aboveFloor: number; shown: number; floor: number }>;
      sourceWarnings?: Record<string, string[]>;
      qualityNotice?: { title: string; messages: string[] };
      productInfo: { title: string; imageUrl: string; description?: string; attributes?: unknown; diagnostics?: unknown };
    }
  | { stage: "error"; error: { code: string; message: string; hint: string } };

const emitter = new EventEmitter();
const replay = new Map<string, SearchProgressEvent[]>();
const MAX_REPLAY_EVENTS = 100;

function eventName(searchId: string): string {
  return `search:${searchId}`;
}

export function emitSearchEvent(searchId: string, event: SearchProgressEvent): void {
  const events = replay.get(searchId) ?? [];
  events.push(event);
  if (events.length > MAX_REPLAY_EVENTS) events.shift();
  replay.set(searchId, events);
  emitter.emit(eventName(searchId), event);
}

export function getSearchEvents(searchId: string): SearchProgressEvent[] {
  return replay.get(searchId) ?? [];
}

export function subscribeSearchEvents(
  searchId: string,
  listener: (event: SearchProgressEvent) => void
): () => void {
  const name = eventName(searchId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
