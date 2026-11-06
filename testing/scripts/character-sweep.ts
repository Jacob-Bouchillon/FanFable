/**
 * Character sweep runner.
 *
 * Dry-run by default. --model asks the project's LlmClient for ties; --write
 * applies them. No model call happens without --model.
 */
import { Db, fromJson } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import {
  applySweep,
  batchSweepPassages,
  parseSweepAnswer,
  planSweep,
  sweepRelationKey,
  validateSweepTies,
  SWEEP_KINDS,
  type SweepPassage,
  type SweepTarget,
  type SweepTie,
} from '../../fanfable/src/web/character-sweep.ts';

const SYSTEM_PROMPT = `You record the relationships these PASSAGES explicitly establish between the TARGET and
another named person. A tie must be carried by a sentence: the sentence says they are
friends, enemies, family, rivals, teacher and student, allies, or that one trusts,
distrusts, fears, protects or hates the other.

Do NOT list a tie from co-mention alone. Two people standing in the same scene are not a tie.
Do NOT list a person the passages only name in passing.
Do NOT use outside knowledge. The quote must be the sentence that carries the tie.

The quote must contain BOTH names: the target's name and the other person's name.
Never quote a sentence that refers to either person only by pronoun, title or description.
If no sentence names both, skip the tie.

Return up to 20 ties. For each: other, kind, direction (out = target toward other, in =
reverse), quote, chunk_index, reason (at most 12 words).`;

const KINDS_LIST = [...SWEEP_KINDS].join(', ');

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function knownCharacters(db: Db, projectId: number): Map<string, number> {
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    `SELECT id, name, aliases FROM canon_entity
      WHERE project_id = ? AND kind = 'character' ORDER BY id`,
    projectId,
  );
  const known = new Map<string, number>();
  for (const row of rows) {
    const names = [row.name, ...fromJson<string[]>(row.aliases, []).map(String)];
    for (const name of names) {
      const key = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (key && !known.has(key)) known.set(key, Number(row.id));
    }
  }
  return known;
}

function existingRelations(db: Db, projectId: number): Set<string> {
  const rows = db.all<{ from_entity: number; to_entity: number; kind: string }>(
    'SELECT from_entity, to_entity, kind FROM canon_relation WHERE project_id = ?',
    projectId,
  );
  const existing = new Set<string>();
  for (const row of rows) {
    existing.add(sweepRelationKey(Number(row.from_entity), Number(row.to_entity), row.kind));
  }
  return existing;
}

function promptFor(target: SweepTarget, people: string[], passages: SweepPassage[]): string {
  const lines = [
    `TARGET: ${target.name}${target.aliases.length ? ` (aliases: ${target.aliases.join(', ')})` : ''}`,
    'KNOWN PEOPLE:',
    ...people.map((name) => `- ${name}`),
    `KINDS: ${KINDS_LIST}`,
    'PASSAGES:',
    passages.length
      ? passages.map((passage, index) =>
          `[${index}] ${passage.locator} | seq ${passage.seq}\n${passage.text}`).join('\n\n')
      : '(no passages found)',
    'Return up to 20 ties, one per person and kind. chunk_index is the 0-based passage number in this batch.',
    'Schema: {"ties":[{"other":"...","kind":"...","direction":"out"|"in","quote":"...","chunk_index":0,"reason":"..."}]} (maxItems: 20)',
  ];
  return lines.join('\n\n');
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
const castRaw = flag('cast');
const cast = castRaw === undefined ? undefined : castRaw.split(',').map((name) => name.trim()).filter(Boolean);
const minAppearances = Math.max(0, Math.floor(numberFlag('min-appearances', 3)));
const maxPassages = Math.max(1, Math.floor(numberFlag('max-passages', 30)));
const batchSize = Math.max(1, Math.floor(numberFlag('batch-size', 6)));
const model = flag('model');
const write = process.argv.includes('--write');
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/character-sweep.ts --db <path> --project <name> [--cast "Harry,Ron,Snape"] [--min-appearances 3] [--max-passages 30] [--batch-size 6] [--model <model>] [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
try {
  const project = controller.getProjectByName(db, projectName);
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    db.close();
    process.exit(1);
  }

  const targets = planSweep(db, project.id, { cast, minAppearances, maxPassages });
  const people = db.all<{ name: string }>(
    `SELECT name FROM canon_entity WHERE project_id = ? AND kind = 'character' ORDER BY name`,
    project.id,
  ).map((row) => row.name).slice(0, 200);
  const client = model
    ? controller.createClient({ ...project.settings, model } as never)
    : null;
  const results: Array<{
    entityId: number;
    name: string;
    aliases: string[];
    passageCount: number;
    passages: SweepTarget['passages'];
    calls: number;
    modelTexts?: string[];
    proposals: Array<{ tie: SweepTie; toId: number; bothInQuote: boolean }>;
    rejections: Array<{ tie: SweepTie; reason: string }>;
    counts?: { added: number; duplicates: number; rejected: number; byReason: Record<string, number> };
  }> = [];

  for (const target of targets) {
    let calls = 0;
    let modelTexts: string[] = [];
    let ties: SweepTie[] = [];
    let proposals: Array<{ tie: SweepTie; toId: number; bothInQuote: boolean }> = [];
    let rejections: Array<{ tie: SweepTie; reason: string }> = [];
    let counts: { added: number; duplicates: number; rejected: number; byReason: Record<string, number> } | undefined;

    if (client) {
      const known = knownCharacters(db, project.id);
      const existing = existingRelations(db, project.id);
      const batches = batchSweepPassages(target.passages, batchSize);
      calls = batches.length;
      let offset = 0;
      for (const batch of batches) {
        const response = await client.chat({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: promptFor(target, people, batch) }],
          temperature: 0,
          maxTokens: 2000,
          format: 'json',
        });
        modelTexts.push(response.text);
        const batchTies = parseSweepAnswer(response.text).map((tie) => ({
          ...tie,
          chunkIndex: offset + tie.chunkIndex,
        }));
        ties.push(...batchTies);
        const validation = validateSweepTies(batchTies, target, known, existing);
        proposals.push(...validation.proposals);
        rejections.push(...validation.rejections);
        offset += batch.length;
      }
      counts = applySweep(db, project.id, target, ties, { dryRun: !write });
    }

    results.push({
      entityId: target.entityId,
      name: target.name,
      aliases: target.aliases,
      passageCount: target.passages.length,
      passages: target.passages,
      calls,
      ...(modelTexts.length ? { modelTexts } : {}),
      proposals,
      rejections,
      ...(counts === undefined ? {} : { counts }),
    });
  }

  console.log(JSON.stringify({
    project: { id: project.id, name: project.name },
    model: model ?? null,
    write,
    cast: cast ?? null,
    minAppearances,
    maxPassages,
    batchSize,
    targetCount: targets.length,
    results,
  }, null, 2));
} finally {
  db.close();
}
