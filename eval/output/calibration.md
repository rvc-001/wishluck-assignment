# Calibration

Generated: 2026-09-29

The scoring code uses:

```text
finalScore = 0.4 * clipSimilarity_normalized + 0.6 * vlmScore_normalized
```

Fixture-mode unit tests verify threshold behavior and dedup/refill behavior, but a statistically meaningful precision/recall calibration requires a hand-labeled set of real product/video pairs. That live labeling pass has not been performed in this workspace.

| Threshold | Precision | Recall | F1 | Status |
|---:|---:|---:|---:|---|
| 0.50 | pending | pending | pending | requires labeled real pairs |
| 0.55 | pending | pending | pending | requires labeled real pairs |
| 0.60 | pending | pending | pending | chosen threshold in code |
| 0.65 | pending | pending | pending | requires labeled real pairs |
| 0.70 | pending | pending | pending | requires labeled real pairs |

## Current Verification

- Threshold labels are implemented in `computeFinalScore`.
- VLM visual verification is now the worker scoring path for both URL/image and keyword searches.
- Caption-only keyword scoring remains as a helper, but the worker no longer uses it for final ranking.
