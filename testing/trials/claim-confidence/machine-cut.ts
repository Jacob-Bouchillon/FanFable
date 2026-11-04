/**
 * Machine-cut candidates (trials only, not in npm test).
 *
 * Every sentence that names both members of any character roster pair becomes
 * a candidate, with chunk id and byte offsets into the chunk. Deterministic,
 * read-only, zero model calls, zero fabricated quotes.
 *
 * usage: node testing/trials/claim-confidence/machine-cut.ts --db <copy.db>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { splitSentences } from '../../../fanfable/src/core/text.ts';
import { nameMentionedExact } from '../../../fanfable/src/identity/names.ts';

const OUT = '/tmp/opencode/machine-cut';

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

interface Candidate {
  id: number;
  pair: string;
  sentence: string;
  locator: string;
  chunkId: number;
  start: number;
  end: number;
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = flag(args, 'db');
  if (!dbPath) {
    process.stderr.write('usage: machine-cut.ts --db <copy.db> [--project <name>]\n');
    process.exit(2);
  }
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let chunks: { id: number; text: string; locator: string }[] = [];
  let entities: { id: number; name: string; aliases: string[] }[] = [];
  try {
    const projects = db.prepare('SELECT id, name FROM project ORDER BY id').all() as { id: number; name: string }[];
    const wanted = flag(args, 'project');
    const project = wanted
      ? projects.find((entry) => entry.name === wanted)
      : projects.length === 1
        ? projects[0]
        : undefined;
    if (!project) throw new Error('project not found or ambiguous; pass --project <name>');
    chunks = db
      .prepare('SELECT id, text, locator FROM canon_chunk WHERE project_id = ? ORDER BY source_id, seq, id')
      .all(project.id) as { id: number; text: string; locator: string }[];
    entities = (
      db
        .prepare(
          "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined' ORDER BY id",
        )
        .all(project.id) as { id: number; name: string; aliases: string }[]
    ).map((row) => {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(row.aliases || '[]');
        if (Array.isArray(parsed)) aliases = parsed.map(String).map((alias) => alias.trim()).filter(Boolean);
      } catch {
        aliases = [];
      }
      return { id: row.id, name: row.name, aliases };
    });
  } finally {
    db.close();
  }

  const forms = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    variants: [entity.name, ...entity.aliases],
  }));

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let sentences = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.text, 'utf8');
    let cursor = 0;
    for (const raw of splitSentences(chunk.text)) {
      const sentence = raw.trim();
      if (!sentence) continue;
      sentences++;
      const charAt = chunk.text.indexOf(sentence, cursor);
      if (charAt < 0) continue;
      cursor = charAt + sentence.length;
      const named = forms.filter((form) =>
        form.variants.some((variant) => nameMentionedExact(variant, sentence)),
      );
      if (named.length < 2) continue;
      const charStart = charAt;
      const charEnd = charAt + sentence.length;
      const start = Buffer.byteLength(chunk.text.slice(0, charStart), 'utf8');
      const end = start + Buffer.byteLength(sentence, 'utf8');
      if (bytes.subarray(start, end).toString('utf8') !== sentence) continue;
      for (let i = 0; i < named.length; i++) {
        for (let j = i + 1; j < named.length; j++) {
          const a = named[i]!;
          const b = named[j]!;
          const pair = `${a.name} / ${b.name}`;
          const key = `${pair}\u0000${sentence}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            id: 0,
            pair,
            sentence,
            locator: chunk.locator,
            chunkId: chunk.id,
            start,
            end,
          });
        }
      }
    }
  }
  candidates.forEach((candidate, index) => {
    candidate.id = index + 1;
  });

  let verified = 0;
  for (const candidate of candidates) {
    const chunk = chunks.find((entry) => entry.id === candidate.chunkId);
    if (!chunk) continue;
    const resolved = Buffer.from(chunk.text, 'utf8').subarray(candidate.start, candidate.end).toString('utf8');
    if (resolved === candidate.sentence) verified++;
  }

  mkdirSync(OUT, { recursive: true });
  const header = 'id,pair,sentence,locator,chunkId,start,end';
  writeFileSync(
    join(OUT, 'candidates.csv'),
    `${header}\n${candidates
      .map((candidate) => [
        candidate.id,
        csvCell(candidate.pair),
        csvCell(candidate.sentence),
        csvCell(candidate.locator),
        candidate.chunkId,
        candidate.start,
        candidate.end,
      ].join(','))
      .join('\n')}\n`,
  );

  const pairsCovered = new Set(candidates.map((candidate) => candidate.pair)).size;
  console.log(JSON.stringify({
    chunks: chunks.length,
    sentences,
    pairsCovered,
    candidates: candidates.length,
    verifiedQuotes: verified,
    out: join(OUT, 'candidates.csv'),
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
