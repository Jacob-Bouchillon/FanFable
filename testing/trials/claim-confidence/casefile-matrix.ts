/**
 * Case-file judge — trial tool.
 *
 * For each candidate relation, build a case file (claimed tie, quoted line,
 * up to N notes already gathered on the pair), ask a frozen prompt whether the
 * tie is true and whether the evidence supports this exact kind, majority of
 * three, and write one CSV row per candidate.
 *
 * Read-only against the database. No pipeline writes. Not part of npm test.
 *
 * usage:
 *   node --no-warnings testing/trials/claim-confidence/casefile-judge.ts \
 *     --db <copy.db> --project <name> --out <verdicts.csv> [--model ...] [--limit n] [--notes 8]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MODEL = 'qwen3.5:9b';
const HOST = 'http://127.0.0.1:11434';
const SEEDS = [42, 43, 44];

const SYSTEM = `You answer two questions about a pair of characters in a book, using a CASE FILE.
The case file contains: the claimed tie, one quoted line, and notes already gathered about these two people.
1. verdict: is the claimed tie TRUE for these two in the book? Stated, implied and presupposed evidence all count; mere co-presence does not.
2. kind_match: does the case file support THIS EXACT kind, not merely some other tie? A peer is not a colleague; an acquaintance is not a friend; dislike is not enemy; a mother is not an aunt.
Use the whole case file. No outside knowledge. Reply JSON only: {"verdict":"true"|"false","kind_match":"yes"|"no","reason":"at most 12 words"}.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface Vote {
  verdict: boolean;
  kindMatch: boolean;
  reason: string;
}

async function ask(model: string, user: string, seed: number): Promise<Vote> {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { temperature: 0, seed },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const text = String(data.message?.content ?? '').trim().replace(/```json|```/g, '');
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      verdict?: unknown;
      kind_match?: unknown;
      reason?: unknown;
    };
    return {
      verdict: parsed.verdict === 'true',
      kindMatch: parsed.kind_match === 'yes',
      reason: String(parsed.reason ?? '').trim(),
    };
  } catch {
    return { verdict: false, kindMatch: false, reason: 'unparsed' };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = flag(args, 'db');
  const projectName = flag(args, 'project');
  const out = flag(args, 'out');
  if (!dbPath || !projectName || !out) {
    process.stderr.write(
      'usage: casefile-judge.ts --db <copy.db> --project <name> --out <verdicts.csv> [--model m] [--limit n] [--notes 8]\n',
    );
    process.exit(2);
  }
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const model = flag(args, 'model') ?? MODEL;
  const limit = Number(flag(args, 'limit') ?? 0) || undefined;
  const noteLimit = Number(flag(args, 'notes') ?? 8);
  const usePassage = (flag(args, 'passage') ?? '1') !== '0';
  const personLimit = Number(flag(args, 'person') ?? 3);
  const idsFile = flag(args, 'ids');
  const sample = Number(flag(args, 'sample') ?? 0) || 0;
  const seed = Number(flag(args, 'seed') ?? 42) || 42;
  const onlyIds = idsFile ? new Set(readFileSync(idsFile, 'utf8').split(/[^0-9]+/).map(Number).filter(Boolean)) : null;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const project = db.prepare('SELECT id FROM project WHERE name = ?').get(projectName) as { id: number } | undefined;
  if (!project) throw new Error(`project not found: ${projectName}`);

  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.evidence, r.source_refs, r.review_status,
              r.from_entity, r.to_entity, a.name AS a, b.name AS b
         FROM canon_relation r
         JOIN canon_entity a ON a.id = r.from_entity
         JOIN canon_entity b ON b.id = r.to_entity
        WHERE r.project_id = ?
        ORDER BY r.id`,
    )
    .all(project.id) as {
    id: number;
    kind: string;
    evidence: string;
    source_refs: string;
    review_status: string;
    from_entity: number;
    to_entity: number;
    a: string;
    b: string;
  }[];

  const filtered = onlyIds ? rows.filter((row) => onlyIds.has(row.id)) : rows;
  let ordered = filtered;
  if (sample > 0) {
    // deterministic seeded shuffle (mulberry32), sample distinct rows
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    ordered = [...filtered];
    for (let i = ordered.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]; }
    ordered = ordered.slice(0, Math.min(sample, ordered.length));
  }
  const selected = limit ? ordered.slice(0, limit) : ordered;
  const lines = ['relId,pair,kind,truth,kind_match,reason,notes,status,votes'];
  let accepted = 0;
  let trueCount = 0;

  for (const [index, row] of selected.entries()) {
    const lo = Math.min(row.from_entity, row.to_entity);
    const hi = Math.max(row.from_entity, row.to_entity);
    const thread = db
      .prepare(
        "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? ORDER BY id LIMIT 1",
      )
      .get(project.id, lo, hi) as { id: number } | undefined;
    const notes = thread
      ? (db
          .prepare(
            'SELECT quote, claim, strength FROM canon_thread_note WHERE thread_id = ? ORDER BY strength DESC, id LIMIT ?',
          )
          .all(thread.id, Math.max(0, noteLimit)) as { quote: string; claim: string; strength: number }[])
      : [];
    const personNotes = (id: number): { quote: string; strength: number }[] => {
      const t = db
        .prepare("SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? ORDER BY id LIMIT 1")
        .get(project.id, id) as { id: number } | undefined;
      if (!t) return [];
      return db
        .prepare('SELECT quote, strength FROM canon_thread_note WHERE thread_id = ? ORDER BY strength DESC, id LIMIT ?')
        .all(t.id, Math.max(0, personLimit)) as { quote: string; strength: number }[];
    };
    const aNotes = personNotes(row.from_entity);
    const bNotes = personNotes(row.to_entity);
    const caseFile = notes.length
      ? notes
          .map((n, i) => `${i + 1}. [${Number(n.strength).toFixed(2)}] "${String(n.quote).slice(0, 200)}"`)
          .join('\n')
      : '(no other notes)';
    const personContext = [
      ...aNotes.map((n) => `A: [${Number(n.strength).toFixed(2)}] "${String(n.quote).slice(0, 180)}"`),
      ...bNotes.map((n) => `B: [${Number(n.strength).toFixed(2)}] "${String(n.quote).slice(0, 180)}"`),
    ].join('\n') || '(no person notes)';
    let passage = '';
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const chunkId = Number(refs.find((r) => r && r.chunk)?.chunk);
      if (Number.isFinite(chunkId)) {
        const chunk = db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(chunkId) as { text?: string } | undefined;
        passage = usePassage ? String(chunk?.text ?? '').slice(0, 1500) : '';
      }
    } catch {
      passage = '';
    }
    const user = `PAIR: ${row.a} / ${row.b}\nCLAIMED TIE: ${row.kind}\n\nQUOTE:\n${row.evidence}\n\nPASSAGE:\n${passage || '(no passage)'}\n\nPAIR NOTES:\n${caseFile}\n\nPERSON NOTES:\n${personContext}`;

    const votes: Vote[] = [];
    for (const seed of SEEDS) votes.push(await ask(model, user, seed));
    const truth = votes.filter((v) => v.verdict).length >= 2;
    const kindMatch = votes.filter((v) => v.kindMatch).length >= 2;
    const reason = votes.find((v) => v.reason)?.reason ?? '';
    if (truth) trueCount++;
    if (truth && kindMatch) accepted++;
    lines.push(
      [
        row.id,
        csvCell(`${row.a} / ${row.b}`),
        csvCell(row.kind),
        truth ? 'true' : 'false',
        kindMatch ? 'yes' : 'no',
        csvCell(reason),
        notes.length,
        csvCell(row.review_status),
        votes.map((v) => (v.verdict ? 'T' : 'F') + (v.kindMatch ? 'Y' : 'N')).join('/'),
      ].join(','),
    );
    if ((index + 1) % 10 === 0) process.stderr.write(`judged ${index + 1}/${selected.length}\n`);
  }

  writeFileSync(out, lines.join('\n') + '\n');
  const hash = createHash('sha256').update(SYSTEM).digest('hex');
  process.stderr.write(
    `rows=${selected.length} truth=${trueCount} accepted=${accepted} model=${model} prompt=${hash.slice(0, 12)}\n`,
  );
  db.close();
}

main().catch((error) => {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exit(1);
});
