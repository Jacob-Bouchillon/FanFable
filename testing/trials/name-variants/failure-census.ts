/**
 * Failure census for one book (trials only, read-only).
 *
 * usage: node failure-census.ts <db> [out.json]
 *
 * Same candidate pool, phrase-to-kind mapping and full-guard call as
 * differential-guard.ts, so the two harnesses cannot disagree: this one
 * additionally tallies why each rejected check was rejected.
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import {
  CLOSED_ROLE_KINDS,
  KIND_GLOSSES,
  canPromote,
  scanSentenceCandidates,
} from '../../../fanfable/src/lorebook.ts';
import { buildRosterIndex } from '../../../fanfable/src/names.ts';

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? 'testing/trials/name-variants/failure-census.json';
if (!dbPath) {
  console.error('usage: failure-census.ts <db> [out.json]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>("SELECT id FROM project WHERE name = 'ab'")!;
const projectId = proj.id;

const rows = db
  .all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', projectId)
  .map((r) => ({ name: r.name, aliases: JSON.parse(r.aliases || '[]') as string[] }));
const text = db
  .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
  .map((r) => r.text)
  .join(' ');
const aliasesOf = new Map(rows.map((r) => [r.name, r.aliases]));
const index = buildRosterIndex(rows, text);

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/"/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tokens = (s: string) => clean(s).split(' ').filter(Boolean);
const contains = (hay: string[], needle: string[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, k) => hay[i + k] === w)) return true;
  return false;
};

const PARTICLES = new Set(['of', 'to', 'with', 'for', 'a', 'the', 'an', 'in', 'on', 'as']);
const kindHead = (kind: string): string =>
  kind.split(/[^a-z]+/).filter(Boolean).find((word) => !PARTICLES.has(word)) ?? '';
const phraseOwner = new Map<string, string>();
for (const kind of CLOSED_ROLE_KINDS) {
  const head = kindHead(kind);
  if (head && !phraseOwner.has(head)) phraseOwner.set(head, kind);
  for (const phrase of [kind, ...(KIND_GLOSSES[kind]?.reads ?? '').split(',')]) {
    const cleaned = clean(phrase);
    if (cleaned.length > 2 && !phraseOwner.has(cleaned)) phraseOwner.set(cleaned, kind);
  }
}
const phrases = [...phraseOwner.keys()];

const candidates = scanSentenceCandidates(db, projectId);
const chunkText = new Map<number, string>();
for (const chunk of db.all<{ id: number; text: string }>(
  'SELECT id, text FROM canon_chunk WHERE project_id = ?',
  projectId,
)) {
  chunkText.set(chunk.id, chunk.text);
}

const reasons = new Map<string, number>();
const passed = new Map<string, { pair: string; kind: string }>();
let checks = 0;
let passingChecks = 0;

for (const candidate of candidates) {
  const sentenceTokens = tokens(candidate.sentence);
  const present = phrases.filter((phrase) => contains(sentenceTokens, tokens(phrase)));
  if (!present.length) continue;
  const kinds = [...new Set(present.map((phrase) => phraseOwner.get(phrase)!).filter(Boolean))];
  const chunk = chunkText.get(candidate.chunkId);
  if (!chunk) continue;
  for (const kind of kinds) {
    checks++;
    const decision = canPromote(
      {
        fromId: candidate.fromId,
        toId: candidate.toId,
        fromName: candidate.fromName,
        toName: candidate.toName,
        fromAliases: aliasesOf.get(candidate.fromName) ?? [],
        toAliases: aliasesOf.get(candidate.toName) ?? [],
        kind,
        evidence: candidate.sentence,
      },
      { db, projectId, chunkText: chunk, index },
    );
    if (decision.ok) {
      passingChecks++;
      const key = `${candidate.fromName} -> ${candidate.toName}|${kind}`;
      if (!passed.has(key)) passed.set(key, { pair: `${candidate.fromName} -> ${candidate.toName}`, kind });
    } else {
      const reason = decision.reason ?? 'unknown';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
}

db.close();
const tally = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync(
  outPath,
  JSON.stringify({ checks, passingChecks, reasons: tally, passed: [...passed.values()] }, null, 1),
);
console.log(
  JSON.stringify(
    {
      pairKindChecks: checks,
      passingChecks,
      distinctPassed: passed.size,
      reasons: Object.fromEntries(tally),
      passed: [...passed.values()],
      out: outPath,
    },
    null,
    1,
  ),
);
