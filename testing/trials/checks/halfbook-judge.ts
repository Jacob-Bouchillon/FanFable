/**
 * Half-book fixed-prompt judge (predictions only — no labels exist for these
 * rows, so verdicts are predictions, never truth).
 *
 * usage: node --no-warnings testing/trials/checks/halfbook-judge.ts [/tmp/opencode/halfbook-judge.json]
 *
 * Reads testing/trials/halfbook-run/plagueis-half.db through a RAW READ-ONLY
 * sqlite handle (the Db wrapper runs migrations/housekeeping writes, so it
 * is not used here). Model calls only: qwen3.5:9b, temp 0, seed 42.
 * Fixed wording copied verbatim from judge-variants.ts (variant `fixed`);
 * judge-variants.ts itself is untouched.
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { extractJson } from '../../../fanfable/src/json.ts';

const outPath = process.argv[2] ?? '/tmp/opencode/halfbook-judge.json';
const DB = 'testing/trials/halfbook-run/plagueis-half.db';

// Verbatim copy of the `fixed` system prompt in judge-variants.ts.
const SYSTEM =
  'You read a short passage from a book. Two people are named for you. ' +
  'Decide whether this passage states or presupposes a lasting relationship between them. ' +
  'Two names that refer to the same person are NOT a relationship — if the two names are one person, answer false. ' +
  'A family title used in the passage (aunt, uncle, nephew, parent, and so on) establishes what it names. ' +
  'The relationship may well be true in the book: judge only this passage. ' +
  'If the passage merely places them together, has them speak, or describes an action, answer false. ' +
  'Reply with JSON only: {"lasting": true|false, "why": "one sentence"}. ' +
  'Do not use knowledge from outside the passage.';

const raw = new DatabaseSync(DB, { readOnly: true });
try {
  const proj = raw.prepare('SELECT id FROM project LIMIT 1').get() as { id: number } | undefined;
  if (!proj) throw new Error('no project');
  const pid = proj.id;

  const rows = raw.prepare(
    `SELECT r.id, r.kind, r.evidence, r.source_refs, r.review_status,
            a.name AS a, b.name AS b
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? ORDER BY r.id`,
  ).all(pid) as { id: number; kind: string; evidence: string; source_refs: string; review_status: string; a: string; b: string }[];

  const chunkById = new Map<number, string>();
  for (const c of raw.prepare('SELECT id, text FROM canon_chunk WHERE project_id = ?').all(pid) as { id: number; text: string }[]) {
    chunkById.set(c.id, c.text);
  }

  const llm = clientFrom({ provider: 'ollama', model: 'qwen3.5:9b', temperature: 0, seed: 42, maxTokens: 2048 });

  const twelve = (s: string): string => s.split(/\s+/).filter(Boolean).slice(0, 12).join(' ');
  const out: { id: number; status: string; verdict: 'establishes' | 'none'; why: string }[] = [];
  let n = 0;
  for (const row of rows) {
    let passage = (row.evidence ?? '').trim();
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const cid = typeof refs[0]?.chunk === 'number' ? (refs[0]!.chunk as number) : null;
      const text = cid === null ? undefined : chunkById.get(cid);
      if (text) {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const at = sentences.findIndex((s) => s.includes((row.evidence ?? '').trim().slice(0, 80)));
        if (at >= 0) {
          passage = sentences.slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2)).join(' ').replace(/\s+/g, ' ').trim();
        }
      }
    } catch {
      /* keep the quote */
    }
    let lasting = false;
    let why = '';
    try {
      const res = await llm.chat({
        system: SYSTEM,
        messages: [{ role: 'user', content: `Passage: ${passage}\nPeople: ${row.a} and ${row.b}` }],
        temperature: 0,
        maxTokens: 2048,
      });
      const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
      lasting = parsed.lasting === true || String(parsed.lasting).toLowerCase() === 'true';
      why = twelve(String(parsed.why ?? ''));
    } catch {
      why = 'model-error';
    }
    out.push({ id: row.id, status: row.review_status, verdict: lasting ? 'establishes' : 'none', why });
    if (++n % 25 === 0) process.stderr.write(`judged ${n}/${rows.length}\n`);
  }

  // Known alias/title pairs: pending quarantine dossiers. Counts only.
  const pairs: { name: string; candidate: string; establishes: number; none: number; rows: number }[] = [];
  const entId = (name: string): number | null => {
    const r = raw.prepare('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?').get(pid, name) as { id: number } | undefined;
    return r ? r.id : null;
  };
  const verdictById = new Map(out.map((r) => [r.id, r.verdict]));
  for (const q of raw.prepare("SELECT name, candidate FROM quarantine_alias WHERE project_id = ? AND status = 'pending' ORDER BY name, candidate").all(pid) as { name: string; candidate: string }[]) {
    const aid = entId(q.name);
    const bid = entId(q.candidate);
    if (aid === null || bid === null) continue;
    const rels = raw.prepare(
      'SELECT id FROM canon_relation WHERE project_id = ? AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))',
    ).all(pid, aid, bid, bid, aid) as { id: number }[];
    let establishes = 0, none = 0;
    for (const r of rels) {
      if (verdictById.get(r.id) === 'establishes') establishes++;
      else none++;
    }
    if (rels.length) pairs.push({ name: q.name, candidate: q.candidate, establishes, none, rows: rels.length });
  }

  const counts = {
    establishes: out.filter((r) => r.verdict === 'establishes').length,
    reinforces: 0,
    mentions: 0,
    none: out.filter((r) => r.verdict === 'none').length,
  };
  writeFileSync(outPath, JSON.stringify({ variant: 'fixed', model: 'qwen3.5:9b', temperature: 0, seed: 42, counts, note: 'fixed wording emits lasting true/false only; reinforces/mentions are not distinguished (reported 0, not inferred)', rows: out, aliasTitlePairs: pairs }, null, 1));
  console.log(JSON.stringify({ counts, rows: out.length, aliasTitlePairs: pairs.length, out: outPath }));
} finally {
  raw.close();
}
