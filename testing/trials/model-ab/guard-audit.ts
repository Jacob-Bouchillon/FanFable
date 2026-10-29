/**
 * Guard audit (trials only).
 *
 * For every relation row, evaluate each promotion predicate independently —
 * including predicates that the guard's short-circuit never reaches — and
 * report:
 *
 *   1. the first failure the real guard reports (canPromoteRelation),
 *   2. a per-row multi-label failure vector,
 *   3. which predicates co-occur,
 *   4. rows that fail exactly one predicate (mechanical headroom per rule).
 *
 * The `canPromote()` code is not modified; this only reads.
 *
 * usage: node guard-audit.ts <db> [project]
 */
import { Db } from '../../../fanfable/src/db.ts';
import {
  RELATIONSHIP_GRADE_KINDS,
  canPromoteRelation,
  isClosedRoleKind,
  isMomentKind,
  isUnsupportedKind,
  relationSentenceDirection,
} from '../../../fanfable/src/lorebook.ts';
import { nameMentionedExact } from '../../../fanfable/src/names.ts';

const dbPath = process.argv[2];
const projectName = process.argv[3] ?? 'ab';
if (!dbPath) {
  console.error('usage: guard-audit.ts <db> [project]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!proj) {
  console.error('no project', projectName);
  process.exit(2);
}

interface Row {
  id: number;
  kind: string;
  evidence: string;
  review_status: string;
  source_refs: string;
  from_id: number;
  to_id: number;
  from_name: string;
  from_aliases: string;
  to_name: string;
  to_aliases: string;
}

const rows = db.all<Row>(
  `SELECT r.id, r.kind, r.evidence, r.review_status, r.source_refs,
          r.from_entity AS from_id, r.to_entity AS to_id,
          a.name AS from_name, a.aliases AS from_aliases,
          b.name AS to_name, b.aliases AS to_aliases
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ?`,
  proj.id,
);

const chunkText = new Map<number, string>();
for (const c of db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', proj.id)) {
  chunkText.set(c.id, c.text);
}

// Mirrors lorebook's `normalise`: punctuation (except apostrophes) becomes a
// space, so a quote that differs only in punctuation still counts as verbatim.
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const aliases = (raw: string): string[] => {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};

type Flag =
  | 'kind-moment'
  | 'kind-open-vocab'
  | 'kind-not-relationship-grade'
  | 'quote-not-verbatim'
  | 'endpoint-unnamed'
  | 'tie-word-absent'
  | 'direction-reverse';

const flagCount = new Map<Flag, number>();
const onlyCount = new Map<Flag, number>();
const pairCount = new Map<string, number>();
const mismatches: { id: number; guard: string; stored: string }[] = [];

const storedReason = new Map<string, string>();
for (const n of db.all<{ from_entity: number; to_entity: number; attempted_kind: string; reason: string }>(
  `SELECT from_entity, to_entity, attempted_kind, reason FROM canon_tie_note WHERE project_id = ?`,
  proj.id,
)) {
  storedReason.set(`${n.from_entity}|${n.to_entity}|${norm(n.attempted_kind)}`, n.reason);
}

let exactlyOne = 0;
const group = { kindOk_evidenceOk: 0, kindOk_evidenceBad: 0, kindBad_evidenceOk: 0, kindBad_evidenceBad: 0 };
let directionOnly = 0;
for (const r of rows) {
  const kind = norm(r.kind);
  const ev = r.evidence ?? '';
  const refs = (() => {
    try {
      const parsed = JSON.parse(r.source_refs || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() as { chunk?: unknown }[];
  const text = typeof refs[0]?.chunk === 'number' ? chunkText.get(refs[0].chunk as number) ?? '' : '';

  const flags: Flag[] = [];
  if (isMomentKind(kind)) flags.push('kind-moment');
  if (!isClosedRoleKind(kind)) flags.push('kind-open-vocab');
  if (!RELATIONSHIP_GRADE_KINDS.has(kind)) flags.push('kind-not-relationship-grade');
  if (!text || !norm(text).includes(norm(ev))) flags.push('quote-not-verbatim');
  if (!nameMentionedExact(r.from_name, ev) && !aliases(r.from_aliases).some((a) => nameMentionedExact(a, ev))) {
    flags.push('endpoint-unnamed');
  }
  if (!nameMentionedExact(r.to_name, ev) && !aliases(r.to_aliases).some((a) => nameMentionedExact(a, ev))) {
    flags.push('endpoint-unnamed');
  }
  if (isUnsupportedKind(kind, ev)) flags.push('tie-word-absent');
  const dir = relationSentenceDirection(kind, ev, r.from_name, aliases(r.from_aliases), r.to_name, aliases(r.to_aliases));
  if (dir === 'reverse') flags.push('direction-reverse');

  const unique = [...new Set(flags)];
  for (const f of unique) flagCount.set(f, (flagCount.get(f) ?? 0) + 1);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const k = `${unique[i]} + ${unique[j]}`;
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    }
  }
  if (unique.length === 1) {
    exactlyOne++;
    onlyCount.set(unique[0]!, (onlyCount.get(unique[0]!) ?? 0) + 1);
  }

  // 2x2 diagnostic: is the label schema-valid, and is the evidence adequate?
  // Evidence adequacy here is the three quote predicates; direction is counted
  // separately because it only matters once both other groups pass.
  const kindOk = !isMomentKind(kind) && isClosedRoleKind(kind) && RELATIONSHIP_GRADE_KINDS.has(kind);
  const evidenceBad = unique.some(
    (f) => f === 'quote-not-verbatim' || f === 'endpoint-unnamed' || f === 'tie-word-absent',
  );
  if (kindOk && !evidenceBad) group.kindOk_evidenceOk++;
  else if (kindOk && evidenceBad) group.kindOk_evidenceBad++;
  else if (!kindOk && !evidenceBad) group.kindBad_evidenceOk++;
  else group.kindBad_evidenceBad++;
  if (unique.length === 1 && unique[0] === 'direction-reverse') directionOnly++;

  const guard = canPromoteRelation(db, proj.id, r.id);
  if (!guard.ok) {
    const stored = storedReason.get(`${r.from_id}|${r.to_id}|${kind}`) ?? '';
    if (stored && stored !== guard.reason) mismatches.push({ id: r.id, guard: guard.reason, stored });
  }
}

const byStatus = new Map<string, number>();
for (const r of rows) byStatus.set(r.review_status, (byStatus.get(r.review_status) ?? 0) + 1);

console.log(
  JSON.stringify(
    {
      db: dbPath,
      relations: rows.length,
      byStatus: Object.fromEntries([...byStatus.entries()].sort()),
      flags: Object.fromEntries([...flagCount.entries()].sort((a, b) => b[1] - a[1])),
      failExactlyOne: exactlyOne,
      only: Object.fromEntries([...onlyCount.entries()].sort((a, b) => b[1] - a[1])),
      grouping: group,
      directionOnly,
      overlapTop: [...pairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      storedReasonMismatches: mismatches.length,
      mismatchSample: mismatches.slice(0, 5),
    },
    null,
    0,
  ),
);
db.close();
