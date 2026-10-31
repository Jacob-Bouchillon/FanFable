# Grading claimed ties with an external model

The citation gate proves a quote and a chunk, not that the relationship is true.
This exports every citable claim as a **blind** packet so another model (or a
human) can grade it against its passage, and scores what comes back.

## 1. Export (read-only)

```
node --no-warnings testing/trials/grade-claims/export-packets.ts <db> <project> [outDir]
```

Writes to `outDir`:

| file | audience | contents |
|---|---|---|
| `grade-packets.md` | the judge | instructions, codebook, every packet |
| `packets.jsonl` | API use | one packet per line, for per-request batching |
| `sample.csv` | scorer convention | `id,pair,stratum,pop_weight,locators` (census, weight 1) |
| `key.csv` | **local only** | id → relation ids and the hidden signal |

The packet carries the pair, the claimed kind, the quote and the cited passage.
It carries no review status, confidence, assessment or human flag, and ids are
shuffled with a fixed seed, so packet order and wording give the judge nothing.

## 2. Grade

Upload or paste `grade-packets.md` into the model. It asks for one CSV block:

```
id,verdict,quote,locator,reason
P001,B,"exact sentence(s) from the passage",p. 12,ok
P002,C,,,cooccurrence
```

- **A** one sentence states the relationship
- **B** the passage establishes it across more than one sentence
- **C** not established (co-presence, moment, wrong kind, same person)
- **D** cannot tell from the passage

Save the reply as `verdicts.csv`.

## 3. Score

```
node --no-warnings testing/trials/grade-claims/score-verdicts.ts <outDir>/key.csv verdicts.csv
```

Prints overall A/B/C/D, precision with a Wilson interval, the same precision
split by the hidden signal (human / assessed / sentence-proof / none), and every
C pair with its reason. `PENDING` when verdicts are missing; it never invents one.

## 4. Record the verdicts in the court

```
node --no-warnings testing/trials/grade-claims/import-verdicts.ts <db> <project> <outDir>/key.csv verdicts.csv --write
```

Writes one `verdict/external/blind-passage` ruling per graded claim, using the
`claim_id` column the exporter puts in `key.csv`. Add `--demote-c` to move a C
claim to `needs_review`; it never demotes a `user_confirmed` row. Dry run
without `--write`.

## 5. Relabel the pairs the judge called "wrong kind"

```
node --no-warnings testing/trials/grade-claims/relabel.ts <db> <project> <outDir>/key.csv verdicts.csv --write
```

Selects the claims graded C with reason `kind`, asks the project's model what the
passage states, and replaces only the label. Each change writes a
`relabel/assessor` ruling. Dry run without `--write`.

## 6. Fill anchor sentences

```
node --no-warnings fanfable/src/cli.ts --db <db> --project <name> lore anchors --write
```

For a quote that names one person, stores the sentence in the same chunk that
names the other; for a quote naming neither, stores a sentence that names both.
Code-only, nearest-sentence rule, no model. Dry run by default; a snapshot backup
is written before any anchor moves.

The verdicts then appear in `lore docket`, and `lore docket --backfill` seeds a
`charge` for any relation that predates the court record.

## Acting on the result

- **A/B** keep the row citable. B should get its two sentences stored as the
  anchor, which is also the missing `anchor_evidence` for that row.
- **C** demote to `needs_review` with the reason; the gate was wrong, not the book.
- **D** leave the row where it is and flag it for a human.

Do not send `key.csv` to the judge: it is the answer key for the analysis, not
part of the task.
