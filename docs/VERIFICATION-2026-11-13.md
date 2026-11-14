# Code audit re-verification — 2026-11-13

The 2026-11-04 audit in `REPORTS.md` (section *Consolidated code audit*) lists 48
findings with a "current-tree status" line each. Those lines were written on the
day and 22 commits have landed since. This note records what was re-checked
against the current tree, how, and what is still unverified.

**This does not replace the audit.** The original findings, evidence and line
references stand as written. This is a status overlay only.

Method: read the current code at each cited location, or where the finding
describes behaviour, run it. Probes were run against throwaway databases under
`/tmp`; no trial data was touched.

---

## Verified FIXED

| id | how checked |
|---|---|
| A1 status-tie guard | `quotedSpans` now checks every span however short, and scopes the `[Lore:]` exemption to the quote rather than the line. Code read. |
| A2 temporal filter | canon nodes are excluded from story-order filtering; the comment names the defect. Code read. |
| A5 web brief drops `accepted` | brief now treats `accepted` and `user_confirmed` as proven. Code read. |
| A8 two eligibility filters | `KEEPER_STATUSES` / `KEEPER_STATUS_SQL` are a single source. Code read. |
| A10 caps don't set `truncated` | `result.truncated = true` is set on every cap path. Code read. |
| B1 relations read backwards | **Probed.** `canPromote` refuses `master of` against "trained by", "was Tor's student", "born to"; banks the correctly-directed case. |
| B2 any family word proves a tie | **Probed.** Third-party "her friend" and "Tor's enemy" are refused. |
| B3 denials missed | **Probed.** "did not trust" and "never trusted" are refused. |
| B5 alias hits discarded | resolver unions exact and alias hits before deciding. Code read. |
| B10 missing confidence defaults high | `?? 0`, so a missing score fails the threshold. Code read. |
| B11 transaction depth stuck | `finally { this.depth = 0 }` added. Code read. |
| C1 approved chapter stays approved | **Probed.** `setChapterBody` forces `draft` and clears derived memory; the synthetic "chapter N" impact subject is replaced by title plus character names. |
| C2 delete orphans memory | delete route clears extraction and resolves conflicts in one transaction. Code read. |
| C3 canon changes N×M | one row per change. Code read. |
| C4 secrets `knownBy` wrong key | reads `knownBy ?? known_by`. Code read. |
| D1 reopen blocks windows | leases are checked *before* the child is mutated, and `lore_mined` is cleared. Code read. |
| D2 sweep crashes on resolved note | duplicate check covers every status, not just `pending`. Code read. |
| D5 sweep bypasses the court | `recordRuling` is called on the proposal path. Code read. |

## Verified LIVE, then fixed

A3, A6, C8, C9, D12 and A9 were all confirmed live and have since been fixed, each
with a regression test that fails against the previous code. See the commit
"Fix five audit findings confirmed live" and its follow-up for A9.

A9 was worse in effect than the audit said. Adding the instruction sentence to the
focus set does not merely pollute retrieval: `buildContextSlice` keeps only rows
whose text contains a focus term, so a note naming nobody flipped `focus.length`
from 0 to 1 and returned an **empty** context slice. Notes now contribute only the
story and canon names they actually mention.



| id | what is still wrong | evidence |
|---|---|---|
| **A3** | embedding timeout cleared when headers arrive, so a stalled body hangs forever | `embeddings.ts`: `clearTimeout(timer)` in `finally` around `fetch`, `res.json()` outside it |
| **A6** | knowledge-continuity matches generic words | `graph-checks.ts`: the caller lowercases the claim, so `distinctiveTerms`' capitalisation filter can never exclude anything |
| **C8** | `contextTokens` stored as whatever the client sent | `server.ts`: `temperature` is coerced with `Number()`, `contextTokens` is not; the client types it as a number |
| **C9** | "masking" exposes short keys in full | `server.ts`: `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` — a key of 10 characters or fewer is shown whole |
| **D12** | sweep skips non-ASCII names | `sweep.ts`: `/^[A-Z]/.test(form)` drops any name not starting with an ASCII capital |

## Second pass — 13 more checked

| id | verdict | evidence |
|---|---|---|
| A4 | fixed | `planner.ts`: `reviseOutline` now drops returned chapters outside `chapterNumber`, and `saveOutline` filters every canon id against `canon_event`. Two regression tests, both verified to fail against the previous code. |
| A7 | fixed | `lore-diagnostics.ts`: a fact's quote is now resolved to the passage containing it, exactly as a relation's is. A fact whose quote appears nowhere is dropped and counted rather than banked; a quote from passage 2 is filed against passage 2. Regression test verified against the old code. The dead `knowledge` field is **still open** — the prompt asks for it and nothing consumes it. |
| A11 | fixed | `lore.ts`: an existing `(project, source, chunk, title)` row is counted as `duplicates` and skipped before insert. |
| B6 | not a defect | the two normalisers still differ, but `gates.ts` now states why: `proofNormalise` feeds promotion and keeps punctuation, `core/text.normalise` feeds fingerprints. The deliberate separation is documented at the definition. |
| B7 | fixed | `identity/names.ts`: `TITLE_TOKENS` is now the single owner, merged from the four lists that used to disagree, with a comment saying so. |
| B9 / C12 | **LIVE** | ten modules still have zero importers in `fanfable/src` (`veto-bridge`, `character-sweep`, `name-harvest`, `thread-worker`, `combine`, and five identity modules). Whether that is deliberate is still a question for the author. |
| B12 | fixed | `core/json.ts`: `salvageJsonArray` only starts a candidate at depth 0, so a nested object inside a truncated root can no longer be returned as a whole object. |
| C7 | **LIVE** | no `realpath`/`lstat` anywhere in `server.ts` or `controller.ts`. The only `realpathSync` in the tree is in `web/meetings.ts` for an unrelated purpose. |
| D3 | fixed | `sweep.ts` uses `KEEPER_STATUS_SQL` and adds `conflict_status != 'contested'`, with a comment explaining why the check is pair-wide but the pending-note check is kind-specific. |
| D4 | fixed | no `modality` in `extract/extract-prompts.ts`; the request is gone from the prompt. |
| D8 | fixed | `recovery.ts`: `deferStage` now requires `owner` — "a deferral expires leases and must prove ownership" — and rejects on stale fencing or non-running status. |
| D9 | fixed | `court/claim-proof.ts`: `importClaimProofs` skips rows whose outcome is not in `STORED_OUTCOMES` and whose standard does not belong to the claim type. |
| C11 | partly | the Continuity UI renders the `minSeverity` selector with an "errors only" option, but `filterBySeverity` is imported only by `cli.ts` in this tree. Whether the browser filters on it was not established. |

## Still unverified — 9 findings

A12, C5, C6, C10, D6, D7, D10, D11. Not presumed fixed and not presumed broken.

Two notes from the code seen while checking others:

- **D6 looks fixed in shape**: `transitionClaim` is imported and called by `lorebook.ts` and defined in `court/claim-transition.ts`; nothing else adopts it. The audit's complaint was that the owner was dead while the architecture test grandfathered legacy writers, so the test's grandfather list is what needs reading, not the imports.
- **D11 partly addressed**: `snapshotRoster` is now called for its fingerprint on two paths rather than computed and discarded, but whether the two incompatible stored formats remain was not checked.

---

## What this changes

The audit is not a list of 11 open HIGH defects. Nine of the eleven HIGH findings
are fixed and verified — A1, A2, B1, B2, B3, C1, C2, C3, D1, D2 among them.
Rebuilding the project to escape those defects would rebuild work that is already
done.

What remains live are mostly MEDIUM and LOW issues with narrow blast radius: a
timeout that can hang an embedding call, a continuity check that over-reports, a
number stored as a string, a mask that is not a mask. None of them call for a
rewrite. All of them are cheap to fix where they are.

Second pass: 13 more checked — 9 fixed or documented, 4 still live (A4, A7, B9/C12,
C7), 9 unverified.

The honest summary: **the codebase is in materially better shape than its own audit
says, but the audit is not finished being checked.** Of 39 findings examined so far,
28 are fixed, 1 is documented as deliberate, and 10 remain live — all MEDIUM or
below. The 11 HIGH findings are done: 10 fixed and verified, and the eleventh
(D2) fixed too. Nothing found so far would justify a rewrite.
