/**
 * Kinship direction and grounding check.
 *
 *   node --no-warnings testing/scripts/check-kinship.ts --db <path> --project hp1 [--write]
 *
 * For a kinship relation the quote decides the direction. "A's sister B" means
 * the edge is B -> A. If the stored edge is A -> B it is reversed; if the quote
 * names only one endpoint the tie is unsupported.
 */
import { Db } from '../../fanfable/src/core/db.ts';
import {
  insertRelation,
  rejectRelation,
} from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: check-kinship.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const KINDS = new Set([
  'sister of', 'brother of', 'mother of', 'father of', 'son of', 'daughter of',
  'uncle of', 'aunt of', 'nephew of', 'niece of', 'wife of', 'husband of', 'cousin of',
]);
const KIN_WORD: Record<string, string> = {
  'sister of': 'sister', 'brother of': 'brother', 'mother of': 'mother', 'father of': 'father',
  'son of': 'son', 'daughter of': 'daughter', 'uncle of': 'uncle', 'aunt of': 'aunt',
  'nephew of': 'nephew', 'niece of': 'niece', 'wife of': 'wife', 'husband of': 'husband',
  'cousin of': 'cousin',
};

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const entities = db.all<{ id: number; name: string; aliases: string }>(
  'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
  project.id,
);
const forms = new Map<number, string[]>();
for (const entity of entities) {
  let aliases: string[] = [];
  try { aliases = JSON.parse(entity.aliases || '[]'); } catch { /* none */ }
  forms.set(Number(entity.id), [entity.name, ...aliases].filter((value) => value.length > 2));
}

const relations = db.all<{
  id: number; from_entity: number; to_entity: number; kind: string;
  evidence: string; anchor_evidence: string; source_refs: string; review_status: string;
}>(
  `SELECT id, from_entity, to_entity, kind, evidence, anchor_evidence, source_refs, review_status
     FROM canon_relation WHERE project_id = ? AND review_status <> 'rejected' ORDER BY id`,
  project.id,
);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyName = (values: string[]) => values.map(escape).join('|');
const mentioned = (text: string, values: string[]) =>
  new RegExp(`(?<![A-Za-z0-9])(?:${anyName(values)})(?![A-Za-z0-9])`, 'i').test(text);

let ok = 0;
let reversed = 0;
let wrongEndpoint = 0;
const reversedRows: number[] = [];
const wrongRows: number[] = [];
const skipped: number[] = [];

const POSSESSIVE = /([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,2})['’]s\s+(sister|brother|mother|father|son|daughter|uncle|aunt|nephew|niece|wife|husband|cousin)\s+([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,2})/;

/** The bank entity a captured name refers to, by containment of any form. */
function resolve(captured: string): number | null {
  const needle = captured.toLowerCase();
  const hits = entities.filter((entity) => (forms.get(Number(entity.id)) ?? [])
    .some((form) => needle.includes(form.toLowerCase()) || form.toLowerCase().includes(needle)));
  return hits.length === 1 ? Number(hits[0]!.id) : null;
}

for (const relation of relations) {
  const kind = String(relation.kind).toLowerCase().trim();
  if (!KINDS.has(kind)) continue;
  const word = KIN_WORD[kind]!;
  const match = POSSESSIVE.exec(String(relation.evidence ?? ''));
  if (!match || match[2]!.toLowerCase() !== word) {
    skipped.push(Number(relation.id));
    continue;
  }
  const possessor = resolve(match[1]!);
  const kin = resolve(match[3]!);
  if (possessor === null || kin === null) {
    skipped.push(Number(relation.id));
    continue;
  }
  const from = Number(relation.from_entity);
  const to = Number(relation.to_entity);
  if (from === kin && to === possessor) {
    ok++;
  } else if (from === possessor && to === kin) {
    reversed++;
    reversedRows.push(Number(relation.id));
    if (write) {
      insertRelation(db, project.id, {
        fromEntity: kin,
        toEntity: possessor,
        kind: relation.kind,
        evidence: relation.evidence,
        sourceRefs: relation.source_refs,
        reviewStatus: 'needs_review',
      });
      rejectRelation(db, project.id, Number(relation.id), 'direction reversed by the quote possessive', relation.evidence);
    }
  } else {
    wrongEndpoint++;
    wrongRows.push(Number(relation.id));
    if (write) {
      rejectRelation(db, project.id, Number(relation.id), 'endpoints do not match the quote possessive', relation.evidence);
    }
  }
}

console.log(`kinship relations with a possessive quote: ${ok + reversed + wrongEndpoint} · ok: ${ok} · reversed: ${reversed} · wrong endpoints: ${wrongEndpoint} · pattern not matched: ${skipped.length}${write ? '' : ' (dry run)'}`);
if (reversedRows.length) console.log('  reversed ids:', reversedRows.join(', '));
if (wrongRows.length) console.log('  wrong-endpoint ids:', wrongRows.join(', '));
db.close();
