# Ask template (frozen)

Exact wording per pair:

> "status of A to B as of chapter X"

where X is the asked-as-of chapter from `pairs.md` (early = Part Three, p. 18-19 span; late = p. 440+ span).

Required output shape per ask:

- `label` — one closed-vocabulary kind, or `abstain`.
- `quote` — exact span-verified quote from our text, or empty on abstain.
- `locator` — chunk locator resolving to a passage (e.g. `p. 172`), or empty on abstain.
- `scope` — chapter/part scope the claim holds in.

Rules: no tuning, no weight changes during the probe. Lazy mining capped (2 windows per ask). Determinism scope: code paths bit-deterministic; LLM prose excluded from frozen comparison (compare structure: row counts by status, quote-verification outcomes, reason codes — never token equality).
