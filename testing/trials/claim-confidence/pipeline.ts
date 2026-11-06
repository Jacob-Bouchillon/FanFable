/**
 * Integrated case-file pipeline — trial prototype.
 *
 * One run: for every candidate relation, assemble the case file from what the
 * system already holds (quote, cited passage, pair-thread notes), judge it with
 * several local models, merge truth and kind by separate majorities, and (with
 * --write) apply the verdict to the bank: accepted when both pass, needs_review
 * otherwise, with a court ruling recording why.
 *
 * This is the connected path the experiments were measuring in pieces.
 *
 * usage:
 *   node --no-warnings testing/trials/claim-confidence/pipeline.ts \
 *     --db <copy.db> --project <name> [--models qwen3.5:9b,spark-x2-q8:latest,nuextract3-q8:latest] \
 *     [--notes 8] [--limit n] [--write]
 */
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const HOST = 'http://127.0.0.1:11434';
const SEEDS = [42, 43, 44];
const DEFAULT_MODELS = ['qwen3.5:9b', 'spark-x2-q8:latest', 'nuextract3-q8:latest'];

const SYSTEM = `You answer two questions about a pair of characters in a book, using a CASE FILE.
The case file contains: the claimed tie, one quoted line, the passage it cites, and notes already gathered about these two people.
1. verdict: is the claimed tie TRUE for these two in the book? Stated, implied and presupposed evidence all count; mere co-presence does not.
2. kind_match: does the case file support THIS EXACT kind, not merely some other tie?
A peer is not a colleague; an acquaintance is not a friend; dislike is not enemy.
A mother or father is not an aunt or uncle.
Teacher, student and mentor require instruction or guidance shown in the case file; fame, protection or presence is not instruction.
Trusted requires demonstrated reliance on the other's conduct; protection or kindness is not trust.
Relative requires family by blood or marriage, not household membership or friendship.
Use the whole case file. No outside knowledge. Reply JSON only: {"verdict":"true"|"false","kind_match":"yes"|"no","reason":"at most 12 words"}.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function ask(model: string, user: string, seed: number): Promise<{ truth: boolean; kind: boolean }> {
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
    };
    return { truth: parsed.verdict === 'true', kind: parsed.kind_match === 'yes' };
  } catch {
    return { truth: false, kind: false };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = flag(args, 'db');
  const projectName = flag(args, 'project');
  if (!dbPath || !projectName) {
    process.stderr.write('usage: pipeline.ts --db <copy.db> --project <name> [--models a,b,c] [--notes 8] [--limit n] [--write] [--filters]\n');
    process.exit(2);
  }
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const models = (flag(args, 'models') ?? DEFAULT_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const noteLimit = Number(flag(args, 'notes') ?? 8);
  const limit = Number(flag(args, 'limit') ?? 0) || undefined;
  const write = args.includes('--write');
  const filters = args.includes('--filters');
  const idsFile = flag(args, 'ids');
  const onlyIds = idsFile ? new Set(readFileSync(idsFile, 'utf8').split(/[^0-9]+/).map(Number).filter(Boolean)) : null;

  const db = new DatabaseSync(dbPath);
  const project = db.prepare('SELECT id FROM project WHERE name = ?').get(projectName) as { id: number } | undefined;
  if (!project) throw new Error(`project not found: ${projectName}`);

  const rows = (
    db
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
    }[]
  ).filter((row) => (onlyIds ? onlyIds.has(row.id) : true)).slice(0, limit);

  // Assemble every case file before judging. A case file depends only on the
  // row, its pair notes and the cited chunk, so it can be built once and
  // reused across models without changing any prompt byte.
  const cases = rows.map((row) => {
    const lo = Math.min(row.from_entity, row.to_entity);
    const hi = Math.max(row.from_entity, row.to_entity);
    const thread = db
      .prepare("SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? ORDER BY id LIMIT 1")
      .get(project.id, lo, hi) as { id: number } | undefined;
    const notes = thread
      ? (db
          .prepare('SELECT quote, strength FROM canon_thread_note WHERE thread_id = ? ORDER BY strength DESC, id LIMIT ?')
          .all(thread.id, Math.max(0, noteLimit)) as { quote: string; strength: number }[])
      : [];
    const noteText = notes.length
      ? notes.map((n, i) => `${i + 1}. [${Number(n.strength).toFixed(2)}] "${String(n.quote).slice(0, 200)}"`).join('\n')
      : '(no pair notes)';

    let passage = '';
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const chunkId = Number(refs.find((r) => r && r.chunk)?.chunk);
      if (Number.isFinite(chunkId)) {
        const chunk = db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(chunkId) as { text?: string } | undefined;
        passage = String(chunk?.text ?? '').slice(0, 1500);
      }
    } catch {
      passage = '';
    }

    const user = `PAIR: ${row.a} / ${row.b}\nCLAIMED TIE: ${row.kind}\n\nQUOTE:\n${row.evidence}\n\nPASSAGE:\n${passage || '(no passage)'}\n\nPAIR NOTES:\n${noteText}`;
    return { row, user };
  });

  // Model-outer, not row-outer. On a 16 GB card only one of the three models is
  // resident at a time, so row-outer ordering paid two ~6 s unload/reload cycles
  // per row. Grouping by model loads each model once for the whole run. The
  // votes are identical: the same calls, the same per-model seed majorities, the
  // same cross-model majority, only accumulated in a different order.
  const votes = new Map<number, { truth: boolean[]; kind: boolean[] }>(
    rows.map((row) => [row.id, { truth: [], kind: [] }]),
  );
  let judged = 0;
  for (const model of models) {
    for (const { row, user } of cases) {
      const modelVotes = await Promise.all(SEEDS.map((seed) => ask(model, user, seed)));
      const tally = votes.get(row.id)!;
      tally.truth.push(modelVotes.filter((v) => v.truth).length >= 2);
      tally.kind.push(modelVotes.filter((v) => v.kind).length >= 2);
      judged++;
      if (judged % 10 === 0) process.stderr.write(`judged ${judged}/${rows.length * models.length}\n`);
    }
    process.stderr.write(`model done: ${model}\n`);
  }

  const verdicts = rows.map((row) => {
    const tally = votes.get(row.id)!;
    const truth = tally.truth.filter(Boolean).length * 2 > models.length;
    const kindMatch = tally.kind.filter(Boolean).length * 2 > models.length;
    return { row, truth, kindMatch, pass: truth && kindMatch };
  });

  // Mechanical filters run after the judge and can only demote. They measure
  // the claim's representation, not its truth: the same tie accepted twice must
  // not count twice. Directional kinds (student/teacher, parent/child) are
  // deliberately absent from the symmetric set, because reversing one states a
  // different tie rather than a duplicate.
  const SYMMETRIC_KINDS = new Set([
    'acquaintance', 'friend of', 'enemy of', 'ally of', 'rival of', 'colleague of',
    'brother of', 'sister of', 'sibling of', 'cousin of', 'relative of', 'spouse of',
    'partner', 'peer', 'disliked', 'distrusted', 'trusted', 'feared', 'admired',
    'jealous of', 'friend', 'enemy',
  ]);
  const mechanical = new Map<number, string>();
  if (filters) {
    const orderedSeen = new Map<string, number>();
    const unorderedSeen = new Map<string, number>();
    for (const verdict of verdicts) {
      if (!verdict.pass) continue;
      const { row } = verdict;
      const lo = Math.min(row.from_entity, row.to_entity);
      const hi = Math.max(row.from_entity, row.to_entity);
      const kind = row.kind.toLowerCase().trim();
      const ordered = `${row.from_entity}-${row.to_entity}|${kind}`;
      const unordered = SYMMETRIC_KINDS.has(kind) ? `${lo}-${hi}|${kind}` : null;
      const duplicateOf = unordered ? unorderedSeen.get(unordered) : orderedSeen.get(ordered);
      if (duplicateOf !== undefined) {
        verdict.pass = false;
        mechanical.set(row.id, unordered ? 'symmetric-duplicate' : 'duplicate-claim');
        continue;
      }
      orderedSeen.set(ordered, row.id);
      if (unordered) unorderedSeen.set(unordered, row.id);
    }
  }

  let accepted = 0;
  let rejected = 0;
  for (const { row, truth, kindMatch, pass } of verdicts) {
    const filterReason = mechanical.get(row.id);

    if (write) {
      const target = pass ? 'accepted' : 'needs_review';
      // A filtered row may already sit at needs_review, in which case the
      // status does not move. Record the ruling anyway: the mechanical reason
      // is an audit fact, not a side effect of a transition.
      if (target !== row.review_status || filterReason) {
        db.prepare('UPDATE canon_relation SET review_status = ? WHERE id = ? AND project_id = ?').run(target, row.id, project.id);
        db.prepare(
          `INSERT INTO canon_ruling (project_id, subject, relation_id, role, actor, standard, from_status, to_status, basis, quote_hash, created_at)
           VALUES (?, ?, ?, 'appeal', 'guard', 'case-file-judge', ?, ?, ?, '', ?)`,
        ).run(
          project.id,
          `relation:${row.id}`,
          row.id,
          row.review_status,
          target,
          pass
            ? 'case file: truth and kind majorities'
            : filterReason
              ? `mechanical: ${filterReason}`
              : `case file: truth=${truth} kind=${kindMatch}`,
          new Date().toISOString(),
        );
      }
    }
    if (pass) accepted++;
    else rejected++;
  }

  process.stderr.write(`rows=${rows.length} accepted=${accepted} parked=${rejected} filtered=${mechanical.size} models=${models.join(',')} write=${write}\n`);
  db.close();
}

main().catch((error) => {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exit(1);
});
