import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function isProbablyDirectVideo(url: string): boolean {
  return /^https?:\/\//i.test(url) && /\.(mp4|mov|webm)(\?|$)/i.test(url);
}

export async function sampleVideoFrames(videoUrl: string): Promise<string[]> {
  if (!isProbablyDirectVideo(videoUrl)) return [];

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wishluck-frames-"));
  const outputPattern = path.join(tempDir, "frame-%02d.jpg");

  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoUrl,
      "-vf",
      "select='eq(n,0)+eq(n,25)+eq(n,50)',scale=512:-1",
      "-frames:v",
      "3",
      outputPattern,
    ], { timeout: 20000 });

    const frames: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const file = path.join(tempDir, `frame-${String(i).padStart(2, "0")}.jpg`);
      try {
        const data = await readFile(file);
        frames.push(`data:image/jpeg;base64,${data.toString("base64")}`);
      } catch {
        // Fewer frames are acceptable when ffmpeg cannot seek all positions.
      }
    }
    return frames;
  } catch {
    return [];
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
