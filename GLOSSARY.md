# FanFable glossary

Locked with the user. Plain words win over code words.

## Categories

- **stuff** — the things the pipeline handles (passages, windows, bank, keepers, parked, thin names). The nouns; what gets worked on.
- **worker** — any piece that does work on readings: reading, checking, ranking, re-reading, reporting, deciding. Workers propose, order, or report — they never own the bank. What banks is decided by the strict checker plus your review.
- **records** — where history and pending work live (chain, notes, quarantine). The memory.
- **measuring** — how we know what's true and what's better (arms, spikes, duels, frozen sheet, counts-only, baseline, recall, precision, over-refusal, unsupported). The yardstick.

## Stuff

- **passage** — one chunk of the book (~220 words).
- **window** — 8 passages read together by the reader.
- **bank** — saved readings (people, ties, quotes); status says what each row is worth.
- **keeper** — a tie the strict checker confirmed with exact quotes, or that you confirmed with your word plus a quote (user-confirmed). Sentence-level proof or your word; nothing else counts.
- **attested** — a passage-proof tie: the quote states the tie and is verbatim, both names in the cited passage. Citable with its quote plus passage scope shown, below keeper, above provisional. Never keeper-grade.
- **defined relationship** — the only grade answers may state: a closed kind (aide of, master of, sibling of, ally of, lover of…), banked as keeper. If it isn't keeper-grade, it isn't stated.
- **mention** — an `appears_with` edge: two names in one passage, no relationship claimed. Coverage, never evidence. Parked-grade by default, invisible to answers.
- **lover** — an intimate tie, not married. Spouse means married; the words are not interchangeable — N44 was filed as spouse and corrected.
- **parked** — a tie candidate held back, with a note saying why. Invisible to answers, never deleted.
- **thin name** — a person with no saved ties.

## Workers

- **reader** — the 7B that reads windows and writes down people, ties, quotes.
- **strict checker** — the proof rule: no bank without a quote naming who and stating the tie. Never bare "gate."
- **muzzle** — the prompt-level answer rule: no CONFIRMED tie without bank backing or a both-endpoints quote, no identity jumps.
- **answer guard** — code behind the muzzle: rewrites an unproven CONFIRMED into an abstain and keeps the original below for audit.
- **scorer** — free code ranking windows by shared names. Picks what gets read, costs nothing.
- **handoff** — the checklist file between runs (windows read, thin names + where, keepers with quote/place/flag). Orders re-reads, never changes the bank.
- **enrich** — re-reading one person's passages. The loopback: extract → diagnose finds thin/shaky → handoff remembers order → enrich re-reads → new readings land.
- **diagnose** — the what's-missing report.
- **relabel** — one more closed-vocabulary pass over parked notes with the full passage.
- **merge** — combining same-person rows. Only ever with your say-so.
- **RAGmodel** — the 4B bouncer: reads question plus passages, says Answer, Retrieve, or Stop. Never writes lore. Never bare "gate."
- **span** — an exact pointer into the text: start, end.
- **finder** — the CPU pointer (GLiNER spike): finds name-spans with offsets. Can only point, can't invent.
- **sidecar** — an isolated helper process outside the repo code. Nothing wired without your say.

## Records

- **chain** — the logbook: what was read, in what order, which clue-chain led to each answer. Read-only history, no pending work, judges nothing.
- **notes** — the inbox: parked tie files, quarantine dossiers, diagnose warnings, each with status + reason + evidence. The relabel pass works this pile.
- **quarantine** — the holding pen for same-name pairs. The machine refuses to merge them; they wait for your ruling. Their dossiers live in the notes.

## Measuring

- **arm** — one test run, plain or ordered.
- **spike** — a small cheap test of one thing on frozen ground, before any wiring.
- **duel** — two models on identical ground: same windows, same judge.
- **bar** — the adopt condition a spike must clear to ship.
- **seed** — the fixed number (42) that makes every sampled run reproducible.
- **frozen sheet** — the 20 fixed questions plus what each should do. Scores change only by written procedure.
- **counts only** — numbers reported, never quotes or passages.
- **baseline** — the locked reference everything is judged against. Currently the 90-window qwen run: 255 people, 2 keepers, 112 parked.
- **cited** — the answer stating a tie with its exact quote and place.
- **abstain** — the answer saying the tie isn't established, with what's missing.
- **recall** — how much of the book's truth got found.
- **precision** — how much of what's banked and said is actually true.
- **over-refusal** — said "can't answer" when the proof was there.
- **unsupported** — answered when the proof wasn't there.
