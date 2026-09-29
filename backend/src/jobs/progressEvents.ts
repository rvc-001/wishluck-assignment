import { EventEmitter } from "events";

export type SearchProgressEvent =
  | { stage: "validate"; status: "done" }
  | { stage: "resolve"; status: "done"; product: { title: string; imageUrl: string; description?: string } }
  | { stage: "brain"; status: "done"; attributes: unknown }
  | { stage: "collect"; status: "progress" | "done"; source?: string; got: number; wanted: number; shortfall?: number }
  | { stage: "dedup"; status: "done"; before: number; after: number }
  | { stage: "score"; status: "progress" | "done"; scored?: number; total?: number }
  | { stage: "persist"; status: "done" }
  | { stage: "done"; results: unknown[]; productInfo: { title: string; imageUrl: string; description?: string; attributes?: unknown } }
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
