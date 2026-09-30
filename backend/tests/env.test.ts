import { describe, expect, it } from "vitest";
import { env, validateStartupConfig } from "../src/lib/env";

describe("startup config validation", () => {
  it("fixture mode does not require Apify token", () => {
    const previous = { ...env };
    try {
      (env as any).USE_FIXTURES = true;
      (env as any).SEARCH_SOURCES = ["instagram"];
      (env as any).INSTAGRAM_PROVIDER = "apify";
      (env as any).APIFY_API_TOKEN = "";

      expect(() => validateStartupConfig()).not.toThrow();
    } finally {
      Object.assign(env, previous);
    }
  });

  it("live instagram apify mode fails without Apify token", () => {
    const previous = { ...env };
    try {
      (env as any).USE_FIXTURES = false;
      (env as any).SEARCH_SOURCES = ["instagram"];
      (env as any).INSTAGRAM_PROVIDER = "apify";
      (env as any).APIFY_API_TOKEN = "";

      expect(() => validateStartupConfig()).toThrow(/APIFY_API_TOKEN/);
    } finally {
      Object.assign(env, previous);
    }
  });
});
