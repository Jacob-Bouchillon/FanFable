# Baseline bank — 2026-11-06

First full-book extraction with the token-cap fix, saved as the reference point for experiments.
The bank is **unjudged**: every relation is `needs_review`; no case-file verdicts have been applied
to it.

Artifacts:

- `testing/banks/hp1-baseline-2026-11-06.db` — the bank (4.7 MB)
- `testing/banks/hp1-baseline-2026-11-06.log` — the extraction log

## The run

```bash
FANFABLE_REL_STRICT=1 FANFABLE_ABLATE_ENDPOINT=1 FANFABLE_ABLATE_ENTAILMENT=1 \
node --no-warnings fanfable/src/cli.ts \
  --db <copy of source-only fanfable.db> --project hp1 \
  lore extract --model qwen3.5:9b --full \
  --max-tokens 8192 --seed 42 --concurrency 1 --legacy --trace
```

- model: `qwen3.5:9b` (Q4_K_M)
- context: 32,768 (6.7 GB measured, under the 8 GB ceiling)
- output budget: 8,192 per section call
- windows: 66 (8 chunks each, 526 chunks total)
- elapsed: 4,184 s (~70 min)

## Results vs the previous bank

| metric | previous (`hp-full`) | baseline (`hp-cap`) |
|---|---:|---:|
| entities | 139 | **264** |
| characters | 84 | 89 |
| items | 27 | 65 |
| rules | 1 | 59 |
| locations | 14 | 30 |
| species | 8 | 10 |
| creatures | 4 | 8 |
| factions | 1 | 3 |
| relations | 124 | **135** |
| facts | 3 | **185** |
| timeline entries | 287 | 302 |
| threads | 210 | 339 |
| thread notes | 277 | 415 |
| entities with at least one relation | 46 | 51 |

## What the cap fix actually changed

The previous run hit a hard output clamp on **every** section call:

```text
entities-facts   Math.min(1600, maxTokens)
relations        Math.min(3000, maxTokens)
timeline         Math.min(1200, maxTokens)
```

The clamps were removed, `lore extract` gained `--max-tokens`, and the default context went to
32k. Effect on the failure modes:

| failure | previous | baseline |
|---|---:|---:|
| `finish-length` (hit the cap) | 65 windows | **11** |
| `partial-array` (malformed / cut JSON) | 5 | **53 section occurrences** |
| `unparsed-answer` | 1 | 3 |

So the cap was one cause and it is largely fixed: finish-length dropped from 65 windows to 11.
The remaining failure is **malformed JSON**, not token budget — 44 of 66 windows still ended with
at least one partial section:

- entities-facts: 23 windows (9 finish-length, 14 partial-array)
- relations: 23 windows (2 finish-length, 21 partial-array)
- timeline: 21 windows (18 partial-array, 3 unparsed)

Raising the cap further will not fix that. The next lever is constrained/JSON decoding or a
repair-and-retry pass on a partial array.

## Coverage — the cast problem remains

Characters went from 84 to 89, and the minor cast is still absent:

**Still missing:** Lucius Malfoy, Dean Thomas, Lavender Brown, Parvati Patil, Padma Patil,
Nearly Headless Nick, the Bloody Baron, Griphook, Katie Bell, Angelina Johnson, Alicia Spinnet,
Professor Sprout, Hannah Abbott, Ernie Macmillan, Justin Finch-Fletchley.

Seamus Finnigan is now present. The growth in entities is mostly **not people**: items went
27 → 65 and rules 1 → 59. The extractor is treating props and rule-fragments as entities while
the background students stay out.

Only **51 of 264 entities** have any relation. The relation layer is still centred on the same
small group.

## Relation kinds

135 relations; the largest bucket is still the weakest:

| kind | count |
|---|---:|
| acquaintance | 53 |
| friend of | 14 |
| enemy of | 11 |
| brother of | 10 |
| colleague of | 8 |
| student of | 6 |
| relative of | 6 |
| nephew of | 6 |
| ally of | 5 |
| child of | 3 |
| trusted / distrusted / disliked | 2 each |
| teacher / spouse | 1 each |

`acquaintance` is 39% of the bank and is the kind we already decided to retire. All rows are
`needs_review`.

## Code shipped with this baseline

### Extraction

- `fanfable/src/cli.ts` — `--max-tokens` for `lore extract`
- `fanfable/src/lorebook.ts` — section output clamps removed (six sites)
- `fanfable/src/core/llm.ts` — default context 16k → 32k

### Judging trial

- `testing/trials/claim-confidence/pipeline.ts` — model-outer loop (5.1× faster, same votes) and
  `--filters` mechanical dedup (symmetric duplicates, duplicate pair+kind)

### Web mechanism (read-only; no writes)

- `fanfable/src/product/web3d.ts` — person dossier, relationship map, non-character filtering
- `fanfable/src/product/server.ts` — `/api/web/person`, `/api/web/map`
- `fanfable/src/ui/web3d-map.html` / `web3d-map.js` — person-to-person map, 73 pair-lines from
  124 relations, family colours, status styling
- `fanfable/src/identity/alias-groups.ts` — deterministic alias groups (16 groups, 34 entities)
- `fanfable/src/identity/alias-context.ts` — quote-backed candidate validation
- `fanfable/src/web/thread-worker.ts` — `starvedThreads` queue worker (dry-run, idempotent)
- `fanfable/src/web/chapter-index.ts` — character ↔ chunk/chapter index (Harry: 468 appearances,
  17 chapters)

The map and dossier numbers above were measured on the previous judged bank (`hp-nue`); the
baseline bank has not been through the judge yet.

## Verification

- `PRAGMA quick_check` on the baseline copy: **ok**
- `npm run typecheck`: passed
- `TMPDIR=/tmp/opencode npm test`: **1531 passed, 0 failed**

## Known issues

1. **Malformed JSON in 44/66 windows.** The dominant remaining extraction failure.
2. **Character recall unchanged.** The minor cast is still missing; entity growth is props/rules.
3. **`acquaintance` is 39% of relations** and should be retired or resolved to a specific kind.
4. **59 rule entities** — the extractor is turning rule-fragments into entities.
5. **Alias groups not applied.** The 16 groups exist as a report only; the map still shows
   `Harry` and `Harry Potter` as two nodes.
6. **Worker not run on this bank.** Queue is ready; no notes written.
7. **Judge not run on this bank.** All relations are `needs_review`.
8. Untracked large directories (`testing/trials/valve-bench` ~23 GB, `coref-probe/data` ~116 MB)
   are deliberately excluded from the commit.

## Next

1. Fix JSON validity (constrained decoding or repair pass) and re-run only the partial windows.
2. Chase character recall with a span pass (GLiNER-Relex, Apache-2.0) rather than a bigger
   generative model.
3. Apply alias groups + quote-backed linking; then the worker; then the judge.
4. Re-measure precision on a labelled sample of this bank before any further tuning.
