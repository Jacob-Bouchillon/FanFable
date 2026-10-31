/**
 * Differential: does the derived-variant index widen the deterministic proof
 * path, and by how much? (trials only, read-only against a copy of the db)
 *
 * usage: node differential.ts <db> [out.json]
 *
 * Holds the candidate pool fixed at the index-enabled scan, then runs the same
 * assertion check twice per (sentence, pair, kind): once with the roster index
 * and once without. The delta is what the index alone admits. Nothing is
 * written to the database and no model is called.
 */
import { Db } from '../../../fanfable/src/db.ts';
import {
  CLOSED_ROLE_KINDS,
  KIND_GLOSSES,
  assertsRelationship,
  namesBothDistinctly,
  scanSentenceCandidates,
} from '../../../fanfable/src/lorebook.ts';
import { buildRosterIndex } from '../../../fanfable/src/identity/names.ts';
import { writeFileSync } from 'node:fs';

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? 'testing/trials/name-variants/differential.json';
if (!dbPath) {
  console.error('usage: differential.ts <db> [out.json]');
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

const phrases = (() => {
  const set = new Set<string>();
  for (const kind of CLOSED_ROLE_KINDS) {
    const gloss = KIND_GLOSSES[kind];
    for (const phrase of [kind, ...(gloss?.reads ?? '').split(',')]) {
      const p = clean(phrase);
      if (p.length > 2) set.add(p);
    }
  }
  return [...set];
})();

const tokens = (s: string) => clean(s).split(' ').filter(Boolean);
const contains = (hay: string[], needle: string[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, k) => hay[i + k] === w)) return true;
  return false;
};

const candidates = scanSentenceCandidates(db, projectId);

interface Delta {
  sentence: string;
  chunkId: number;
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  kind: string;
  namingOnly: boolean;
}
const deltas: Delta[] = [];

let tested = 0;
let passNoIndex = 0;
let passIndex = 0;
let bothNamedOnlyWithIndex = 0;

for (const c of candidates) {
  const st = tokens(c.sentence);
  const present = phrases.filter((p) => contains(st, tokens(p)));
  if (!present.length) continue;
  const fromAliases = aliasesOf.get(c.fromName) ?? [];
  const toAliases = aliasesOf.get(c.toName) ?? [];
  const namedNo = namesBothDistinctly(c.sentence, c.fromName, fromAliases, c.toName, toAliases);
  const namedIdx = namesBothDistinctly(c.sentence, c.fromName, fromAliases, c.toName, toAliases, index);
  if (!namedNo && namedIdx) bothNamedOnlyWithIndex++;

  let okNo = false;
  let okIdx = false;
  let kindHit = '';
  for (const kind of present) {
    tested++;
    const a = assertsRelationship(c.sentence, c.fromName, fromAliases, c.toName, toAliases, kind);
    const b = assertsRelationship(c.sentence, c.fromName, fromAliases, c.toName, toAliases, kind, '', index);
    if (a) okNo = true;
    if (b) okIdx = true;
    if (b && !a && !kindHit) kindHit = kind;
  }
  if (okNo) passNoIndex++;
  if (okIdx) passIndex++;
  if (okIdx && !okNo) {
    deltas.push({
      sentence: c.sentence,
      chunkId: c.chunkId,
      fromId: c.fromId,
      toId: c.toId,
      fromName: c.fromName,
      toName: c.toName,
      kind: kindHit || present[0]!,
      namingOnly: !namedNo && namedIdx,
    });
  }
}

db.close();
writeFileSync(
  outPath,
  JSON.stringify({ db: dbPath, candidates: candidates.length, tested, passNoIndex, passIndex, deltas }, null, 1),
);
console.log(
  JSON.stringify(
    {
      candidates: candidates.length,
      pairKindChecks: tested,
      acceptsWithoutIndex: passNoIndex,
      acceptsWithIndex: passIndex,
      newlyAdmitted: deltas.length,
      pairsNamingOnlyWithIndex: bothNamedOnlyWithIndex,
      out: outPath,
    },
    null,
    1,
  ),
);
