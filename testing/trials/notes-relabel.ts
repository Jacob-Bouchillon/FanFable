/**
 * Notes-relabel pilot, trials only.
 *
 * Takes parked failures from a bank — moment labels and quote-silent nouns —
 * and re-asks the model once per note with a CLOSED universal relationship
 * list plus the proving passage. Forced choice: one label from the list, or
 * "unresolvable", with an exact quote from the passage. No database writes;
 * count-only output. Cap is small on purpose: this measures whether the pass
 * recovers anything before any table gets built.
 *
 * Usage:
 *   NOTES=8 PROJECT=book-coord-no-notes node --no-warnings testing/trials/notes-relabel.ts
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { CLOSED_TIE_LABELS, isMomentKind, isUnsupportedKind } from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

const CLOSED = CLOSED_TIE_LABELS;

const bank = process.argv[2] ?? process.env.PROJECT ?? 'book-coord-no-notes';
const CAP = Number(process.env.NOTES ?? 8);

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const t0 = Date.now();
try {
  const id = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', bank)?.id;
  if (!id) throw new Error(`no bank named "${bank}"`);
  const rows = db.all<{
    rid: number; f: string; t: string; kind: string; evidence: string; refs: string;
  }>(
    `SELECT r.id AS rid, fe.name AS f, te.name AS t, r.kind AS kind,
            r.evidence AS evidence, r.source_refs AS refs
       FROM canon_relation r
       JOIN canon_entity fe ON fe.id = r.from_entity
       JOIN canon_entity te ON te.id = r.to_entity
      WHERE r.project_id = ? ORDER BY r.id`,
    id,
  );
  const notes = rows.filter((r) => isMomentKind(r.kind) || isUnsupportedKind(r.kind, r.evidence));
  console.log(JSON.stringify({ bank, ties: rows.length, notes: notes.length, cap: CAP }));

  const chunkOf = (refs: string): number | null => {
    try {
      const arr = JSON.parse(refs || '[]') as { chunk?: unknown }[];
      for (const ref of arr) {
        const n = Number(ref?.chunk);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch { /* unplaceable */ }
    return null;
  };
  const llm = baselineClient();
  let recovered = 0;
  let confirmed = 0;
  let unproven = 0;
  for (const n of notes.slice(0, CAP)) {
    const cid = chunkOf(n.refs);
    const chunk = cid ? db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', cid) : null;
    if (!chunk?.text) { unproven++; continue; }
    const passage = chunk.text.slice(0, 1500);
    let answer: { label?: unknown; quote?: unknown } = {};
    try {
      const res = await llm.chat({
        system:
          'You relabel one claimed tie using only the passage. Reply with JSON only: {"label": "one of the allowed labels, or unresolvable", "quote": "an exact phrase from the passage"}. Start with {. No other words.',
        messages: [{
          role: 'user',
          content: `PAIR: ${n.f} / ${n.t}\nOLD LABEL: ${n.kind}\nALLOWED: ${CLOSED.join(', ')}\n\nPASSAGE:\n${passage}`,
        }],
        temperature: 0.1,
        maxTokens: 300,
      });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      answer = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as typeof answer;
    } catch { unproven++; continue; }
    const label = String(answer.label ?? '').trim().toLowerCase();
    const quote = norm(String(answer.quote ?? ''));
    if (!label || label === 'unresolvable' || !CLOSED.includes(label)) { confirmed++; continue; }
    if (quote.length > 10 && norm(passage).includes(quote)) recovered++;
    else unproven++;
  }
  console.log(JSON.stringify({
    done: true, tried: Math.min(CAP, notes.length),
    recovered, confirmedDrop: confirmed, unproven,
    minutes: +((Date.now() - t0) / 60000).toFixed(1),
  }));
} finally {
  db.close();
}
