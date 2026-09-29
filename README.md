# Product Video Discovery Dashboard

> **One-command Docker run. Grader-safe. Evidence-first.**

## Quick Start

```bash
# 1. Clone and configure
git clone <repo-url>
cd wishluck-assignment
cp .env.example .env
# Fill in your 3 API keys (see .env.example for instructions)

# 2. Start everything
docker compose up

# 3. Open dashboard
open http://localhost:5173
```

## API Keys Required

| Key | Where to get it | Cost |
|---|---|---|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) | **Free tier** |
| `APIFY_API_TOKEN` | [Apify Console](https://console.apify.com/account/integrations) | Free plan ($5/month credit) |
| `META_AD_LIBRARY_ACCESS_TOKEN` | [Meta Developers](https://developers.facebook.com/) | Free |

---

## Architecture

```
Client (React + Vite)
    │  POST /api/search
    ▼
Express API (Node + TypeScript)
    │  Enqueue job
    ▼
BullMQ Worker (Redis)
    │
    ├── 1. resolveProduct(input)     → Product { title, imageUrl, description }
    │         └── JSON-LD → OG → Cheerio heuristic → Playwright fallback
    │
    ├── 2. imageBrain(imageUrl)      → { attributes, embedding }
    │         └── Gemini Flash Vision (attribute extraction) + Text Embedding (CLIP proxy)
    │
    ├── 3. collect([instagram, meta])  ← Promise.allSettled
    │         ├── Instagram: Apify actor → normalized Video[]
    │         └── Meta: official API → fallback Apify if < 5 results
    │
    ├── 4. dedup(merged)             → L1 exact + L2 pHash + L3 SimHash
    │
    ├── 5. score(deduped, product)   → CLIP bulk pass → VLM top-15 verify
    │         └── finalScore = 0.4 × CLIP + 0.6 × VLM
    │
    └── 6. persist(scored) → SQLite via Prisma
              │
              └── SSE stream → client ProgressIndicator → ResultsGrid
```

---

## Per-Source Method

### Instagram Reels
- **Method**: Apify `instagram-reel-scraper` actor
- **Why Apify**: Handles Instagram's login wall, rate limits, and dynamic rendering transparently. Direct Playwright scraping is blocked aggressively.
- **Fixture mode**: `USE_FIXTURES=true` uses `fixtures/instagram-sample.json`

### Meta Ad Library
- **Method**: Official API first → immediate fallback if < 5 results
- **Why fallback is mandatory**: The official API guarantees coverage for political/electoral/issue ads and EU DSA ads. General commercial video ads outside the EU are not reliably indexed. Typical result: **0–3 results** for product keyword searches.
- **Fallback**: Apify `facebook-ads-scraper` actor using a Meta Ad Library URL
- **Path tracking**: Every video carries `metaPath: "official" | "fallback"`

---

## Brain Design

### Two-Stage Diagram

```
Product Image
    │
    ▼ Stage A (once per product, cached 48h)
Gemini Flash Vision (`VISION_MODEL`, defaults to `gemini-3.5-flash-lite`)
    │ → ProductAttributes { productType, colors, patterns, logoOrText, ... }
    │ → searchQueries[], adKeywords[]
    │
    ▼
Text Embedding (`EMBEDDING_MODEL`)
    │ → 768-dim embedding vector (CLIP proxy)
    │
    ▼ Stage B (per-video)
40 candidate thumbnails
    │
    ▼ CLIP bulk pass (cosine similarity)
    │ → Ranked list
    │
    ▼ Top 15 → VLM Verification
Gemini Flash Vision (product image + video frame)
    │ → { score: 0-100, same_product: bool, reason: string }
    │
    ▼ finalScore = 0.4 × CLIP + 0.6 × VLM
```

### Scoring Formula

```
finalScore = 0.4 × clipSimilarity_normalized + 0.6 × vlmScore_normalized

clipSimilarity_normalized  = CLIP cosine similarity (already in [0,1])
vlmScore_normalized        = vlmScore / 100

Threshold:
  >= 0.60 → Match    (green badge)
  0.40–0.59 → Possible  (amber badge)
  < 0.40 → Discard
```

### Why 0.4/0.6 Split?
CLIP similarity is a fast proxy signal — it's good at filtering clearly irrelevant videos but can miss semantic attributes (logo, specific pattern name, text on garment). The VLM actually sees both images simultaneously and reasons about them. Weighting it higher (0.6) aligns the final score with the strongest available signal.

---

## Rate Limits & Failure Handling

| Source | Limit | Timeout | Backoff | Circuit Breaker |
|---|---|---|---|---|
| Instagram (Apify) | 50 results/run | 30s actor, 10s request | exp backoff, 3 attempts | opossum (Phase 5+) |
| Meta Official API | 200 calls/hour | 10s | exp backoff, 3 attempts | — |
| Meta Fallback (Apify) | 50 results/run | 90s actor | exp backoff, 2 attempts | — |
| Gemini Flash Vision | Google AI free tier | 30s | exp backoff, model fallback | — |

**On failure**: UI shows `"0/20 — source unavailable"` (never empty tab). SSE emits `{ stage: "error", error: { code, message, hint } }`.

---

## Dedup Strategy

| Layer | Method | Threshold |
|---|---|---|
| L1 — Exact | Platform video ID OR SHA-256 of normalized URL | Identical = dup |
| L2 — Visual pHash | pHash/dHash of thumbnail; Hamming distance | ≤ 6 bits = repost |
| L2b — Visual CLIP | CLIP cosine similarity | > 0.95 = dup |
| L3 — Textual SimHash | SimHash on normalized caption | Hamming ≤ 4 = near-dup |
| L3b — Meta collapse | Same advertiser + same ad copy | Exact = collapse |
| L4 — Cross-search | Exclude videoId seen in prior SearchResults | Any prior = seen |

**Refill loop**: If post-dedup count < 20, expands queries up to 10 attempts or time budget.

---

## Calibration Numbers

See [eval/output/calibration.md](eval/output/calibration.md). Current file documents the implemented scoring formula and the remaining live hand-labeling pass.

---

## Test Results

See [eval/output/results.md](eval/output/results.md). Current fixture evidence covers six product searches with 20 Instagram results and 20 Meta results each after the balanced collection/dedup/scoring pipeline. Run `npx ts-node eval/run.ts` against a running backend with live keys for final live-source numbers.

---

## Bonus Features

- **Docker setup**: `docker compose up` runs Redis, backend, and frontend.
- **Shortlist saving**: `POST /api/shortlist` stores selected videos for a search.
- **Shortlist export**: `GET /api/shortlist/export?searchId=<id>&format=csv|json` downloads saved shortlist results.

---

## Known Limitations

1. **Meta official API coverage**: As documented in `eval/output/day0-spike.md`, the official API returns 0–3 results for most product keyword searches. The fallback scraper is load-bearing and will trigger for nearly every query.

2. **CLIP proxy**: We use Gemini text embeddings on attribute descriptions as a CLIP proxy (true CLIP requires a Python sidecar or ONNX runtime). This is semantically strong but not identical to visual embedding. A real CLIP model would improve accuracy.

3. **Instagram rate limits**: Apify free plan limits to ~50 results/run. For niche products, the expanded query loop may still fall short of 20 results — the UI shows this honestly with a shortfall counter.

4. **Vision model free tier**: Defaults to `gemini-3.5-flash-lite`, with Flash and Gemma 4 fallbacks when available. For faster runs, lower `VLM_TOP_N`.

5. **Calibration evidence**: The code path and threshold formula are implemented, but final precision/recall numbers still require a hand-labeled live sample.

---

## What's Next (Given More Time)

1. **Real CLIP model** — Python FastAPI sidecar with `clip-as-service` for true visual embeddings instead of text proxy
2. **TikTok collector** — Finish `ENABLE_TIKTOK=true` path with full circuit breaker
3. **Frame extraction** — `ffmpeg` integration for 2–3 frame sampling per video (Phase 2.7)
4. **Auth & multi-user** — User sessions so each user has their own search history

---

## Development Setup (Without Docker)

```bash
# 1. Start Redis (requires Docker for Redis only)
docker run -d -p 6379:6379 redis:7-alpine

# 2. Backend
cd backend
cp ../.env.example ../.env  # fill keys
npm run db:push             # create SQLite DB
npm run dev                 # starts on :3001

# 3. Frontend
cd frontend
npm run dev                 # starts on :5173
```

*Last updated: 2026-09-29*
