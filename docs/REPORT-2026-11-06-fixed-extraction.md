# Fixed extraction — 2026-11-06

Full HP1 rebuild with JSON-constrained decoding and the entities/facts schema. This supersedes
the malformed baseline bank; it is **unjudged** (all relations are `needs_review`).

Artifacts:

- `testing/banks/hp1-fixed-2026-11-06.db`
- `testing/banks/hp1-fixed-2026-11-06.log`

## Run

Same shape as the baseline: `qwen3.5:9b`, 66 windows, seed 42, 8,192 output budget, 32k context,
single stream. Elapsed **3,609 s (~60 min)**, faster than the baseline's 70 min because fewer
windows were retried/incomplete.

New in this run:

- `format: 'json'` on every extraction call, all three paths.
- A JSON schema for the entities+facts call: `maxItems 30` entities, `maxItems 12` facts.
- Entities+facts gets up to 2× the run budget (capped 16k).

## Comparison

| metric | baseline | fixed |
|---|---:|---:|
| entities | 264 | **359** |
| characters | 89 | **109** |
| items | 65 | 152 |
| rules | 59 | 32 |
| locations | 30 | 42 |
| species | 10 | 14 |
| creatures | 8 | 4 |
| factions | 3 | 6 |
| relations | 135 | 111 |
| facts | 185 | **430** |
| timeline | 302 | 359 |
| threads | 339 | 428 |
| notes | 415 | 485 |
| entities with a relation | 51 | 57 |
| **incomplete windows** | **44** | **6** |

Failure modes:

| failure | baseline | fixed |
|---|---:|---:|
| `partial-array` | 53 section occurrences | **0** |
| `finish-length` | 11 | 3 |
| `unparsed-answer` | 3 | 0 |
| Ollama `token repeat limit` | 0 | 2 |
| `mixed-entries` | 0 | 2 |

The malformed-JSON class is gone. What remains is six windows: three hit the output cap
(entities+facts), two relations calls were aborted by Ollama's repeat limit, and two relations
calls produced mixed entries.

## Coverage

Characters rose from 89 to 109, and three previously missing names appeared: **Dean Thomas,
Seamus Finnigan, Nearly Headless Nick**.

Still missing (12): Lucius Malfoy, Lavender Brown, Parvati Patil, Padma Patil, the Bloody Baron,
Griphook, Katie Bell, Alicia Spinnet, Professor Sprout, Hannah Abbott, Ernie Macmillan,
Justin Finch-Fletchley.

The schema cap is being spent on props: **152 of 359 entities are items** (65 before). The model
fills its 30 slots with things rather than people. That is now the main selection problem.

## Relations

111 relations, down from 135. Distribution:

| kind | count |
|---|---:|
| acquaintance | 53 |
| friend of | 12 |
| member of | 10 |
| student of | 6 |
| enemy of | 6 |
| nephew / colleague | 3 each |
| spouse / son / sister / rival / niece / mentor / brother / ally | 2 each |
| protective / peer | 1 each |

`acquaintance` remains 48% of the bank. `member of` is new. The two aborted calls and two
mixed-entry calls cost an unknown number of rows; that explains part of the drop from 135.

## Verification

- `PRAGMA quick_check`: ok
- 111 relations, all `needs_review`
- 6 incomplete windows out of 66

## Next

1. **Entity selection:** stop items from consuming the cap. Either a separate props array with its
   own small cap or an explicit per-kind limit; people and places first.
2. **Relation retries:** on `token repeat limit` and `mixed-entries`, retry the relations section
   once with a lower repeat budget or fewer relation labels.
3. Judge this bank, apply alias groups, run the worker, then compare true ties against the 65-row
   calibration.
