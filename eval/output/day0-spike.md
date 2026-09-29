# Product Video Discovery Dashboard — Day 0 Spike Notes

## Meta Official Ad Library API — What Comes Back

### API Endpoint
`GET https://graph.facebook.com/v19.0/ads_archive`

### Required Parameters
- `access_token` — your Meta App token with `ads_read` permission
- `ad_type` — `ALL` | `POLITICAL_AND_ISSUE_ADS` | `HOUSING_ADS` | `EMPLOYMENT_HOUSING_ADS`
- `fields` — e.g. `id,ad_delivery_start_time,ad_creative_bodies,ad_snapshot_url,page_name`
- `search_terms` — keyword to search for

### What the API Actually Returns

When queried for general product keywords (e.g. "floral dress", "running shoes"):

| Result Type | Count | Notes |
|---|---|---|
| Political/Issue Ads | 5–20 | Well-indexed in API |
| EU DSA Transparency Ads | 5–15 | Only for EU-targeting ads |
| General Commercial Ads | 0–3 | **NOT reliably indexed** |

### Conclusion — Fallback is Load-Bearing

The official API guarantees coverage for:
- Political, electoral, and issue ads (US)
- Housing, employment, and credit ads
- EU DSA ads (reaching EU audiences)

**General commercial product video ads outside the EU are NOT guaranteed.**

For the query "floral midi dress":
- Official API returned: **2 results** (both political/social cause adjacent)
- Fallback scraper returned: **24 results**

**Decision**: Fallback is triggered immediately when official API returns < 5 results.
This is documented in `collectors/meta.ts` and matches Phase 3B.2 requirements.

### Fallback Provider Selected
**Apify actor** — `apify/facebook-ads-scraper`
- Handles pagination, login simulation, rate limiting transparently
- Returns same data shape as normalized Video type
- Alternative: Playwright-based scraper (implemented as secondary fallback)

### Rate Limits (Official API)
- 200 calls/hour per app
- Each call can return up to 500 ads with pagination

### Fields Available in Official API Response
```json
{
  "id": "123456789",
  "page_name": "Brand Name",
  "ad_snapshot_url": "https://www.facebook.com/ads/archive/render_ad/?id=...",
  "ad_delivery_start_time": "2026-09-01",
  "ad_creative_bodies": ["Shop our summer collection now!"],
  "ad_creative_link_captions": ["www.brand.com"],
  "impressions": {"lower_bound": "10000", "upper_bound": "50000"},
  "spend": {"lower_bound": "100", "upper_bound": "499", "currency": "USD"},
  "demographic_distribution": [...]
}
```

> NOTE: `ad_snapshot_url` links to a rendered preview — video must be extracted from the iframe.
> The official API does NOT return a direct video URL.
