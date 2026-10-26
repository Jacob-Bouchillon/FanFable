# Changelog (procedure-change log)

- 2026-10-26 v1 freeze: 20 pairs, selective extract (12 windows, seed 42) + capped probe mining. 3 cited / 14 abstained / 3 known failures. No tuning, no weight changes.
- 2026-10-26 #3 enrich: re-read 6 Tarkin passages via enrichEntity (maxPassages 6); relations:0, facts:2 — aide tie confirmed-miss, recorded above, no gate loosened.
- 2026-10-26 #7 gate: closed role-noun list (kinship + titled roles + peer/colleague + aide/apprentice/partner/assistant/master/operative); unlisted kinds park as open-vocab. Encourager/acknowledger classes pending by construction.
- 2026-10-26 contamination probe (qwen2.5:7b): no-context QA 1/8 (weak hit only), confabulation 4/4 abstain, verbatim completion 0/3. No parametric memory of the book; v1 citable as system-on-text recall (small-n caveat).
- 2026-10-26 caps sweep (fresh rebuild + same 12-window seed): bank-only 19/20 vs mined 18/20 over 33 windows (~468s). Mining added zero wins and one loss (Plagueis/Sidious direction-wrong apprentice via the undirected reader; directed status separates it). Sole bank miss: Jabba partner (recall, mining didn't recover it either). Corroboration is 1 on all 53 banked ties, so caps 3/5/uncapped are identical — no cap change. Tuning verdict: touch nothing; bank answers, mining is insurance. Next: directed-reader opt-in + Jabba enrich, not quotas.
- 2026-10-26 #10 enrich: 6 Jabba passages via enrichEntity; relations:0, facts:1 — partnership confirmed-miss, recorded above.
- Every future deviation (reworded asks, changed budget, gate edits affecting verdicts) gets an entry here with date + reason. Scores never edited without one.
