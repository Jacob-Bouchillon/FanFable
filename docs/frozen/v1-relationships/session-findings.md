# Session findings — full record (2026-10-26, one sitting)

Everything below was measured, not opined. Where a number appears, it came from
a run listed with its command or artifact. Where judgment appears, it is labeled.

## 1. Locked and green (committed as 720957978 + f1d7e51)

- **Integrity batch:** FK enforcement on every open; atomic re-import / re-approve /
  chapter write; failed windows stay unmined; status single-shot; server jail +
  body caps + bounded lists; mine-before-verdict with conditional skip.
- **Thin slice:** deterministic composition (ORDER BY + smallest-middle-wins);
  `triplePassages()` from existing source_refs (no migration); frozen ordering
  (verified → corroboration capped 5 → density → id); gap finder fires on
  zero-tie pairs with resolving locators; kinship groups de-conflated;
  quarantine blockers surfaced.
- **Courtroom v0:** migration v12 (ledger_state/scope/superseding_chapter,
  scoped unique index); cursor-paged relabel with no-resolve-without-row;
  evaluateTies skips `user_confirmed`; ~20-rule checker, flags-only;
  audit notes by default.
- **Sheet fixes (4):** flagged-invisible to status/ranking; attachment
  pair-check + peer/colleague vocab (human-gated); terminal verbs event-only;
  directed status as separate currents (undirected history kept).
- **Verification re-run:** 0 gate violations across the accepted bank.
  Scores: 3 cited (1 label-variant, 1 directed-reverse, 1 sheet-correction),
  13 correct-abstains, 3 recall misses (model variance, unresolved 10).
  See `verify-2026-10-26.md`.
- **Suite:** 276/276 green, `tsc` clean for `fanfable/src` at commit time.

## 2. Close-the-loop (wired, VERIFIED 2026-10-26: suite 276/276, tsc clean for fanfable/)

Inline gap-driven re-read at the end of `extractLore`: gap entities
(0 ties, or 1 tie with mentions > 3) → tight gate (same-sentence name+cue,
mined passages only) → cap 5 entities × 4 passages via existing enrich path,
never throws, audit lines appended. See `close-the-loop.md` for the full
measurement record (cue hit rates 124/122/75→66→14, cost table, emission vs
coverage verdict). The Tarkin pinned re-read (seq 664–671 reset + mined:
6 entities, 4 relations, aide banked accepted with exact quote) is the
behavioral evidence; the wired loop itself now has a green run (276/276,
2026-10-26) and may be cited.

## 3. Contamination probe (qwen2.5:7b, the incumbent)

No-context QA 1/8 (weak hit only: 11-4D is a droid), confabulation controls
4/4 abstained, verbatim completion 0/3. No parametric memory of the book;
v1 citable as system-on-text recall (small-n caveat). Full table in
`contamination.md`.

## 4. Caps / quotas sweep (the tuning that concluded nothing)

Fresh rebuild + same 12-window seed extract, 20 asks, bank-only vs mined:
bank-only 19/20, mined 18/20 over 33 windows (~468s). Mining added zero wins
and one loss (direction-via-undirected-reader; directed view separates it).
Corroboration is 1 on all 53 banked ties → caps 3/5/uncapped identical.
Verdict recorded: touch nothing. Bank answers; mining is insurance that did
not pay on this sheet.

## 5. Model evaluations (all read-only except where noted)

- **NuExtract3 safetensors (8B, local, transformers+CUDA):** pinned window,
  13 ties with exact quotes (both aides, Kim mentor verbatim, benefactor,
  grooming, Dugs/Darnada family). Open vocab, split entities
  (Vidar|Kim, Jedi Ronhar), one ambiguous direction. Recall matched nothing
  else tested; precision ungraded line-by-line.
- **NuExtract3 GGUF Q4_K_M via Ollama (3.5GB, Apache-2.0):** same window,
  ~12 relations with exact quotes, 7.5s wall (~190 tok/s), zero new stack.
  Format compliance imperfect (markdown not JSON, cut at 2000 tokens);
  direction ambiguous as safetensors.
- **33-window free-vs-free duel (identical ground, both unmuzzled):**
  NuExtract 186 verifiable quotes (~182s) vs qwen free 118 (~146s).
  qwen feast-or-famine (11/33 windows yielded zero verifiable, 4 unparseable);
  NuExtract yielded on 32/33. Verdict: wire NuExtract as the relations
  extractor behind the existing gates. NOT YET IMPLEMENTED — awaits grant.
- **Wider-window stress:** 2x input → filler loop, zero ties. 4x input →
  confident hallucination (invented Sidious mission, wrong book ID).
  Operating point is ~8 passages; the loop design already assumes it.
- **Format duel:** strict one-line markdown scored 0 (model uses labeled
  fields instead — better target: parse fields, don't dictate lines).
- **qwen unmuzzled (free prompt, pinned window):** ~30 ties in 17s including
  Kim mentor verbatim — recall the constrained path never reached — plus one
  flat falsehood (Kim as father) and 8 junk "senator" ties. Conclusion:
  muzzle the bank, never the reader. This is the same verdict as the
  NuExtract wiring: free recall, gated banking.
- **NuExtract3-W4A16 (compressed-tensors):** DOES NOT RUN here. Checkpoint
  recipe skips linear_attn quantization but the installed stack expects
  packed format → unmapped weights + dequant crash (size 0 vs 32).
  Fixing = version surgery on shared ComfyUI Python. Dropped.
- **NuExtract3-mlx-mxfp8:** Apple-only (MLX). Wrong hardware. Dropped.
- **NuExtract3-W8A8:** same 4B family, Apache-2.0, heavier stack than GGUF,
  no reason to prefer. Not tested.
- **NuNER Zero (0.3B GLiNER NER):** wrong job (spans, not relations).
  Backlogged for entity-quality work only.
- **GLiNER-relex (0.3B joint NER+RE, Apache-2.0, CPU, ONNX):** the
  interesting one — scored spans are free evidence, closed label list fits
  our vocabulary, runs anywhere. Backlogged as the triage-layer candidate.
- **GLiNER core (urchade/GLiNER):** entity spans only. Backlogged with relex.
- **LoRA discussions:** per-book LoRA rejected (breaks verifiability, training
  per book, corrections require retraining). Skill-LoRA across books left
  open as future work. Book-LoRA = contamination installed on purpose.

## 6. Deferred, in order

GLiNER-relex triage → NuExtract wiring → caps/quotas tuning → wider enrich →
low-resource IE paper list as research backlog. Correctness first; no new
machinery while the sheet has open failures. Source: zjunlp/Low-resource-KEPapers
(mirrors our architecture: direct inference, task-as-QA, data-efficient models).

## 7. Standing judgments

- Precision is solved (0 wrong surfaced on the verification re-run).
- Recall is the open problem (3 frozen misses + variance run to run).
- The bank is the exam; any future extractor — NuExtract included — sits it,
  gated, with the frozen sheet as judge.
- Nothing in this file relaxes the evidence rule: no bank without a
  span-verified quote, regardless of model.
