import { config } from "dotenv";
import path from "path";

// Load .env from project root while allowing explicit shell/Docker env vars to win.
config({ path: path.resolve(__dirname, "../../../.env") });

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function csv(key: string, fallback: string): string[] {
  return optional(key, fallback)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  // Server
  PORT: parseInt(optional("PORT", "3001"), 10),
  NODE_ENV: optional("NODE_ENV", "development"),

  // Redis
  REDIS_URL: optional("REDIS_URL", "redis://localhost:6379"),
  QUEUE_MODE: optional("QUEUE_MODE", "bullmq"),

  // Database
  DATABASE_URL: optional("DATABASE_URL", "file:./dev.db"),

  // Google Gemini (FREE tier — https://aistudio.google.com/app/apikey)
  GEMINI_API_KEY: optional("GEMINI_API_KEY", ""),
  VISION_MODEL: optional("VISION_MODEL", "gemini-3.5-flash-lite"),
  VISION_MODEL_FALLBACKS: optional(
    "VISION_MODEL_FALLBACKS",
    "gemini-3.5-flash,gemini-2.5-flash,gemma-4-26b-a4b-it"
  )
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
  EMBEDDING_MODEL: optional("EMBEDDING_MODEL", "gemini-embedding-2"),
  VLM_TOP_N: parseInt(optional("VLM_TOP_N", "15"), 10),
  KEYWORD_INSTAGRAM_QUERIES: parseInt(optional("KEYWORD_INSTAGRAM_QUERIES", "6"), 10),

  // Source configuration
  SEARCH_SOURCES: csv("SEARCH_SOURCES", "instagram"),
  INSTAGRAM_PROVIDER: optional("INSTAGRAM_PROVIDER", "apify"),
  TARGET_RESULTS: parseInt(optional("TARGET_RESULTS", "20"), 10),
  MAX_REFILL_ROUNDS: parseInt(optional("MAX_REFILL_ROUNDS", "6"), 10),
  MIN_REFILL_YIELD: parseInt(optional("MIN_REFILL_YIELD", "1"), 10),
  MAX_APIFY_RUNS_PER_JOB: parseInt(optional("MAX_APIFY_RUNS_PER_JOB", "8"), 10),
  DAILY_PROVIDER_RUN_BUDGET: parseInt(optional("DAILY_PROVIDER_RUN_BUDGET", "200"), 10),
  PROVIDER_CACHE_TTL_MS: parseInt(optional("PROVIDER_CACHE_TTL_MS", "21600000"), 10),
  COLLECTOR_CONCURRENCY: parseInt(optional("COLLECTOR_CONCURRENCY", "1"), 10),
  PER_CREATOR_CAP: parseInt(optional("PER_CREATOR_CAP", "3"), 10),

  // Apify (for Instagram scraper)
  APIFY_API_TOKEN: optional("APIFY_API_TOKEN", ""),

  // Meta Ad Library API
  META_AD_LIBRARY_ACCESS_TOKEN: optional("META_AD_LIBRARY_ACCESS_TOKEN", ""),
  META_ENABLE_OFFICIAL: optional("META_ENABLE_OFFICIAL", "false") === "true",
  META_FALLBACK_COUNTRY: optional("META_FALLBACK_COUNTRY", "US"),
  META_FALLBACK_MAX_POLLS: parseInt(optional("META_FALLBACK_MAX_POLLS", "6"), 10),

  // Feature flags
  USE_FIXTURES: optional("WISHLUCK_USE_FIXTURES", optional("USE_FIXTURES", "false")) === "true",
  ENABLE_TIKTOK: optional("ENABLE_TIKTOK", "false") === "true",

  // Timeouts
  REQUEST_TIMEOUT_MS: parseInt(optional("REQUEST_TIMEOUT_MS", "10000"), 10),
  WORKER_CONCURRENCY: parseInt(optional("WORKER_CONCURRENCY", "1"), 10),
};

export function validateStartupConfig(): void {
  if (env.USE_FIXTURES) return;

  const sources = new Set(env.SEARCH_SOURCES);
  if (sources.has("instagram") && env.INSTAGRAM_PROVIDER === "apify" && !env.APIFY_API_TOKEN) {
    throw new Error("APIFY_API_TOKEN is required when SEARCH_SOURCES includes instagram and INSTAGRAM_PROVIDER=apify");
  }

  if (sources.has("meta") && env.META_ENABLE_OFFICIAL && !env.META_AD_LIBRARY_ACCESS_TOKEN) {
    throw new Error("META_AD_LIBRARY_ACCESS_TOKEN is required when meta source uses the official API");
  }
}
