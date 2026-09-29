import axios, { AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import { validateUrl, SSRFError } from "../lib/ssrf";
import { cacheGetJSON, cacheSetJSON } from "../lib/redis";
import { sha256, normalizeUrl } from "../lib/utils";
import { logger } from "../lib/logger";
import { env } from "../lib/env";

type CheerioRoot = ReturnType<typeof cheerio.load>;

export interface ProductInfo {
  title: string;
  imageUrl: string;
  description: string;
  sourceUrl?: string;
  extractedBy?: string;
}

interface BotBlockedError {
  error: { code: "BOT_BLOCKED"; hint: string };
}

const CACHE_TTL = 24 * 60 * 60; // 24 hours
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const REQUEST_TIMEOUT_MS = env.REQUEST_TIMEOUT_MS;

function extractUrlFromText(value: string, baseUrl?: string): string {
  const raw = value.replace(/\\&/g, "&").trim();
  const markdownMatch = raw.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
  const candidate = markdownMatch?.[1] ?? urlMatch?.[0] ?? raw;

  if (!candidate) return "";
  if (/^https?:\/\//i.test(candidate)) return candidate;

  if (baseUrl) {
    try {
      return new URL(candidate, baseUrl).toString();
    } catch {
      return candidate;
    }
  }

  return candidate;
}

function cleanProduct(product: ProductInfo): ProductInfo {
  return {
    ...product,
    imageUrl: extractUrlFromText(product.imageUrl, product.sourceUrl),
    sourceUrl: product.sourceUrl ? extractUrlFromText(product.sourceUrl) : product.sourceUrl,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function cacheAndReturn(cacheKey: string, product: ProductInfo): Promise<ProductInfo> {
  const cleaned = cleanProduct(product);
  await cacheSetJSON(cacheKey, cleaned, CACHE_TTL);
  return cleaned;
}

// ─── 1.3 JSON-LD Extractor ───────────────────────────────────────────────────
function extractJsonLd($: CheerioRoot): Partial<ProductInfo> | null {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html() ?? "";
      const data = JSON.parse(raw);
      const schemas: unknown[] = Array.isArray(data)
        ? data
        : data["@graph"] ?? [data];

      for (const schema of schemas) {
        const s = schema as Record<string, unknown>;
        if (
          s["@type"] === "Product" ||
          (s["@type"] as string)?.toLowerCase?.().includes("product")
        ) {
          const imageRaw = s["image"];
          let imageUrl = "";
          if (typeof imageRaw === "string") imageUrl = imageRaw;
          else if (Array.isArray(imageRaw) && imageRaw.length > 0)
            imageUrl = typeof imageRaw[0] === "string" ? imageRaw[0] : (imageRaw[0] as Record<string, string>)["url"] ?? "";
          else if (imageRaw && typeof imageRaw === "object")
            imageUrl = (imageRaw as Record<string, string>)["url"] ?? "";

          return {
            title: (s["name"] as string) ?? "",
            imageUrl,
            description: (s["description"] as string) ?? "",
            extractedBy: "json-ld",
          };
        }
      }
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return null;
}

// ─── 1.4 OpenGraph Extractor ─────────────────────────────────────────────────
function extractOpenGraph($: CheerioRoot): Partial<ProductInfo> | null {
  const title =
    $('meta[property="og:title"]').attr("content") ??
    $('meta[name="twitter:title"]').attr("content") ??
    "";
  const imageUrl =
    $('meta[property="og:image"]').attr("content") ??
    $('meta[name="twitter:image"]').attr("content") ??
    "";
  const description =
    $('meta[property="og:description"]').attr("content") ??
    $('meta[name="description"]').attr("content") ??
    "";

  if (!title && !imageUrl) return null;
  return { title, imageUrl, description, extractedBy: "opengraph" };
}

// ─── 1.5 HTML Heuristic Extractor ────────────────────────────────────────────
function extractHeuristic($: CheerioRoot, baseUrl: string): Partial<ProductInfo> | null {
  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "";

  // Find largest image by checking width/height attrs or just pick first prominent img
  let imageUrl = "";
  let bestArea = 0;
  $("img").each((_: number, el: any) => {
    const src = $(el).attr("src") ?? "";
    const width = parseInt($(el).attr("width") ?? "0", 10);
    const height = parseInt($(el).attr("height") ?? "0", 10);
    const area = width * height;
    if (area > bestArea && src && !src.includes("logo") && !src.includes("icon")) {
      bestArea = area;
      imageUrl = src;
    }
  });
  if (!imageUrl) {
    imageUrl = $("img").first().attr("src") ?? "";
  }

  // Make image URL absolute
  if (imageUrl && !imageUrl.startsWith("http")) {
    try {
      imageUrl = new URL(imageUrl, baseUrl).toString();
    } catch {
      /* keep as-is */
    }
  }

  const description =
    $("p").first().text().trim().slice(0, 500) ||
    $('[class*="description"]').first().text().trim().slice(0, 500) ||
    "";

  if (!title && !imageUrl) return null;
  return { title, imageUrl, description, extractedBy: "heuristic" };
}

// ─── HTTP client factory (respects SSRF + timeouts) ──────────────────────────
function makeAxios(): AxiosInstance {
  return axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: MAX_BODY_BYTES,
    maxBodyLength: MAX_BODY_BYTES,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    maxRedirects: 0,
    validateStatus: (status) => (status >= 200 && status < 400) || [301, 302, 303, 307, 308].includes(status),
  });
}

async function fetchHtmlWithSafeRedirects(
  client: AxiosInstance,
  initialUrl: string,
  maxRedirects = 5
): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const resp = await client.get<string>(currentUrl, { responseType: "text" });
    const location = resp.headers.location as string | undefined;

    if (resp.status >= 300 && resp.status < 400 && location) {
      const nextUrl = new URL(location, currentUrl).toString();
      await validateUrl(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    return { html: resp.data, finalUrl: currentUrl };
  }

  throw new Error(`Too many redirects while fetching ${initialUrl}`);
}

// ─── Main scraper (Phase 1 targets 1.3 – 1.8) ────────────────────────────────
export async function scrapeProduct(
  rawUrl: string
): Promise<ProductInfo | BotBlockedError> {
  // 1.8 — Redis cache
  const inputUrl = extractUrlFromText(rawUrl);
  const cacheKey = `product:v3:${sha256(normalizeUrl(inputUrl))}`;
  const cached = await cacheGetJSON<ProductInfo>(cacheKey);
  if (cached) {
    const cleaned = cleanProduct(cached);
    logger.info({ cacheKey }, "Product cache hit");
    if (cleaned.imageUrl && !isHttpUrl(cleaned.imageUrl)) {
      logger.warn({ cacheKey }, "Ignoring product cache entry with invalid image URL");
    } else {
      return cleaned;
    }
  }

  // 1.2 — SSRF validation
  let safeUrl: URL;
  try {
    safeUrl = await validateUrl(inputUrl);
  } catch (err) {
    if (err instanceof SSRFError) {
      return {
        error: {
          code: "BOT_BLOCKED",
          hint: `SSRF check failed: ${(err as Error).message}`,
        },
      };
    }
    throw err;
  }

  const url = safeUrl.toString();
  const client = makeAxios();

  // Attempt 1: Fast static fetch (covers JSON-LD + OG + heuristic)
  let html: string | null = null;
  let finalUrl = url;
  try {
    const fetched = await fetchHtmlWithSafeRedirects(client, url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
  } catch (err: unknown) {
    const e = err as { response?: { status: number }; code?: string };
    if (e?.response?.status === 403 || e?.response?.status === 429) {
      logger.warn({ url }, "Bot-blocked — returning hint");
      // 1.7
      return {
        error: {
          code: "BOT_BLOCKED",
          hint: "Site blocked the crawler. Try uploading the product image directly instead.",
        },
      };
    }
    logger.warn({ url, err }, "Static fetch failed — will try Playwright");
  }

  // Extraction pipeline
  if (html) {
    const $ = cheerio.load(html);

    // 1.3 JSON-LD
    const jsonLdResult = extractJsonLd($);
    if (jsonLdResult?.title && jsonLdResult?.imageUrl) {
      const product: ProductInfo = {
        title: jsonLdResult.title,
        imageUrl: jsonLdResult.imageUrl,
        description: jsonLdResult.description ?? "",
        sourceUrl: finalUrl,
        extractedBy: "json-ld",
      };
      return cacheAndReturn(cacheKey, product);
    }

    // 1.4 OpenGraph
    const ogResult = extractOpenGraph($);
    if (ogResult?.title && ogResult?.imageUrl) {
      const product: ProductInfo = {
        title: ogResult.title,
        imageUrl: ogResult.imageUrl,
        description: ogResult.description ?? "",
        sourceUrl: finalUrl,
        extractedBy: "opengraph",
      };
      return cacheAndReturn(cacheKey, product);
    }

    // 1.5 HTML heuristic
    const heuristicResult = extractHeuristic($, url);
    if (heuristicResult?.title) {
      const product: ProductInfo = {
        title: heuristicResult.title,
        imageUrl: heuristicResult.imageUrl ?? "",
        description: heuristicResult.description ?? "",
        sourceUrl: finalUrl,
        extractedBy: "heuristic",
      };
      return cacheAndReturn(cacheKey, product);
    }
  }

  // 1.6 — Playwright fallback for JS-rendered pages
  logger.info({ url }, "Falling back to Playwright for JS-rendered page");
  try {
    const product = await scrapeWithPlaywright(url);
    if (product) {
      return cacheAndReturn(cacheKey, product);
    }
  } catch (err) {
    logger.error({ url, err }, "Playwright fallback failed");
  }

  // 1.7 — Final fallback
  return {
    error: {
      code: "BOT_BLOCKED",
      hint: "Could not extract product data. Please upload the product image directly.",
    },
  };
}

// ─── 1.6 Playwright fallback ──────────────────────────────────────────────────
async function scrapeWithPlaywright(url: string): Promise<ProductInfo | null> {
  // Lazy import to avoid loading Playwright in fixture mode
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    const html = await page.content();
    const $ = cheerio.load(html);

    const jsonLd = extractJsonLd($);
    if (jsonLd?.title) {
      return {
        title: jsonLd.title,
        imageUrl: jsonLd.imageUrl ?? "",
        description: jsonLd.description ?? "",
        sourceUrl: url,
        extractedBy: "playwright+json-ld",
      };
    }

    const og = extractOpenGraph($);
    if (og?.title) {
      return {
        title: og.title,
        imageUrl: og.imageUrl ?? "",
        description: og.description ?? "",
        sourceUrl: url,
        extractedBy: "playwright+opengraph",
      };
    }

    const heuristic = extractHeuristic($, url);
    return heuristic
      ? {
          title: heuristic.title ?? "",
          imageUrl: heuristic.imageUrl ?? "",
          description: heuristic.description ?? "",
          sourceUrl: url,
          extractedBy: "playwright+heuristic",
        }
      : null;
  } finally {
    await browser.close();
  }
}

/**
 * Resolve product from keyword (just return the keyword as title for now;
 * collectors will use it as a search query directly).
 */
export function resolveFromKeyword(keyword: string): ProductInfo {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="100%" height="100%" fill="#111827"/><text x="50%" y="48%" text-anchor="middle" fill="#e5e7eb" font-family="Arial" font-size="42" font-weight="700">Product Search</text><text x="50%" y="56%" text-anchor="middle" fill="#93c5fd" font-family="Arial" font-size="28">${keyword.replace(/[<>&"]/g, "")}</text></svg>`;
  return {
    title: keyword,
    imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    description: `Keyword search: ${keyword}`,
    extractedBy: "keyword",
  };
}
