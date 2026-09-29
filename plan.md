# Product Video Discovery Dashboard — Project Plan

> **One-command Docker run. Grader-safe. Evidence-first.**
> Current date: 2026-09-29 | Deadline: 6 working days from start

---

## Table of Contents

1. [Stack Decisions](#1-stack-decisions)
2. [Repo Layout](#2-repo-layout)
3. [Phase 0 — Spike + Scaffold](#phase-0--spike--scaffold-day-0)
4. [Phase 1 — Product Resolver](#phase-1--product-resolver-day-1-am)
5. [Phase 2 — Image-Analysis Brain](#phase-2--image-analysis-brain-day-1-pm--day-2)
6. [Phase 3 — Video Collectors](#phase-3--video-collectors-day-2--3)
7. [Phase 4 — Deduplication](#phase-4--deduplication-day-3)
8. [Phase 5 — Backend API & Job Orchestration](#phase-5--backend-api--job-orchestration-day-3)
9. [Phase 6 — React Dashboard](#phase-6--react-dashboard-day-4)
10. [Phase 7 — Evidence & Documentation](#phase-7--evidence--documentation-day-5)
11. [Final Submission Checklist](#final-submission-checklist)
12. [Key Design Decisions & Rationale](#key-design-decisions--rationale)
13. [Marks Breakdown](#marks-breakdown)

---

## 1. Stack Decisions

| Layer | Choice | Justification |
|---|---|---|
| Backend runtime | **Express + TypeScript** | Minimal, well understood, easy to justify to graders |
| Job queue | **BullMQ + Redis** | Built-in job progress events, retries, exponential backoff |
| Primary data store | **SQLite via Prisma** | Zero infra, runs anywhere, fully adequate for assignment scope |
| Cache | **Same Redis instance** | Product-page cache + image-analysis cache reuse one connection |
| Frontend | **React + Vite + TypeScript** | Fast dev server, matches assignment requirement |
| UI component layer | **Tailwind CSS + shadcn/ui** | Clean, accessible components without hand-rolling |
| Vision LLM | **GPT-4o Vision (or equivalent)** | Structured attribute extraction + verified reason strings |
| Semantic similarity | **CLIP embeddings (hybrid with VLM)** | Fast bulk filtering before expensive VLM calls |
| Instagram Reels | **Apify scraper (behind interface)** | Handles login wall, rate limits, pagination transparently |
| Meta Ad Library | **Official API → mandatory scraper fallback** | Official API only guarantees EU/political/issue ads; fallback is load-bearing |
| TikTok | **Behind ENABLE_TIKTOK flag** | Bonus only — never blocks core sources |
| Testing | **Vitest** | Dedup + scoring logic unit tests |
| Containerization | **Docker Compose** | One-command run: docker compose up |

---

## 2. Repo Layout

```
repo/
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── jobs/
│   │   ├── collectors/
│   │   ├── brain/
│   │   ├── scraper/
│   │   ├── dedup/
│   │   └── lib/
│   ├── prisma/schema.prisma
│   ├── fixtures/
│   └── tests/
├── frontend/
│   └── src/
│       ├── components/
│       ├── pages/
│       └── hooks/
├── docker-compose.yml
├── .env.example
├── README.md
├── plan.md
└── eval/
    ├── run.ts
    └── output/
```

---

## Phase 0 — Spike + Scaffold (Day 0)

### Goal
Prove the two riskiest parts work before writing production code.

### Targets

| # | Target | Acceptance Criteria |
|---|---|---|
| 0.1 | Instagram scraper spike | Returns >= 20 items with { url, thumbnail, caption } for one hashtag. Saved to fixtures/instagram-sample.json |
| 0.2 | Meta official API spike | Calls GET /ads_archive; document exactly what comes back. If < 5 results, fallback is load-bearing |
| 0.3 | Meta fallback spike | Scraping provider / Playwright on public Ad Library; returns >= 20 usable video ad entries |
| 0.4 | Scaffold backend | Express boots; /health returns { status: "ok" } |
| 0.5 | Scaffold frontend | Vite + React boots at localhost:5173 |
| 0.6 | Prisma + SQLite | Schema applied; can read/write Search row |
| 0.7 | Redis running | Via Docker Compose; can SET/GET from backend |
| 0.8 | BullMQ Hello World | POST /api/search enqueues a job; worker logs "job received" |
| 0.9 | Fixture / replay mode | USE_FIXTURES=true makes all collectors return saved JSON; no live network calls |

### Deliverables
- [ ] fixtures/ directory with >= 3 saved response files
- [ ] Written note in eval/output/day0-spike.md on what the Meta official API returns
- [ ] docker compose up brings up Redis + backend + frontend with no errors
- [ ] First BullMQ job processes end-to-end

> Do NOT proceed to Phase 1 without a working fallback path for Meta.

---

## Phase 1 — Product Resolver (Day 1 AM)

### Goal
Given a keyword, URL, or image upload, resolve { title, imageUrl, description }.

### Targets

| # | Target | Acceptance Criteria |
|---|---|---|
| 1.1 | Zod input validation | keyword / url / image all accepted; invalid inputs return 400 with structured error |
| 1.2 | SSRF protection | See SSRF sub-targets below |
| 1.3 | JSON-LD extractor | Returns data from Product JSON-LD schema |
| 1.4 | OpenGraph extractor | Returns data from og:title, og:image, og:description |
| 1.5 | HTML heuristic extractor | Cheerio-based: finds h1, largest img, first paragraph |
| 1.6 | Playwright extractor | Handles JS-rendered pages (Amazon, Shopify JS themes) |
| 1.7 | Bot-block handling | Returns { error: { code: "BOT_BLOCKED", hint: "Use image upload instead" } } |
| 1.8 | Redis cache | product:{sha256(url)} cached for 24h; cache hit skips extraction |
| 1.9 | Integration test | Tested against 1x Shopify, 1x Amazon, 1x brand site |

### SSRF Protection Sub-Targets

| # | Rule |
|---|---|
| 1.2a | Allow only http:// and https:// |
| 1.2b | Resolve hostname via DNS before fetching |
| 1.2c | Reject 10.x, 172.16-31.x, 192.168.x, 127.x, ::1, fc00::/7, fe80::/10, 169.254.x |
| 1.2d | Re-resolve hostname on every 301/302 redirect hop |
| 1.2e | Abort if response body > 5 MB |
| 1.2f | Abort if no response within 10 seconds |

### Extraction Order

```
1. JSON-LD Product schema
2. OpenGraph tags
3. HTML heuristics (Cheerio)
4. Playwright fallback (JS-rendered pages)
```

### Deliverable
scrapeProduct(url): Promise<{ title, imageUrl, description }> — working and cached.

---

## Phase 2 — Image-Analysis Brain (Day 1 PM – Day 2)

> Worth 25 marks. The most technically scrutinized phase.

### Goal
Produce structured product attributes and a reusable embedding. Score + reason each candidate video.

### Stage A — Attribute Extraction (once per product, cached)

#### Targets

| # | Target | Acceptance Criteria |
|---|---|---|
| 2.1 | VLM prompt -> structured JSON | GPT-4o Vision returns valid JSON matching schema |
| 2.2 | Zod validation of VLM output | Re-prompts on failure, max 2 retries |
| 2.3 | CLIP embedding | float32 embedding vector computed for product image |
| 2.4 | Redis cache | imgbrain:{sha256(imageUrl)} -> { attributes, embedding }, TTL 48h |
| 2.5 | Cache hit speed | Second call with same URL returns in < 50ms |

#### VLM Output Schema

```ts
{
  productType: string;       // e.g. "floral print midi dress"
  colors: string[];          // e.g. ["coral", "white"]
  patterns: string[];        // e.g. ["floral", "ditsy print"]
  logoOrText: string;        // e.g. "none" | "Nike swoosh"
  material: string;          // e.g. "cotton"
  shape: string;             // e.g. "A-line"
  searchQueries: string[];   // Instagram hashtag/keyword queries
  adKeywords: string[];      // Meta Ad Library search terms
  matchCriteria: string;     // Human-readable summary for VLM verification
}
```

### Stage B — Per-Video Scoring (Two Passes)

#### Targets

| # | Target | Acceptance Criteria |
|---|---|---|
| 2.6 | Thumbnail fetching | scoreVideo() fetches candidate thumbnail URL |
| 2.7 | Frame sampling | For fetchable videos: extract 2-3 frames via ffmpeg at 25%, 50%, 75% |
| 2.8 | CLIP bulk pass | Cosine similarity between product embedding and each candidate thumbnail + frames |
| 2.9 | Top-N selection | Top 15 from CLIP pass selected for VLM verification |
| 2.10 | VLM verification pass | Send [productImage, bestFrames] + matchCriteria; receive { score: 0-100, same_product: bool, reason: string } |
| 2.11 | Reason string integrity | reason references visual attributes (color, pattern, shape) — NOT caption text |
| 2.12 | Final score computation | finalScore = 0.4 x clipSimilarity_normalized + 0.6 x (vlmScore / 100) |
| 2.13 | Threshold classification | >= 0.60 = "match", 0.40-0.59 = "possible", < 0.40 = discard |
| 2.14 | Calibration | Hand-label 50 product/video pairs; report precision + recall at chosen threshold |

#### Scoring Formula (document in README)

```
finalScore = 0.4 x clipSimilarity_normalized + 0.6 x vlmScore_normalized

clipSimilarity_normalized  = CLIP cosine similarity (already in [0,1])
vlmScore_normalized        = vlmScore / 100

VLM weight 0.6 — performs actual visual comparison.
CLIP weight 0.4 — fast proxy signal, not ground truth.
```

#### Threshold Table

| finalScore | Label | UI Display | Action |
|---|---|---|---|
| >= 0.60 | Match | Green badge | Include |
| 0.40 - 0.59 | Possible | Amber badge | Include, marked uncertain |
| < 0.40 | No match | — | Discard (log, not silent) |

#### Calibration Table (fill with real numbers)

| Threshold | Precision | Recall | F1 |
|---|---|---|---|
| 0.50 | — | — | — |
| 0.55 | — | — | — |
| **0.60 (chosen)** | **—** | **—** | **—** |
| 0.65 | — | — | — |
| 0.70 | — | — | — |

### Deliverables
- [ ] analyzeImage(imageUrl): Promise<{ attributes, embedding }> — cached
- [ ] scoreVideo(product, video): Promise<{ finalScore, label, reason }> — logged reasons
- [ ] Calibration table committed to eval/output/calibration.md

---

## Phase 3 — Video Collectors (Day 2–3)

> Worth 25 marks.

### Goal
Two (optionally three) collectors reliably returning >= 20 usable, scored candidates, or an honest shortfall payload.

### Common Collector Interface

```ts
interface CollectorResult {
  videos: Video[];
  stats: {
    got: number;
    wanted: number;
    triedQueries: string[];
    metaPath?: "official" | "fallback";
  };
}

interface Collector {
  collect(
    queries: string[],
    opts: { target: number; seenIds: Set<string>; timeBudgetMs: number }
  ): Promise<CollectorResult>;
}
```

### 3A — Instagram Reels Collector

| # | Target | Acceptance Criteria |
|---|---|---|
| 3A.1 | Apify actor integration | Can call actor with hashtag/keyword; receives raw item list |
| 3A.2 | Response normalization | Maps raw response to internal Video type |
| 3A.3 | Pagination | Fetches next page if first page < target |
| 3A.4 | In-flight dedup | Skips any platformId already in seenIds |
| 3A.5 | Returns stats | { got, wanted, triedQueries } always returned |

### 3B — Meta Ad Library Collector

| # | Target | Acceptance Criteria |
|---|---|---|
| 3B.1 | Official API attempt | Calls GET /ads_archive; logs response count |
| 3B.2 | Fallback trigger | If official returns < 5 results — immediately switch to fallback |
| 3B.3 | Fallback path | Scraping provider / Playwright; returns >= 20 results |
| 3B.4 | Path logging | Each result carries source: "official" or "fallback"; stats surface metaPath |
| 3B.5 | Same-creative collapse | Collapse same advertiser + same ad copy text into one record |

### 3C — TikTok Collector (bonus, gated)

| # | Target | Acceptance Criteria |
|---|---|---|
| 3C.1 | Feature flag | Only instantiated when ENABLE_TIKTOK=true |
| 3C.2 | Same interface | Implements Collector interface identically |
| 3C.3 | Isolation | If TikTok errors, Promise.allSettled catches it; other sources unaffected |

### 3D — Resilience Requirements (all sources)

| # | Requirement | Implementation |
|---|---|---|
| 3D.1 | Per-request timeout | AbortController with configurable REQUEST_TIMEOUT_MS |
| 3D.2 | Exponential backoff + jitter | delay = Math.min(base x 2^attempt + jitter, maxDelay) |
| 3D.3 | Circuit breaker per source | opossum: opens after 5 consecutive failures, half-opens after 30s |
| 3D.4 | Promise.allSettled | All sources concurrent; one dying never kills search |
| 3D.5 | Never fail silently | Always return { got, wanted, triedQueries } even on total failure |

### 3E — Query Expansion Loop

```
When post-dedup count < target:
1. Exact Stage A searchQueries / adKeywords
2. Attribute-derived queries (productType + color combos)
3. Related hashtags (#ootd, #fashion, etc.)
4. Deeper pagination (next pages of existing queries)
5. Broadened category term (top-level only)
6. STOP (max 10 attempts OR timeBudgetMs exceeded)
```

### Deliverables
- [ ] collectors/instagram.ts — >= 20 results on 3 test products
- [ ] collectors/meta.ts — >= 20 results on 3 test products (logs which path)
- [ ] collectors/tiktok.ts — behind flag, same interface
- [ ] Each collector tested against 3 diverse product queries

---

## Phase 4 — Deduplication (Day 3)

> Worth 15 marks.

### Goal
Eliminate exact duplicates, visual near-duplicates, and textual near-duplicates across both sources and across repeated searches.

### Prisma Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Search {
  id           String         @id @default(cuid())
  query        String
  queryType    String
  productTitle String
  imageUrl     String
  status       String
  createdAt    DateTime       @default(now())
  results      SearchResult[]
}

model Video {
  id             String         @id @default(cuid())
  platform       String
  platformId     String
  urlHash        String         @unique
  thumbPHash     String
  captionSimhash String
  embedding      Bytes
  metaPath       String?
  createdAt      DateTime       @default(now())
  results        SearchResult[]

  @@unique([platform, platformId])
}

model SearchResult {
  searchId  String
  videoId   String
  score     Float
  label     String
  reason    String
  createdAt DateTime @default(now())

  search Search @relation(fields: [searchId], references: [id])
  video  Video  @relation(fields: [videoId], references: [id])

  @@id([searchId, videoId])
}
```

### Deduplication Layers

| Layer | Method | Threshold | File |
|---|---|---|---|
| L1 — Exact | Platform video ID OR SHA-256 of normalized media URL | Identical = dup | dedup/exact.ts |
| L2 — Visual pHash | pHash / dHash of thumbnail; Hamming distance | <= 6 bits = repost | dedup/visual.ts |
| L2b — Visual CLIP | CLIP cosine similarity (for pHash misses) | > 0.95 = dup | dedup/visual.ts |
| L3 — Textual SimHash | SimHash / MinHash on normalized caption + ad copy | Hamming <= 4 = near-dup | dedup/textual.ts |
| L3b — Meta collapse | Same advertiser ID + same creative text | Exact = collapse | dedup/textual.ts |
| L4 — Cross-search | Exclude videoId / urlHash from prior SearchResult rows | Any prior = seen | Job processor |

### Dedup Order

```
1. L1 exact check
2. L2 visual pHash check + L2b CLIP cross-check
3. L3 textual SimHash check + L3b Meta collapse
4. L4 cross-search (mark as "seen")
5. If count < 20 -> trigger refill loop
```

### Refill Loop

```ts
while (deduped.length < target && attempts < MAX_ATTEMPTS && elapsed < timeBudgetMs) {
  const more = await collector.collect(nextQueries, {
    target: target - deduped.length,
    seenIds,
    timeBudgetMs: timeBudgetMs - elapsed
  });
  deduped.push(...applyDedupLayers(more.videos));
  attempts++;
}
// Return whatever we have with honest stats
```

### Vitest Unit Tests

| Test | What it verifies |
|---|---|
| exact-id-collision | Two videos with same platformId -> only one in output |
| url-hash-collision | Different IDs but same urlHash -> deduplicated |
| resized-thumbnail-near-dup | Same thumbnail at different resolutions -> pHash Hamming <= 6 |
| same-ad-different-id-collapse | Same advertiser + same copy under two IDs -> one record |
| refill-loop-tops-up | Dedup drops from 20 to 14 -> refill loop -> output has 20 |
| cross-search-exclusion | Video from search A excluded from search B by default |
| seen-toggle-includes | With showSeen=true, previously seen video appears |

### Deliverables
- [ ] dedup/exact.ts, dedup/visual.ts, dedup/textual.ts — all layers implemented
- [ ] Refill loop integrated into job processor
- [ ] All 7 unit tests passing
- [ ] Repeat search on same product returns 0 overlap with first search

---

## Phase 5 — Backend API & Job Orchestration (Day 3)

> Worth 15 marks.

### Goal
Clean REST + SSE API. Full pipeline orchestrated as a single BullMQ job with named-stage progress events.

### API Endpoints

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| POST | /api/search | { query, queryType, imageFile? } | { searchId } | Validates input, enqueues job |
| GET | /api/search/:id | — | { status, results[], productInfo } | Poll for results |
| GET | /api/search/:id/events | — | SSE stream | Progress events per stage |
| GET | /api/history | ?page&limit | { searches[] } | Paginated past searches |
| POST | /api/shortlist | { searchId, videoIds[] } | { ok } | Save selected videos (bonus) |
| GET | /api/shortlist/export | ?format=csv or json | File download | Export shortlist (bonus) |

### SSE Progress Events

```ts
type ProgressEvent =
  | { stage: "validate";  status: "done" }
  | { stage: "resolve";   status: "done"; product: ProductInfo }
  | { stage: "brain";     status: "done"; attributes: ProductAttributes }
  | { stage: "collect";   status: "progress"; source: string; got: number; wanted: number }
  | { stage: "collect";   status: "done"; got: number; wanted: number; shortfall?: number }
  | { stage: "dedup";     status: "done"; before: number; after: number }
  | { stage: "score";     status: "progress"; scored: number; total: number }
  | { stage: "score";     status: "done" }
  | { stage: "persist";   status: "done" }
  | { stage: "done";      results: SearchResult[] }
  | { stage: "error";     error: { code: string; message: string; hint: string } }
```

### BullMQ Pipeline

```
SearchJob
  1. validate(input)
  2. resolveProduct(input)          -> emit { stage: "resolve", status: "done" }
  3. imageBrain(product.imageUrl)   -> emit { stage: "brain",   status: "done" }
  4. collect([instagram, meta, tiktok?])  <- Promise.allSettled
                                    -> emit per-source progress events
  5. dedup(merged)                  -> emit { stage: "dedup", before, after }
  6. score(deduped, product)        -> emit scoring progress
  7. persist(scored)                -> emit { stage: "done", results }
```

### BullMQ Job Config

```ts
{
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: false,
  removeOnFail: false,
  timeout: 5 * 60 * 1000,   // 5 min hard cap
}
```

### Cross-Cutting Requirements

| Concern | Implementation |
|---|---|
| Structured logging | pino with requestId on every log line |
| Error response shape | { error: { code, message, hint } } everywhere |
| API rate limiting | express-rate-limit: 30 req/min on search endpoints |
| Secrets | .env only — never hard-coded |
| ToS compliance | Code comments citing each source rate limit guidance |

### Deliverables
- [ ] All 6 endpoints working (tested with curl / Postman)
- [ ] SSE stream delivers events in correct order for a full search run
- [ ] BullMQ job completes end-to-end for 3 test products
- [ ] pino logs show requestId on every line

---

## Phase 6 — React Dashboard (Day 4)

> Worth 10 marks.

### Goal
Responsive, real-time dashboard. Surfaces all results, shortfalls, and errors explicitly.

### Components

| Component | File | Behaviour |
|---|---|---|
| SearchBar | SearchBar.tsx | Text input (keyword/URL) + image upload; detects input type; Submit triggers POST /api/search |
| ProductPanel | ProductPanel.tsx | Shows title, product image, attribute chips; visible once brain stage completes |
| ProgressIndicator | ProgressIndicator.tsx | SSE-driven stepper: Validate -> Resolve -> Brain -> Collect -> Dedup -> Score -> Done |
| ResultsGrid | ResultsGrid.tsx | Tabs per source; live counter "14/20"; amber < 20, red < 10; shortfall reason inline |
| VideoCard | VideoCard.tsx | Thumbnail; inline playback or link-out; caption; platform badge; score badge; reason ALWAYS visible |
| FilterBar | FilterBar.tsx | Sort by score/platform/newest; min-score slider (0-100); client-side filtering |
| SearchHistory | SearchHistory.tsx | Sidebar of past searches; click to reload; shows product title + timestamp |
| SeenToggle | SeenToggle.tsx | Toggle "Show previously seen videos"; off hides cross-search dups; on shows them with label |

### UX Requirements

| Requirement | Detail |
|---|---|
| Shortfall visibility | Counter amber at < 20, red at < 10; text: "Got 14/20 — Instagram rate-limited after query expansion" |
| Error states | Every error has a next step: "Bot blocked -> try image upload instead" |
| Empty states | "No results — try a broader keyword or upload the product image" |
| Loading states | Skeleton cards while scoring; spinner on collect stage |
| Responsive | Works at 768px tablet width and above |
| Score reasons | reason field always visible on VideoCard — not behind hover |
| No silent failures | Source with 0 results shows "0/20 — source unavailable" not just empty tab |

### Deliverables
- [ ] All 8 components rendered correctly in a full search run
- [ ] SSE events drive ProgressIndicator in real time
- [ ] ResultsGrid shows per-source tabs with live counters
- [ ] SeenToggle correctly shows/hides previously seen videos
- [ ] Responsive at 768px

---

## Phase 7 — Evidence & Documentation (Day 5)

> Worth 10 marks — but backstops every other phase.

### eval/run.ts — Evidence Script

#### Test Products (6–8, mix of keyword and URL)

| # | Product | Input Type | Why |
|---|---|---|---|
| 1 | Floral print midi dress | URL (Shopify) | Apparel with distinctive graphic |
| 2 | Trail running shoes | URL (brand site) | Shoes with specific colorway |
| 3 | Wireless noise-cancelling headphones | Keyword | Gadget/electronics |
| 4 | SPF 50 tinted moisturiser | URL (brand site) | Cosmetics — subtle visual attributes |
| 5 | Organic peanut butter jar | Keyword | Packaged food — label is key signal |
| 6 | Vintage band tee | Keyword | Apparel — logo/text critical |
| 7 | Matcha powder bag | URL (Shopify) | Deliberately hard: low-contrast packaging |
| 8 | Generic blue t-shirt | Keyword | Edge case: tests shortfall path |

#### Output Table (eval/output/results.md)

| Product | IG Got | IG Wanted | Meta Path | Meta Got | Meta Wanted | Post-Dedup | Avg Score | Shortfall | Runtime |
|---|---|---|---|---|---|---|---|---|---|
| Floral dress | — | 20 | fallback | — | 20 | — | — | — | —s |
| Running shoes | — | 20 | fallback | — | 20 | — | — | — | —s |

Re-run >= 2 products a second time to prove uniqueness (zero overlap in platformIds).

### Screenshots Required (eval/output/screenshots/)

| File | Content |
|---|---|
| match-1.png | Clear good match — VLM reason references visible product attributes |
| match-2.png | Clear good match — different product category |
| match-3.png | Good match at "possible" threshold (amber badge) |
| miss-1.png | Bad match — one-line explanation of model error |
| miss-2.png | Bad match — different failure mode |

### README Sections

| Section | Required Content |
|---|---|
| Setup | git clone -> cp .env.example .env -> fill 3 keys -> docker compose up -> open localhost:5173 |
| Architecture diagram | Client -> API -> BullMQ -> worker -> [collectors] -> dedup -> scorer -> SQLite |
| Per-source method | Instagram: Apify actor, why; Meta: official API -> fallback, why fallback is mandatory |
| Rate limit & failure handling | Timeout values, backoff formula, circuit breaker thresholds, UI on failure |
| Brain design | Two-stage diagram, CLIP + VLM roles, scoring formula, why 0.4/0.6 split |
| Calibration numbers | Filled calibration table from Phase 2 |
| Dedup strategy | All 4 layers, thresholds, refill loop behavior |
| Test results | Vitest output + eval/run.ts table |
| Known limitations | Meta official API coverage (honest); when/why fallback kicks in; CLIP miss cases |
| What is next | 3-5 concrete improvements if given more time |

### Demo Video (3–5 minutes)

| Timestamp | Content |
|---|---|
| 0:00 – 0:30 | Keyword search: type query, watch SSE pipeline, 20+ results appear |
| 0:30 – 1:30 | URL search: paste URL, product panel populates, results scored |
| 1:30 – 2:15 | Repeat keyword search: prove zero overlap with first run |
| 2:15 – 2:45 | Toggle "Show previously seen": hidden videos appear with label |
| 2:45 – 3:15 | Trigger shortfall: "14/20 — expanded 5 queries, still short" |
| 3:15 – 3:45 | Show one clear match (score 0.87, reason visible) and one miss (score 0.21) |
| 3:45 – 5:00 | README walkthrough: calibration table, limitations, docker compose up |

> No real API keys/tokens visible in the video at any time.

### Deliverables
- [x] eval/output/results.md — filled table for all 6-8 products
- [x] eval/output/calibration.md — precision/recall table
- [x] eval/output/screenshots/ — 5 screenshots (3 match, 2 miss)
- [x] eval/output/run2-overlap.md — proof of zero overlap on second run
- [x] README fully written with all sections
- [ ] Demo video recorded and linked in README
- [x] .env.example has every key, no real values

---

## Final Submission Checklist

> Check every box before submitting.

### Collectors
- [ ] Meta collector does NOT silently rely on the official API alone
- [ ] Every Meta result carries metaPath: "official" or "fallback"
- [ ] Fallback triggered immediately when official returns < 5 results (not lazily)
- [ ] TikTok gated by ENABLE_TIKTOK; never crashes pipeline when disabled

### Brain & Scoring
- [ ] Every reason string comes from VLM image comparison — not caption keywords
- [ ] finalScore = 0.4 x CLIP + 0.6 x VLM documented in README with justification
- [ ] Calibration table (precision/recall) committed and referenced in README
- [ ] Thresholds not silently adjusted to hit 20-result target

### Deduplication
- [ ] Near-duplicate dedup beyond exact ID (pHash + SimHash layers implemented)
- [ ] Refill loop wired up and demonstrably works (test passing)
- [ ] Repeat search on same product returns 0 overlapping video IDs

### UI
- [ ] Shortfalls visible in UI ("14/20") — never hidden
- [ ] Reason text always visible on VideoCard (not behind hover)
- [ ] SeenToggle works and correctly shows/hides cross-search duplicates
- [ ] Error states have a next-step hint

### Infra & Security
- [ ] .env.example has every required key documented
- [ ] docker compose up works on a fresh clone with no extra steps
- [ ] No real API keys/tokens committed anywhere in repo
- [ ] No real keys visible in demo video
- [ ] SSRF protection covers all redirect hops (not just original URL)

### Evidence
- [ ] eval/run.ts committed and runnable
- [ ] eval/output/results.md committed with real numbers
- [ ] Second-run uniqueness proof committed
- [ ] 5 screenshots (3 match, 2 miss) with honest one-line captions
- [ ] README limitations section honest and specific

---

## Key Design Decisions & Rationale

### Why Hybrid Vision (CLIP + VLM)?

| Approach | Problem |
|---|---|
| CLIP only | Misses semantic attributes: text on garment, logo, specific pattern names |
| VLM only for all 40 candidates | Too slow (5-10s per call x 40 = 3-7 min) and too expensive |
| CLIP bulk -> VLM top-N | Fast filtering + accurate verification; cost-proportional to quality |

### Why VLM Weighted at 60%?
CLIP similarity is a proxy signal. The VLM actually looks at both images simultaneously and reasons about them. Weighting it higher aligns the final score with the strongest signal.

### Why Meta Fallback Is Load-Bearing
The official Meta Ad Library API guarantees coverage for political/electoral/issue ads and EU DSA transparency ads. General commercial video ads outside the EU are not reliably indexed. A system relying solely on it will silently return 0-3 results for most product searches.

### Why Fixture Mode Matters
Live scraping sources can be rate-limited, temporarily down, or geo-restricted on grader machines. USE_FIXTURES=true ensures consistent evaluation from saved responses.

### Why SQLite (Not PostgreSQL)?
- Zero infra setup — no separate DB container
- Prisma abstracts it — trivial to swap to PostgreSQL
- CLIP embeddings as Bytes (raw float32 binary) — fine at < 10k rows

---

## Marks Breakdown

| Phase | Area | Marks |
|---|---|---|
| Phase 2 | Image-analysis brain (CLIP + VLM, scoring formula, calibration) | 25 |
| Phase 3 | Video collectors (Instagram + Meta + resilience + expansion) | 25 |
| Phase 4 | Deduplication (4 layers + refill loop + tests) | 15 |
| Phase 5 | Backend API + job orchestration + SSE | 15 |
| Phase 6 | React dashboard (8 components + shortfall UI) | 10 |
| Phase 7 | Evidence + documentation (eval script + README + demo) | 10 |
| **Total** | | **100** |

> Bonus: Docker Compose one-command run, TikTok collector, shortlist export

---

*Last updated: 2026-09-29*
