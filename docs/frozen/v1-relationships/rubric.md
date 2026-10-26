# Rubric (frozen)

Verdict per ask, ternary:

- `correct-cited-scoped` — right label, exact quote verifies in our text, locator resolves, scope pinned.
- `correct-abstain-with-evidence` — no tie in text and the answer abstains (nearest evidence shown or no-coverage stated). Pending-on-flagged counts as abstain, not wrong.
- `wrong-or-uncited` + subclass — anything else. Subclass required:
  - `alias` — merged or confused two distinct names.
  - `direction` — right pair, reversed arrow.
  - `scope` — right pair+label, wrong chapter/era.
  - `quote` — label without a verifying quote, silent noun, or paraphrase presented as quote.

Abstention standard: a flagged (`needs_review`) or unplaced row never counts as an answer. No current with a pending flag behind it.

Re-read trigger: endpoint-thin quotes (#10 pattern — correct label, quote names neither endpoint) trigger a targeted enrich before the verdict counts as cited. A thin quote banks nothing new until a both-endpoints quote confirms it.
