# Second-Run Overlap

Generated: 2026-09-29

The implementation now excludes prior search results by default:

- Prior videos are loaded from `SearchResult` joined to `Video`.
- Collector calls receive a `seenIds` set.
- A post-collector `filterPreviouslySeen` pass protects against collector implementations that do not mutate the shared set.
- The dashboard exposes a "Show previously seen videos" toggle that sends `showSeen: true`.

## Automated Verification

Vitest coverage:

- `cross-search-exclusion hides previously seen videos by default`
- `seen-toggle-includes previously seen videos`

## Live Proof Pending

Run the same product twice through the running app and record the platform IDs here. The expected default overlap is 0. With the UI toggle enabled, previously seen videos should reappear.
