import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

let redisInstance: Redis | null = null;
const memoryCache = new Map<string, { value: string; expiresAt: number }>();

function useMemoryRedis(): boolean {
  return env.REDIS_URL === "memory" || env.QUEUE_MODE === "inline";
}

export function getRedis(): Redis {
  if (useMemoryRedis()) {
    throw new Error("Redis client is disabled in inline queue mode");
  }

  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // required for BullMQ
      lazyConnect: true,
    });

    redisInstance.on("connect", () => logger.info("Redis connected"));
    redisInstance.on("error", (err) =>
      logger.error({ err }, "Redis connection error")
    );
  }
  return redisInstance;
}

export async function cacheGet(key: string): Promise<string | null> {
  if (useMemoryRedis()) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memoryCache.delete(key);
      return null;
    }
    return entry.value;
  }
  return getRedis().get(key);
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  if (useMemoryRedis()) {
    memoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return;
  }
  await getRedis().setex(key, ttlSeconds, value);
}

export async function cacheGetJSON<T>(key: string): Promise<T | null> {
  const raw = await cacheGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSetJSON<T>(
  key: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  await cacheSet(key, JSON.stringify(value), ttlSeconds);
}
