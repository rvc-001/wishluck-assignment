import crypto from "crypto";

/** SHA-256 hash of a string — used for Redis cache keys */
export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Normalize a URL to a canonical form for hashing */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim().toLowerCase());
    // Remove trailing slash
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    // Sort query params for consistency
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Retry helper with exponential backoff + jitter */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, baseDelay = 500, maxDelay = 10000 } = {}
): Promise<T> {
  let lastError: Error | unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const jitter = Math.random() * 200;
        const delay = Math.min(baseDelay * Math.pow(2, attempt) + jitter, maxDelay);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
