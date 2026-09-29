/**
 * eval/run.ts - Evidence runner.
 *
 * Tests product queries against a running backend and writes source-specific
 * result counts to eval/output/results.md.
 *
 * Usage:
 *   npx ts-node eval/run.ts
 *   USE_FIXTURES=true npx ts-node eval/run.ts
 */

import fs from "fs";
import path from "path";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";

interface SearchJob {
  searchId: string;
}

interface SearchStatus {
  status: string;
  results: Array<{
    platform: string;
    score: number;
    label: string;
    metaPath?: string;
  }>;
  productInfo?: { title: string };
}

const TEST_PRODUCTS = [
  { name: "Floral print midi dress", query: "floral print midi dress", queryType: "keyword" },
  { name: "Trail running shoes", query: "trail running shoes", queryType: "keyword" },
  { name: "Wireless noise-cancelling headphones", query: "wireless noise cancelling headphones", queryType: "keyword" },
  { name: "SPF 50 tinted moisturiser", query: "spf 50 tinted moisturiser", queryType: "keyword" },
  { name: "Organic peanut butter jar", query: "organic peanut butter jar", queryType: "keyword" },
  { name: "Vintage band tee", query: "vintage band tee shirt", queryType: "keyword" },
];

async function search(query: string, queryType: string): Promise<string> {
  const resp = await fetch(`${API_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, queryType }),
  });
  if (!resp.ok) {
    throw new Error(`Search request failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json() as SearchJob;
  return data.searchId;
}

async function pollUntilDone(searchId: string, maxWaitMs = 180000): Promise<SearchStatus> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const resp = await fetch(`${API_BASE}/api/search/${searchId}`);
    const data = await resp.json() as SearchStatus;
    if (data.status === "done" || data.status === "failed") return data;
  }
  throw new Error(`Search ${searchId} timed out after ${maxWaitMs}ms`);
}

async function main() {
  console.log("WishLuck Evidence Runner\n");

  const rows: string[] = [
    "| Product | IG Got | IG Wanted | Meta Path | Meta Got | Meta Wanted | Post-Dedup | Avg Score | Shortfall | Runtime |",
    "|---|---:|---:|---|---:|---:|---:|---:|---|---:|",
  ];

  for (const product of TEST_PRODUCTS) {
    console.log(`Testing: ${product.name}...`);
    const start = Date.now();

    try {
      const searchId = await search(product.query, product.queryType);
      const result = await pollUntilDone(searchId);
      const elapsed = Math.round((Date.now() - start) / 1000);

      const igResults = result.results.filter((item) => item.platform === "instagram");
      const metaResults = result.results.filter((item) => item.platform === "meta");
      const metaPath = metaResults[0]?.metaPath ?? "fallback";
      const postDedup = result.results.length;
      const avgScore =
        result.results.length > 0
          ? (result.results.reduce((sum, item) => sum + item.score, 0) / result.results.length).toFixed(2)
          : "-";
      const igShortfall = Math.max(0, 20 - igResults.length);
      const metaShortfall = Math.max(0, 20 - metaResults.length);
      const shortfall = igShortfall + metaShortfall;

      rows.push(
        `| ${product.name} | ${igResults.length} | 20 | ${metaPath} | ${metaResults.length} | 20 | ${postDedup} | ${avgScore} | ${shortfall > 0 ? `IG ${igShortfall}, Meta ${metaShortfall}` : "none"} | ${elapsed}s |`
      );
      console.log(`  Done in ${elapsed}s - IG ${igResults.length}, Meta ${metaResults.length}`);
    } catch (err) {
      rows.push(`| ${product.name} | ERROR | 20 | - | ERROR | 20 | - | - | - | - |`);
      console.log(`  Failed: ${(err as Error).message}`);
    }
  }

  const outputPath = path.resolve(process.cwd(), "output/results.md");
  const content = [
    "# Eval Results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Mode: fixture/live backend evidence. Fixture mode verifies pipeline wiring, balanced source counts, persistence, and scoring without external API spend.",
    "",
    rows.join("\n"),
    "",
  ].join("\n");
  fs.writeFileSync(outputPath, content);
  console.log(`\nResults written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
