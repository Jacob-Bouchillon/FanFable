/**
 * Assessor-bench frozen set — user-confirmed positives + audit negatives.
 *
 * Trial-only, read-only bank. POSITIVES: every user_confirmed row (the user's
 * word = truth). NEGATIVES: rows the two completed blind audits judged
 * unsupported (co-presence-only / wrong-kind / wrong-direction — cannot-tell
 * is undecided, never negative), deduped by row id. Packets carry pair, kind,
 * quote, and passage only: no status, no assessment, no confidence. Labels
 * live beside the packets, never inside them. Nothing banks — measurement,
 * verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/assessor-bench/build.ts
 *
 * Writes only under testing/trials/assessor-bench/ (gitignored). Reports
 * print counts only, never passage prose, quotes, or names.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/assessor-bench';
// Live bank, read-only: audit row ids above the trial copy's range live here.
const DB_PATH = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const PROJECT = 'halfbook';
const AUDITS = [
  'testing/trials/fp-audit/out/verdicts.json',
  'testing/trials/fp-audit2/out/verdicts.json',
];
const NEGATIVE = new Set(['co-presence-only', 'wrong-kind', 'wrong-direction']);

function fail(message: string): never {
  throw new Error(`assessor-bench: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(resolve(DB_PATH));
  return { main: `${st.size}:${st.mtimeMs}` };
}

export function build(): void {
  const before = dbStat();
  const db = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const chunkTextOf = (sourceRefs: string): string => {
      try {
        const refs = JSON.parse(sourceRefs || '[]') as { chunk?: unknown }[];
        const found = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0);
        if (!found) return '';
        return (
          db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(Number(found.chunk)) as
            | { text: string }
            | undefined
        )?.text ?? '';
      } catch {
        return '';
      }
    };
    const toPacket = (id: number): { id: number; pair: [string, string]; kind: string; quote: string; passage: string } | null => {
      const row = db.prepare(
        `SELECT r.kind, r.evidence, r.source_refs AS sourceRefs, a.name AS fromName, b.name AS toName
           FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity
          WHERE r.project_id = ? AND r.id = ?`,
      ).get(project.id, id) as
        | { kind: string; evidence: string; sourceRefs: string; fromName: string; toName: string }
        | undefined;
      if (!row) return null;
      return { id, pair: [row.fromName, row.toName], kind: row.kind, quote: row.evidence, passage: chunkTextOf(row.sourceRefs) };
    };
    const positives = (
      db.prepare(`SELECT id FROM canon_relation WHERE project_id = ? AND review_status = 'user_confirmed' ORDER BY id`).all(
        project.id,
      ) as { id: number }[]
    ).map((r) => r.id);
    const negIds = new Set<number>();
    for (const path of AUDITS) {
      const { results } = JSON.parse(readFileSync(path, 'utf8')) as {
        results: { id: number; verdict: string }[];
      };
      for (const r of results) {
        if (NEGATIVE.has(r.verdict)) negIds.add(r.id);
      }
    }
    const packets: { id: number; pair: [string, string]; kind: string; quote: string; passage: string }[] = [];
    const labels: Record<number, 'pos' | 'neg'> = {};
    for (const id of positives) {
      const p = toPacket(id);
      if (!p) fail(`positive row ${id} missing`);
      packets.push(p);
      labels[id] = 'pos';
    }
    let negMissing = 0;
    for (const id of [...negIds].sort((a, b) => a - b)) {
      const p = toPacket(id);
      if (!p) {
        negMissing++;
        continue;
      }
      packets.push(p);
      labels[id] = 'neg';
    }
    mkdirSync(TRACK, { recursive: true });
    writeFileSync(`${TRACK}/packets.json`, JSON.stringify({ n: packets.length, packets }, null, 1));
    writeFileSync(`${TRACK}/labels.json`, JSON.stringify({ pos: positives.length, neg: Object.keys(labels).length - positives.length, labels }, null, 1));
    const total = packets.length;
    console.log(`frozen: pos ${positives.length} neg ${Object.keys(labels).length - positives.length} total ${total} negMissing ${negMissing}`);
    if (total < 60) console.log(`frozen: POS+NEG ${total} < 60 — proceeding with what exists, stated`);
    console.log(`bank untouched (main ${before.main})`);
  } finally {
    db.close();
  }
  const after = statSync(resolve(DB_PATH));
  if (`${after.size}:${after.mtimeMs}` !== before.main) fail('bank moved during build');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('build.ts')) {
  try {
    build();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
