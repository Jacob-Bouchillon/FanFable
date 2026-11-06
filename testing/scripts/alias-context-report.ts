/**
 * Read-only context-alias candidate report.
 *
 * Without --model it stops after candidate pairs and passages. With --model it
 * asks the project's LlmClient and validates every yes. Nothing is written.
 */
import { DatabaseSync } from 'node:sqlite';
import { fromJson } from '../../fanfable/src/core/db.ts';
import { extractJson } from '../../fanfable/src/core/json.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { proposeAliasGroups, type AliasEntityInput } from '../../fanfable/src/identity/alias-groups.ts';
import {
  proposeAliasCandidates,
  validateAliasVerdict,
  type AliasCandidate,
  type AliasVerdict,
  type AliasVerdictInput,
} from '../../fanfable/src/identity/alias-context.ts';

const SYSTEM_PROMPT = `You decide whether two names refer to the same person in a book.
Read the passages. A surname alone is not enough. Different given names are different people.
Answer JSON only: {"same":"yes"|"no"|"unsure","quote":"verbatim passage or empty","reason":"at most 12 words"}
Do not use outside knowledge.`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function likePattern(value: string): string {
  return `%${String(value ?? '').replace(/[!%_]/g, '!$&')}%`;
}

function entityOutput(entity: { id: number; name: string; aliases: string[] }): {
  id: number;
  name: string;
  aliases: string[];
} {
  return { id: entity.id, name: entity.name, aliases: entity.aliases };
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
const model = flag('model');
const limitRaw = flag('limit');
const limit = limitRaw === undefined ? Infinity : Math.max(1, Math.floor(Number(limitRaw)));
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/alias-context-report.ts --db <path> --project <name> [--model <model>] [--limit <n>]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const project = db.prepare('SELECT id, name, settings FROM project WHERE name = ?').get(projectName) as
    | { id: number; name: string; settings: string }
    | undefined;
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    db.close();
    process.exit(1);
  }

  const rows = db.prepare(
    "SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ? AND kind = 'character' ORDER BY id",
  ).all(project.id) as Array<{ id: number; name: string; aliases: string; kind: string }>;
  const entities: AliasEntityInput[] = rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    aliases: fromJson<string[]>(row.aliases, []).map(String).filter(Boolean),
    kind: String(row.kind ?? ''),
  }));
  const groups = proposeAliasGroups(entities);
  const groupOf = new Map<number, number>();
  for (const group of groups) {
    for (const id of group.memberIds) groupOf.set(id, group.canonicalId);
  }
  const candidates = proposeAliasCandidates(entities, groupOf).slice(0, limit);

  const bothNames = db.prepare(
    `SELECT id, seq, locator, text FROM canon_chunk
      WHERE project_id = ? AND text LIKE ? ESCAPE '!' AND text LIKE ? ESCAPE '!'
      ORDER BY seq LIMIT 3`,
  );
  const eitherName = db.prepare(
    `SELECT id, seq, locator, text FROM canon_chunk
      WHERE project_id = ? AND (text LIKE ? ESCAPE '!' OR text LIKE ? ESCAPE '!')
      ORDER BY seq LIMIT 3`,
  );

  const passagesFor = (candidate: AliasCandidate): Array<{ id: number; seq: number; locator: string; text: string }> => {
    const both = bothNames.all(
      project.id,
      likePattern(candidate.a.name),
      likePattern(candidate.b.name),
    ) as Array<{ id: number; seq: number; locator: string; text: string }>;
    const source = both.length
      ? both
      : eitherName.all(
          project.id,
          likePattern(candidate.a.name),
          likePattern(candidate.b.name),
        ) as Array<{ id: number; seq: number; locator: string; text: string }>;
    return source.map((row) => ({
      id: Number(row.id),
      seq: Number(row.seq),
      locator: String(row.locator ?? ''),
      text: String(row.text ?? '').slice(0, 2000),
    }));
  };

  const prepared = candidates.map((candidate) => ({
    a: entityOutput(candidate.a),
    b: entityOutput(candidate.b),
    shared: candidate.shared,
    passages: passagesFor(candidate),
  }));

  if (!model) {
    console.log(JSON.stringify({
      project: { id: project.id, name: project.name },
      groupedEntities: groupOf.size,
      candidateCount: prepared.length,
      candidates: prepared,
    }, null, 2));
  } else {
    const settings = fromJson<Record<string, unknown>>(project.settings, {});
    const client = controller.createClient({ ...settings, model } as never);
    const results: Array<{
      a: { id: number; name: string; aliases: string[] };
      b: { id: number; name: string; aliases: string[] };
      shared: string;
      passages: Array<{ id: number; seq: number; locator: string; text: string }>;
      modelText: string;
      modelAnswer: AliasVerdictInput | null;
      verdict: AliasVerdict;
    }> = [];

    for (const candidate of candidates) {
      const passages = passagesFor(candidate);
      const prompt = [
        `A: ${candidate.a.name}${candidate.a.aliases.length ? ` (aliases: ${candidate.a.aliases.join(', ')})` : ''}`,
        `B: ${candidate.b.name}${candidate.b.aliases.length ? ` (aliases: ${candidate.b.aliases.join(', ')})` : ''}`,
        'Passages:',
        passages.length
          ? passages.map((passage, index) => `[${index + 1}] ${passage.text}`).join('\n')
          : '(no passages found)',
      ].join('\n');

      let modelText = '';
      let modelAnswer: AliasVerdictInput | null = null;
      let verdict: AliasVerdict;
      try {
        const response = await client.chat({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          maxTokens: 200,
        });
        modelText = response.text;
        modelAnswer = extractJson<AliasVerdictInput>(response.text);
        verdict = validateAliasVerdict(modelAnswer ?? { same: undefined }, {
          chunkTexts: passages.map((passage) => passage.text),
          aName: candidate.a.name,
          bName: candidate.b.name,
          aAliases: candidate.a.aliases,
          bAliases: candidate.b.aliases,
        });
      } catch (error) {
        verdict = {
          same: false,
          quote: '',
          reason: error instanceof Error ? error.message : String(error),
          rejection: 'bad-shape',
        };
      }
      results.push({
        a: entityOutput(candidate.a),
        b: entityOutput(candidate.b),
        shared: candidate.shared,
        passages,
        modelText,
        modelAnswer,
        verdict,
      });
    }

    const accepted = results
      .filter((result) => result.verdict.same)
      .map((result) => ({
        a: result.a.name,
        b: result.b.name,
        shared: result.shared,
        quote: result.verdict.quote,
        reason: result.verdict.reason,
      }));
    const rejected = results
      .filter((result) => !result.verdict.same)
      .map((result) => ({
        a: result.a.name,
        b: result.b.name,
        shared: result.shared,
        rejection: result.verdict.rejection ?? null,
        quote: result.verdict.quote,
        reason: result.verdict.reason,
        modelAnswer: result.modelAnswer,
      }));

    console.log(JSON.stringify({
      project: { id: project.id, name: project.name },
      model,
      groupedEntities: groupOf.size,
      candidateCount: results.length,
      accepted,
      rejected,
      results,
    }, null, 2));
  }
} finally {
  db.close();
}
