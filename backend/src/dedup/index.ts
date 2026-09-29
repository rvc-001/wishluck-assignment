import { Video } from "../collectors/types";
import { dedupExact } from "./exact";
import { dedupVisual } from "./visual";
import { dedupTextual } from "./textual";
import { logger } from "../lib/logger";

export async function runDedupPipeline(videos: Video[]): Promise<Video[]> {
  logger.info(`Starting dedup pipeline with ${videos.length} videos`);

  // 1. L1 Exact
  const afterExact = dedupExact(videos);
  logger.info(`After L1 Exact: ${afterExact.length} videos`);

  // 2. L2 Visual (CLIP)
  const afterVisual = await dedupVisual(afterExact);
  logger.info(`After L2 Visual: ${afterVisual.length} videos`);

  // 3. L3 Textual (Jaccard)
  const afterTextual = dedupTextual(afterVisual);
  logger.info(`After L3 Textual: ${afterTextual.length} videos`);

  return afterTextual;
}
