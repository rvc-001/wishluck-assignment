import { env } from "../lib/env";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();
const dailyRuns = new Map<string, number>();

function todayKey(provider: string): string {
  return `${provider}:${new Date().toISOString().slice(0, 10)}`;
}

export interface ProviderRunBudget {
  provider: string;
  perJobLimit: number;
  jobRuns: number;
}

export function createProviderRunBudget(provider: string, perJobLimit = env.MAX_APIFY_RUNS_PER_JOB): ProviderRunBudget {
  return { provider, perJobLimit, jobRuns: 0 };
}

export function readProviderCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function writeProviderCache<T>(key: string, value: T, ttlMs = env.PROVIDER_CACHE_TTL_MS): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function tryConsumeProviderRun(budget: ProviderRunBudget): { ok: true } | { ok: false; reason: string } {
  if (budget.jobRuns >= budget.perJobLimit) {
    return { ok: false, reason: "per_job_run_cap" };
  }

  const key = todayKey(budget.provider);
  const usedToday = dailyRuns.get(key) ?? 0;
  if (usedToday >= env.DAILY_PROVIDER_RUN_BUDGET) {
    return { ok: false, reason: "daily_run_budget" };
  }

  budget.jobRuns++;
  dailyRuns.set(key, usedToday + 1);
  return { ok: true };
}

export function resetProviderRuntimeForTests(): void {
  cache.clear();
  dailyRuns.clear();
}
