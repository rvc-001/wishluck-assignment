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
