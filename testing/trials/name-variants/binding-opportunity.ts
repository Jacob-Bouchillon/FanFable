/**
 * Size the pronoun-binding opportunity (trials only, read-only).
 *
 * usage: node binding-opportunity.ts <db> [out.json]
 *
 * Two different things are counted, because they are often conflated:
 *
 *  A. The rejected scan candidates that failed on assertion. These sentences
 *     already name two roster characters; they are the pool the guard refuses.
 *  B. Sentences the scan never sees: one named character plus a possessive kin
 *     phrase ("his sister"), where exactly one other named character sits in
 *     the same sentence or the one beside it. That is what a binder would
 *     recover, and it is invisible to the current candidate generator.
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/core/db.ts';
import {
  CLOSED_ROLE_KINDS,
  KIND_GLOSSES,
  assertsRelationship,
  canPromote,
  scanSentenceCandidates,
} from '../../../fanfable/src/lorebook.ts';
import { buildRosterIndex, canonicalName } from '../../../fanfable/src/identity/names.ts';

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? 'testing/trials/name-variants/binding-opportunity.json';
if (!dbPath) {
  console.error('usage: binding-opportunity.ts <db> [out.json]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>("SELECT id FROM project WHERE name = 'ab'")!;
const projectId = proj.id;

const entities = db.all<{ id: number; name: string; aliases: string; kind: string; review_status: string }>(
  'SELECT id, name, aliases, kind, review_status FROM canon_entity WHERE project_id = ?',
  projectId,
);
const chars = entities
  .filter((e) => e.kind === 'character' && e.review_status !== 'quarantined')
  .map((e) => ({ id: e.id, name: e.name, aliases: JSON.parse(e.aliases || '[]') as string[] }));
const chunks = db.all<{ id: number; text: string }>(
  'SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  projectId,
);
const chunkById = new Map(chunks.map((c) => [c.id, c.text]));
const text = chunks.map((c) => c.text).join(' ');
const aliasesOf = new Map(chars.map((c) => [c.name, c.aliases]));
const index = buildRosterIndex(entities.map((e) => ({ name: e.name, aliases: JSON.parse(e.aliases || '[]') as string[] })), text);

const clean = (s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/"/g, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tok = (s: string) => clean(s).split(' ').filter(Boolean);
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

// --- A. the rejected candidate pool -------------------------------------
const census = { checks: 0, rejected: 0, assertionMissing: 0, withCoordination: 0, withPossessiveKin: 0, withKin: 0 };
const possessiveKin = /\b(his|her|their|my|your)\s+(mother|father|sister|brother|son|daughter|aunt|uncle|cousin|wife|husband|nephew|niece|friend|enemy|teacher|mentor|partner)\b/i;
const kinAny = /\b(mother|father|sister|brother|son|daughter|aunt|uncle|cousin|wife|husband|nephew|niece|friend|enemy|teacher|mentor|partner)\b/i;

for (const c of scanSentenceCandidates(db, projectId)) {
  const sentenceTokens = tok(c.sentence);
  const present = phrases.filter((p) => contains(sentenceTokens, tok(p)));
  if (!present.length) continue;
  const kinds = [...new Set(present.map((p) => phraseOwner.get(p)!).filter(Boolean))];
  const chunk = chunkById.get(c.chunkId);
  if (!chunk) continue;
  for (const kind of kinds) {
    census.checks++;
    const ok = canPromote(
      {
        fromId: c.fromId, toId: c.toId,
        fromName: c.fromName, toName: c.toName,
        fromAliases: aliasesOf.get(c.fromName) ?? [], toAliases: aliasesOf.get(c.toName) ?? [],
        kind, evidence: c.sentence,
      },
      { db, projectId, chunkText: chunk, index },
    ).ok;
    if (ok) continue;
    census.rejected++;
    // assertion-missing only, recomputed directly so the census and this
    // script cannot drift apart.
    if (assertsRelationship(c.sentence, c.fromName, aliasesOf.get(c.fromName) ?? [], c.toName, aliasesOf.get(c.toName) ?? [], kind, '', index)) continue;
    census.assertionMissing++;
    const words = tok(c.sentence);
    const fromAt = words.indexOf(clean(c.fromName).split(' ')[0] ?? '');
    if (/\b(and|or)\b/.test(c.sentence)) census.withCoordination++;
    if (possessiveKin.test(c.sentence)) census.withPossessiveKin++;
    if (kinAny.test(c.sentence)) census.withKin++;
  }
}

// --- B. what the scan never sees ----------------------------------------
// Sentences with a possessive kin phrase, at least one named character, and
// exactly one other named character in the sentence or the one beside it.
const sentences: { chunkId: number; index: number; text: string }[] = [];
for (const chunk of chunks) {
  const parts = chunk.text.split(/(?<=[.!?])\s+/);
  parts.forEach((p, i) => sentences.push({ chunkId: chunk.id, index: i, text: p.trim() }));
}
const namedIn = (sentence: string) => chars.filter((c) => {
  const forms = [c.name, ...c.aliases].map((f) => clean(f)).filter(Boolean);
  return forms.some((f) => new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(clean(sentence)));
});

const proposals = new Map<string, { a: string; b: string; kind: string }>();
let possessiveSentences = 0;
let withOneNamed = 0;
let withSecondNearby = 0;
const ambiguous = { multipleNearby: 0, noneNearby: 0, kindUnmapped: 0 };

for (let i = 0; i < sentences.length; i++) {
  const s = sentences[i]!;
  const m = s.text.match(/\b(his|her|their|my|your)\s+([a-z]+)/i);
  if (!m) continue;
  possessiveSentences++;
  const kin = (m[2] ?? '').toLowerCase();
  const kind = phraseOwner.get(kin);
  const named = namedIn(s.text);
  if (!named.length) continue;
  withOneNamed++;
  if (!kind) { ambiguous.kindUnmapped++; continue; }
  // Who else is named nearby? Same sentence, or the sentence either side.
  const near = new Set<number>(named.map((c) => c.id));
  for (const j of [i - 1, i + 1]) {
    const other = sentences[j];
    if (!other || other.chunkId !== s.chunkId) continue;
    for (const c of namedIn(other.text)) near.add(c.id);
  }
  const ids = [...near];
  if (ids.length < 2) { ambiguous.noneNearby++; continue; }
  withSecondNearby++;
  // Every ordered pair of nearby people is a potential proposal; count them.
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const A = entities.find((e) => e.id === a);
    const B = entities.find((e) => e.id === b);
    if (!A || !B) continue;
    const key = `${A.name}|${B.name}|${kind}`;
    if (!proposals.has(key)) proposals.set(key, { a: A.name, b: B.name, kind });
  }
}

db.close();
const report = { census, binding: { possessiveSentences, withOneNamed, withSecondNearby, ...ambiguous, proposedPairs: proposals.size } };
writeFileSync(outPath, JSON.stringify({ ...report, proposals: [...proposals.values()] }, null, 1));
console.log(JSON.stringify({ ...report, out: outPath }, null, 1));
