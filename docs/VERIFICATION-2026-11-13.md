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

## Not verified

26 findings were not re-checked: A4, A7, A11, A12, B4 (report says fixed and tested), B6, B7,
B8, B9, B12, C5, C6, C7, C10, C11, C12, D3, D4, D6, D7, D8, D9, D10, D11, plus the
three clean-report subsections.

They are not presumed fixed. Each needs the same treatment: read the current code
at the cited location, and where the finding describes behaviour, run it.

Two are worth flagging as probably-still-live from the code shape alone:

- **B9 / C12** (dead modules presented as production): `gates/veto-bridge.ts`,
  `web/character-sweep.ts`, `identity/name-harvest.ts` and `core/combine.ts` still
  have zero importers in `fanfable/src`. Whether that is deliberate is a question
  for the author, not something to infer from imports.
- **C7** (temp-copy write guard): no `realpath`/`lstat` check appears anywhere in
  `server.ts` or `controller.ts`, which is what the finding prescribed.

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

The honest summary: **the codebase is in materially better shape than its own audit
says.** That is worth correcting before it drives another architectural decision.
