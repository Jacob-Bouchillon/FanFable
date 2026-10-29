/**
 * Differential through the full guard (trials only, read-only against a copy).
 *
 * usage: node differential-guard.ts <db> [out.json]
 *
 * Holds the candidate pool fixed at the index-enabled scan. Each matched tie
 * phrase is mapped to the closed kind that owns it (a kind head or one of its
 * glossary readings) instead of being passed as a kind itself, then the full
 * canPromote() runs on the real row and its citing chunk — once with the
 * roster index and once without. Nothing is written to the database and no
 * model is called.
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
const outPath = process.argv[3] ?? 'testing/trials/name-variants/differential-guard-after.json';
if (!dbPath) {
  console.error('usage: differential-guard.ts <db> [out.json]');
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

// Every phrase the sweep can match, and the closed kind that owns it.
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

interface AcceptedRow {
  pair: string;
  kind: string;
  indexOnly: boolean;
}
const accepted = new Map<string, { row: AcceptedRow; anyWithoutIndex: boolean }>();
let checks = 0;
let acceptsWithoutIndex = 0;
let acceptsWithIndex = 0;
let newlyAdmitted = 0;

for (const candidate of candidates) {
  const sentenceTokens = tokens(candidate.sentence);
  const present = phrases.filter((phrase) => contains(sentenceTokens, tokens(phrase)));
  if (!present.length) continue;
  const kinds = [...new Set(present.map((phrase) => phraseOwner.get(phrase)!).filter(Boolean))];
  const chunk = chunkText.get(candidate.chunkId);
  if (!chunk) continue;
  const row = {
    fromId: candidate.fromId,
    toId: candidate.toId,
    fromName: candidate.fromName,
    toName: candidate.toName,
    fromAliases: aliasesOf.get(candidate.fromName) ?? [],
    toAliases: aliasesOf.get(candidate.toName) ?? [],
    evidence: candidate.sentence,
  };
  for (const kind of kinds) {
    checks++;
    const withoutIndex = canPromote({ ...row, kind }, { db, projectId, chunkText: chunk }).ok;
    const withIndex = canPromote({ ...row, kind }, { db, projectId, chunkText: chunk, index }).ok;
    if (withoutIndex) acceptsWithoutIndex++;
    if (!withIndex) continue;
    acceptsWithIndex++;
    if (!withoutIndex) newlyAdmitted++;
    const key = `${candidate.fromName} -> ${candidate.toName}|${kind}`;
    const prev = accepted.get(key);
    if (prev) {
      prev.anyWithoutIndex ||= withoutIndex;
      prev.row.indexOnly = !prev.anyWithoutIndex;
    } else {
      accepted.set(key, {
        row: {
          pair: `${candidate.fromName} -> ${candidate.toName}`,
          kind,
          indexOnly: !withoutIndex,
        },
        anyWithoutIndex: withoutIndex,
      });
    }
  }
}

const acceptedList: AcceptedRow[] = [...accepted.values()]
  .map((entry) => entry.row)
  .sort((a, b) => (a.pair === b.pair ? a.kind.localeCompare(b.kind) : a.pair.localeCompare(b.pair)));

db.close();
writeFileSync(
  outPath,
  JSON.stringify(
    {
      db: dbPath,
      candidates: candidates.length,
      checks,
      acceptsWithoutIndex,
      acceptsWithIndex,
      newlyAdmitted,
      accepted: acceptedList,
    },
    null,
    1,
  ),
);
console.log(
  JSON.stringify(
    {
      candidates: candidates.length,
      checks,
      acceptsWithoutIndex,
      acceptsWithIndex,
      newlyAdmitted,
      accepted: acceptedList,
      out: outPath,
    },
    null,
    1,
  ),
);
