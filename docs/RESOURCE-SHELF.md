# Resource shelf — models, datasets, recipes we keep

**Written 2026-10-31.** Companion to `WEBS-AND-THREADS.md` and `RESEARCH.md`. This is the
triage record of every model, dataset and repository considered for the evidence web, with the
job each one earns and the evidence behind it.

**Reading rule.** *Measured* means we ran it locally and the number is ours, with counts.
*Reported* means the author's own figure on their own card, never reproduced here. Licences are
as the card states them; verify before any redistribution.

**Status at writing.** Live bank: 492 relations. Names with a proof-grade tie (accepted,
attested or user-confirmed): **91 of 182 = 50%**. Target: 128 (70%).

---

## Selection rule

A resource earns a place only if it does one of four jobs **and** runs on the box (16GB VRAM,
CPU lane, English prose, permissive licence):

1. **Propose** candidates at scale.
2. **Judge** a candidate pair.
3. **Veto** inventions.
4. **Measure** — outside truth to score against.

Fifth category: **recipes** we can train ourselves with. Everything else was rejected on
domain, size, licence, or absence of evidence.

---

## 1. Judges — the assess chair

| | GLiClass v4 Edge | relweave-4b-zeroshot | GLiDRE |
|---|---|---|---|
| Size / runtime | 0.4B, ONNX, CPU-capable | LoRA on Qwen3-4B, 4-bit native | ~300M (gte-base) |
| Input | state + label names + instruction | passage + entities + our definitions | full document + mentions + labels |
| Output | calibrated probability per label | yes/no probability per pair × type | relations between supplied mentions |
| Reported | triple relevance 90.6; NLI yes/no 89.2; fact-check 87.0; rerank R@1 92.7; Decision Index 47.5 (best ≤1B) | 0.82 short fictional passages; 0.74 dense; 0.50–0.56 Re-DocRED | paper only (DocRED/Re-DocRED); no card numbers |
| Speed | 11 ms per decision | ~19 ms per question, packed | not stated |
| Licence | Apache-2.0 | Apache-2.0 | Apache-2.0 |
| Weakness | policy-style judgment 64.0; hallucination head 58.6 | English only; fictional benchmark is 150 passages | unproven locally; cost grows with pairs × types |

All three were benched. Result: GLiClass AUC 0.727 on the frozen 58, rising to **0.775** on 90 rows
after the harness's claim string and passage window were fixed; relweave could not run without CUDA
torch; GLiDRE left 40 of 58 spans unlocatable. Verdict: **sort order only, never a gate** — a judge
cannot see that a row's arrow points the wrong way. Full record: `ASSESSOR-BENCH.md`.

**Rejected in this slot:** fixed-schema extractors (business, biomedical, DEI, code), models
with no published accuracy, and anything that needs a knowledge base fiction does not have.

---

## 2. The valve — catching inventions

| | GLiNER2 relation verifier | Vela3-fast |
|---|---|---|
| Job | score a claimed (head, relation, tail) against text | unsupported-claim spans, evidence, NER |
| Reported | false-positive rate 50% → 14% at 0.55 (P75 / R44); 0.6 → P80 / R36; 0.75 → P87 / R21 | 0.889 unsupported-claim F1; NER 62.3 OOD-7; 14 ms |
| Size | DeBERTa-base + MLP | 0.4B encoder |
| Licence | Apache-2.0 | Apache-2.0 |

**The valve's yardstick: NuExtract3**, kept as a reference and not as a part. It lost the
discovery duel but is the only model we have **measured** that abstains: **40 of 50 packets
declined**, against Spark's 2 of 50. That abstention rate is what a calibrated "no" looks like,
and it is the reference point when setting the verifier's threshold.

**Negatives both need:** ARF's 35,230 no-relation chunks — the invention-rate number that is
missing behind every gate decision taken so far.

---

## 3. The mapper — measured and dropped

**GLiNER-Linker large** (DeBERTa-v3-large bi-encoder, Apache-2.0) was the candidate for the
identity door. It has since been measured and dropped, because the loss it was meant to fix is not
a linking loss.

**Where the 93% actually goes** — the same whole-book output, broken open:

| what a BookNLP "character" cluster is | count |
|---|---|
| no proper-name mention at all ("the old man", pronouns) | 3,091 of 3,647 |
| named, but a species / organisation / place mislabelled as a person | 323 |
| named and one of our roster characters | 219 |
| non-person | 14 |

Our adapter already maps **185 of those 219** named roster clusters (84%). A mention linker asked
to choose among 182 character names for "the Muuns" would produce bad merges, not coverage. The
real gap is that BookNLP does not resolve *descriptions* to names — a coreference problem, not a
linking one, and its own README says the default avoids it on purpose because full coreference
conflates characters.

Measured description attempts, all below bar: BookNLP full coreference (56 joins in 3,279
clusters), BookNLP big model (4 joins on the test slice), fastcoref/LingMess (16 joins, 2 wrong),
our pairwise model (63.5% correct, 35% wrong person, 30% correct on hard negatives).

**One correction to earlier numbers:** "27,848 of 28,807 pronouns linked" counted pronouns assigned
to *any* cluster, including anonymous ones. Of the 27,848, only **14,405 (52%)** sit with a named
person; 5,157 sit with a description that never gets a name and 8,286 in clusters with neither.
That 96.7% figure should not be quoted as pronoun-to-character accuracy.

---

## 4. Proposers and sweepers

| Resource | Status | What it gives | Numbers |
|---|---|---|---|
| BookNLP (upstream) | measured, in use | 3,647 clusters; 10,005/10,005 quotes attributed; 178 candidates staged | 26 banked hits of 209 (0.124); speakers 0.85 blind; both forks byte-identical. Pronouns: 52% of mentions sit with a named person |
| GLiNER-Relex large | bench | joint spans and labelled relations, zero-shot | 25.6 average end-to-end |
| tiny-graph-extractor 0.8B | bench | 0.5GB, sweeps whole books, free-form triplets | 0.796 vs Gemini 2.5 Flash Lite 0.858; 8/200 parse failures |

Q8 needs 6.4 seconds per call and cannot sweep a book; the 0.8B can, which is what the 91
uncovered names need.

---

## 5. Spans, names, attribution

- **GLiNER 2.5 multi** — span floor, multilingual, permissive licence; bench only, because name
  finding is not the bottleneck (roster covers ~87%).
- **spaCy + coreferee** — the plumbing under BookNLP and a possible second coreference opinion;
  unmeasured.
- **BookNLP speaker attribution** — 34/40 blind (0.85); in production use as a candidate source.
- **UAR character embeddings** (`gasmichel/UAR_scene`, `UAR_Play`) — trained voice fingerprints.
  Our general-embedding probe failed (nomic: same/cross gap 0.03, top-1 0.18), and their paper's
  premise is precisely that general embeddings fail; untested here. The group's EMNLP 2024 follow-up
  (`deezer/character_embeddings_qa`) injects these into a quotation-attribution model, but its
  successor — ModernBookNLP, already queued — reports 94.5% on the same benchmark, so the embedding
  route is a product idea (does this line sound like this character?), not the attribution test.
- **DramaCV** — the drama corpus behind UAR. Not needed for the pretrained weights; needed only
  if the UAR probe fails and fingerprints must be fine-tuned here.

---

## 6. Ground truth and measuring stations

| Resource | Contents | Licence | Role |
|---|---|---|---|
| ARF (`Despina/project_gutenberg`) | 95,475 annotated chunks, ~128k relations, 48 types, 35,230 negatives, 96 novels | MIT | precision/recall and invention rate |
| PG-Fiction relations | 162,866 rows, 48 labels, 0/2/5-shot prompts | public-domain texts + MIT component | label mapping, few-shot exemplars |
| Biographical (`Despina/biographical`) | ~238k rows, human-annotated literary/biographical relations | MIT | the closest thing to gold labels; its own measuring slot |
| LitBank / BookCoref / PreCo | book-scale coreference annotations | CC-BY (LitBank) | E1 binding yardstick |
| CoNLL scorers | official coreference evaluation | — | the metric |
| re_littune | 1.39M rows, 1.18GB | shareable, no LDC sources | training slice, few-shot |
| frontier-re-generations | 28.8MB of GPT-5.4 / Sonnet 4.6 / Gemini 2.5 outputs | provider terms | free frontier baseline |

PG-Fiction's labels are model-made (silver). Biographical is the one with human labels, which
makes it the stronger evaluation set and the weaker training set.

---

## 7. Recipes — proven elsewhere, buildable here

1. **Acervo (Qwen3.5-9B QLoRA)** — ~1,000 examples, 3 epochs, r=16, trained on a 5070 Ti 16GB:
   our base model and our card. Includes ~90 empty-output examples (teaches "nothing here"),
   `existing_id` dedup awareness, and strict enums for entity and relation types.
2. **relweave schema-as-classes** — docstrings become definitions; prompts and grammars derived;
   generator plus a **veto head** plus a tagger for long lists; new-domain recipe published.
3. **code-daemon suite** — four transferable methods: marked-entity pair classifier with a
   trained NO_RELATION class; link selector that can decline; frozen encoder plus a 384-number
   word filter; train on your own retriever's uncertain band.
4. **GRPO with a rule-based reward** (tiny-graph, Agents-K1) — format, validity and F1 as the
   reward; no gold labels and no human preference data needed.

---

## 8. Design references (ideas only, no code adopted)

- **LoreGraph** — verification gate, span anchoring, eight-pass pipeline. Cloud LLM and
  Postgres; not adopted.
- **narrative-atlas** — `ExtractionSpec` shape, scenes and arcs, deterministic merge with counts.
- **narrative-entity-extraction** — both-parts-10× rule, possessive confirmation, tier reasons
  carried on rows.
- **Novel_Analysis** — spaCy hints framed as *confirm or correct*, narrator rule, verbatim quotes
  with locators.
- **Renard** — modular pipeline steps, dynamic time-sliced networks; its co-occurrence tie theory
  is rejected.
- **ChaRelEx** — per-pair sentiment over time (rolling, delta, time gap): the one unobserved
  dimension of our pair threads.
- **xcore / bookcoref / lrec2020-coref** — book-scale coreference code and evaluation.

---

## 9. The machine, assembled

| Stage | Part | State |
|---|---|---|
| Ingest | our chunker, windows of 8 | running |
| Names | roster, variants, guarded identity; hint framing, both-parts rule | running |
| Bind | BookNLP chains measured; xCoRe and coreferee untested | partial |
| Voice | BookNLP speakers 0.85; UAR untested | partial |
| Relations | our three passes; BookNLP candidates staged; sweepers benched | running |
| Web | threads, notes, meetings, births, periods, open ends | running |
| Proof | checker, 0.7 bar, grades, court | running |
| Review | queue, richest-first, reasons kept | running |
| Brief and plan | graded sections with citations | running |
| Map | unbuilt | — |

---

## 10. Test queue — what ran, what remains

**Run:**

1. **Assessor bench** — GLiClass Edge scored, relweave blocked (needs CUDA torch), GLiDRE 40/58
   spans unlocatable. GLiClass AUC 0.727, then 0.775 on 90 labelled rows after two harness bugs
   were fixed. Verdict: sort order only, never a gate.
2. **Mapper probe** — dropped. See §3: the named clusters are already mapped, and the rest are
   not names.
3. **Descriptions** — four approaches measured, none clears the bar (BookNLP small/big, fastcoref,
   pairwise). Stage recorded as unsolved.

**Still queued:**

4. **Speakers** — ModernBookNLP graph attribution (reported 94.5% on PDNC); must lift named-speaker
   share above 66.8% and survive a blind check of 40 changed attributions.
5. **Valve bench** — GLiNER2 verifier vs Vela on held-aside rows and ARF's 35,230 negatives; this
   is the invention-rate number still missing behind every gate decision.
6. **ARF station** — build once, then score every future change there.
7. **Own worker** — QLoRA on our bank with the Acervo recipe, our kinds, only after 4–5.
8. **Identity and evidence rebuild** — Stage A roster repair, Stage B re-gather evidence per
   relation using every alias, Stage C re-derive relation and direction. Current work; see
   `PIPELINE-PLAN.md` §6a.

---

## 11. Operational notes (not in any card)

- BookNLP on a modern box: CPU-only torch from the CPU index, `--no-deps`, a stale
  `position_ids` load bridge (fired on 3 of 3 taggers, nothing else), `TMPDIR=/dev/shm` to dodge
  the pip quota, and `num_ctx=16384` because the stock 4k truncated answers mid-array.
- NuExtract3 needed image-processor dependencies even for text, and its thinking output lands in
  `reasoning`, not `content`; native `/api/chat` with `think:false` is the fix.
- GGUF precision: Q8 keeps logits crisp for single-pick outputs; our ladder agrees — BF16 to Q8
  cost nothing, Q8 to Q4 cost 40% of note yield.
- Every harness writes a manifest with model, precision, seed, context, counts and commit. That
  rule saved two runs from being unreproducible.

---

## Left out

About two dozen link entries were rejected and are not listed: wrong domain (biomedical, DEI,
code search, historical newspapers, dreams, forms), wrong size for the card (29B, 31B), licence
blocking product paths (CC-BY-NC-SA, GPL), or no evidence at all (unfilled cards, 0.09-F1
fine-tunes, cards that state they are not for production).

Corrections welcome. Any figure marked reported should be re-verified on its card before it is
depended on.
