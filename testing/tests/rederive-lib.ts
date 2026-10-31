/** Deterministic evidence re-derivation for quarantined keepers. No model calls. */
import { Db, fromJson, nowIso, strList, toJson } from '../../fanfable/src/core/db.ts';
import { nameMentionedExact } from '../../fanfable/src/identity/names.ts';
import { splitSentences } from '../../fanfable/src/core/text.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

export interface Chunk {
  id: number;
  seq: number;
  locator: string;
  source_title: string;
  text: string;
}

export interface Row {
  id: number;
  kind: string;
  evidence: string;
  source_refs: string;
  from_id: number;
  to_id: number;
  from_name: string;
  from_aliases: string;
  to_name: string;
  to_aliases: string;
}

export interface Candidate {
  chunkId: number;
  locator: string;
  sentence: string;
  candidateKind: string;
  verbatim: boolean;
  bothNames: boolean;
  tieWord: boolean;
  direction: boolean;
  moment: boolean;
  valid: boolean;
}

export type Outcome = 'restore' | 'manual-review' | 'remain-provisional';

export interface PlanRow {
  id: number;
  pair: string;
  kind: string;
  candidatesExamined: number;
  candidates: Candidate[];
  outcome: Outcome;
  reason: string;
}

export interface AppliedRow {
  id: number;
  chunk: number;
  locator: string;
  previousEvidenceLength: number;
  newEvidenceLength: number;
}

const norm = (text: string): string => (text ?? '')
  .replace(/[â€œâ€Â«Â»]/g, '"')
  .replace(/[â€˜â€™]/g, "'")
  .replace(/[â€“â€”âˆ’]/g, '-')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const inverseHeads = (kind: string): string[] => {
  const words = norm(kind).split(' ').filter((word) => !['of', 'to', 'with', 'for'].includes(word));
  const head = words[0] ?? '';
  const out: string[] = [];
  for (const [left, right] of lorebook.INVERSE_PAIRS) {
    if (left === head) out.push(right);
    if (right === head) out.push(left);
  }
  return out;
};

/** Verify one sentence against the row's kind, both names, tie word and direction. */
export function checkCandidate(row: Row, chunk: Chunk, sentence: string): Candidate {
  const fromAliases = strList(row.from_aliases);
  const toAliases = strList(row.to_aliases);
  const bothNames = (nameMentionedExact(row.from_name, sentence) || fromAliases.some((a) => nameMentionedExact(a, sentence))) &&
    (nameMentionedExact(row.to_name, sentence) || toAliases.some((a) => nameMentionedExact(a, sentence)));
  const verbatim = !!norm(sentence) && norm(chunk.text).includes(norm(sentence));
  const moment = lorebook.isMomentKind(row.kind);
  let candidateKind = row.kind;
  let tieWord = !lorebook.isUnsupportedKind(row.kind, sentence);
  let direction = false;
  if (tieWord) {
    direction = lorebook.relationSentenceDirection(row.kind, sentence, row.from_name, fromAliases, row.to_name, toAliases) === 'forward';
  } else {
    for (const head of inverseHeads(row.kind)) {
      const inverseKind = `${head} of`;
      if (lorebook.isUnsupportedKind(inverseKind, sentence)) continue;
      if (
        lorebook.relationSentenceDirection(inverseKind, sentence, row.from_name, fromAliases, row.to_name, toAliases) === 'reverse'
      ) {
        candidateKind = inverseKind;
        tieWord = true;
        direction = true;
        break;
      }
    }
  }
  return {
    chunkId: chunk.id,
    locator: chunk.locator,
    sentence,
    candidateKind,
    verbatim,
    bothNames,
    tieWord,
    direction,
    moment,
    valid: verbatim && bothNames && tieWord && direction && !moment,
  };
}

export function planRow(row: Row, chunks: Chunk[]): PlanRow {
  const candidates: Candidate[] = [];
  let candidatesExamined = 0;
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const fromAliases = strList(row.from_aliases);
      const toAliases = strList(row.to_aliases);
      const both = (nameMentionedExact(row.from_name, sentence) || fromAliases.some((a) => nameMentionedExact(a, sentence))) &&
        (nameMentionedExact(row.to_name, sentence) || toAliases.some((a) => nameMentionedExact(a, sentence)));
      if (!both) continue;
      candidatesExamined++;
      const candidate = checkCandidate(row, chunk, sentence);
      if (candidate.tieWord && !candidate.moment) candidates.push(candidate);
    }
  }
  const valid = candidates.filter((candidate) => candidate.valid);
  const outcome: Outcome = valid.length === 1 ? 'restore' : valid.length > 1 ? 'manual-review' : 'remain-provisional';
  return {
    id: row.id,
    pair: `${row.from_name} â€” ${row.to_name}`,
    kind: row.kind,
    candidatesExamined,
    candidates,
    outcome,
    reason: valid.length === 1
      ? 'exactly one verified candidate sentence'
      : valid.length > 1
        ? `${valid.length} equally valid candidate sentences`
        : candidates.length
          ? 'candidate sentences found, none passes every check'
          : 'no sentence names both endpoints with the tie word',
  };
}

export function loadRows(db: Db, projectId: number, ids: number[]): Row[] {
  return db.all<Row>(
    `SELECT r.id, r.kind, r.evidence, r.source_refs,
            r.from_entity AS from_id, r.to_entity AS to_id,
            a.name AS from_name, a.aliases AS from_aliases,
            b.name AS to_name, b.aliases AS to_aliases
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'provisional' AND r.confirmed_by_user = 1
        AND r.id IN (${ids.map(() => '?').join(',')})
      ORDER BY r.id`,
    projectId,
    ...ids,
  );
}

export function loadChunks(db: Db, projectId: number): Chunk[] {
  return db.all<Chunk>(
    `SELECT c.id, c.seq, c.locator, s.title AS source_title, c.text
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
      WHERE c.project_id = ? ORDER BY c.seq, c.id`,
    projectId,
  );
}

export function applyPlan(db: Db, projectId: number, plan: PlanRow[], rows: Row[], chunks: Chunk[]): AppliedRow[] {
  const applied: AppliedRow[] = [];
  for (const entry of plan) {
    if (entry.outcome !== 'restore') continue;
    const row = rows.find((item) => item.id === entry.id);
    const candidate = entry.candidates.find((item) => item.valid);
    if (!row || !candidate) continue;
    const chunk = chunks.find((item) => item.id === candidate.chunkId);
    if (!chunk) continue;
    const supporting = fromJson<Record<string, unknown>[]>(
      db.get<{ supporting_evidence: string }>('SELECT supporting_evidence FROM canon_relation WHERE id = ?', row.id)?.supporting_evidence ?? '[]',
      [],
    );
    supporting.push({
      quote: row.evidence,
      source_refs: fromJson<unknown[]>(row.source_refs, []),
      reason: 'superseded',
      moved_at: nowIso(),
    });
    db.run(
      `UPDATE canon_relation
          SET evidence = ?, source_refs = ?, supporting_evidence = ?,
              review_status = 'user_confirmed'
        WHERE project_id = ? AND id = ? AND review_status = 'provisional' AND confirmed_by_user = 1`,
      candidate.sentence,
      JSON.stringify([{ source: chunk.source_title, locator: chunk.locator, chunk: chunk.id }]),
      toJson(supporting),
      projectId,
      row.id,
    );
    applied.push({
      id: row.id,
      chunk: chunk.id,
      locator: chunk.locator,
      previousEvidenceLength: row.evidence.length,
      newEvidenceLength: candidate.sentence.length,
    });
  }
  return applied;
}
