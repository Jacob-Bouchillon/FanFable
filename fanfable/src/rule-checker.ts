/**
 * Deterministic consistency-rule checker (courtroom v0, flags only).
 *
 * ~20 SQL + string rules, zero VRAM, batch over new/changed rows. Writes no
 * facts: flags rows contested with machine-readable reasons. Code paths are
 * bit-deterministic; LLM text excluded from comparison.
 *
 * Quarantine predicate (frozen): quarantine iff normalized names match after
 * casefold/possessive/plural strip AND the two rows' source windows share no
 * scene AND no co-speaker veto fired AND corroboration < 2 for the merged
 * form. Otherwise keep separate.
 */
import type { Db } from './db.ts';
import { isClosedRoleKind, isMomentKind, isUnsupportedKind } from './lorebook.ts';

export interface RuleHit {
  id: number;
  rule: string;
  reason: string;
}

const KIND_GENDER: { re: RegExp; kinds: string[] }[] = [
  { re: /\b(husband|father|brother|son|uncle|nephew|grandfather|grandson|widower|king|prince|lord|sir)\b/i, kinds: ['character'] },
  { re: /\b(wife|mother|sister|daughter|aunt|niece|grandmother|granddaughter|widow|queen|princess|lady|dame|madam|mistress)\b/i, kinds: ['character'] },
];

function normKind(k: string): string {
  return k.trim().toLowerCase();
}

function spouseGroup(k: string): boolean {
  const t = ` ${normKind(k)} `;
  return t.includes(' husband ') || t.includes(' wife ') || t.includes(' spouse ') || t.includes(' married ');
}

/** Run all rules over ids (or all relations) and flag contested. Never writes facts. */
export function checkRelations(db: Db, projectId: number, opts: { ids?: number[] } = {}): RuleHit[] {
  const ids = opts.ids && opts.ids.length
    ? db.all<{ id: number }>(
        `SELECT id FROM canon_relation WHERE project_id = ? AND id IN (${opts.ids.map(() => '?').join(',')}) ORDER BY id`,
        projectId, ...opts.ids,
      ).map((r) => r.id)
    : db.all<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ? ORDER BY id', projectId).map((r) => r.id);
  if (!ids.length) return [];
  const rows = db.all<{
    id: number; from_entity: number; to_entity: number; kind: string; description: string;
    evidence: string; source_refs: string; review_status: string; conflict_status: string;
    ledger_state: string; scope: string;
  }>(
    `SELECT id, from_entity, to_entity, kind, description, evidence, source_refs, review_status, conflict_status, ledger_state, scope
     FROM canon_relation WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    projectId, ...ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r] as [number, typeof r]));
  const entityKind = new Map<number, string>(
    db.all<{ id: number; kind: string }>('SELECT id, kind FROM canon_entity WHERE project_id = ?', projectId)
      .map((e) => [e.id, e.kind] as [number, string]),
  );
  const pairKinds = new Map<string, { id: number; kind: string }[]>();
  for (const r of rows) {
    const key = [Math.min(r.from_entity, r.to_entity), Math.max(r.from_entity, r.to_entity)].join(':');
    pairKinds.set(key, [...(pairKinds.get(key) ?? []), { id: r.id, kind: r.kind }]);
  }
  const hits: RuleHit[] = [];
  const flag = (id: number, rule: string, reason: string): void => {
    if (hits.some((h) => h.id === id && h.rule === rule)) return;
    hits.push({ id, rule, reason });
  };
  for (const r of rows) {
    const kind = normKind(r.kind);
    // 1 empty evidence
    if (!r.evidence.trim()) flag(r.id, 'empty-evidence', 'no quotation behind the claim');
    // 2 self tie
    if (r.from_entity === r.to_entity) flag(r.id, 'self-tie', 'same entity on both ends');
    // 3 empty/generic kind
    if (!kind || kind === 'related to') flag(r.id, 'generic-kind', 'fallback kind, not a specific tie');
    // Open vocabulary: the kind is no closed role noun, so an accepted bank
    // on it overclaims. Flagged contested for human review; the bank gate
    // parks new ones before they can surface.
    if (kind && kind !== 'related to' && !isClosedRoleKind(r.kind)) {
      flag(r.id, 'open-vocab-kind', `unlisted kind "${r.kind}" — not a closed role noun`);
    }
    // 4 moment word banked as tie
    if (isMomentKind(r.kind)) flag(r.id, 'moment-as-tie', 'moment verb banked as a lasting tie');
    // 5 silent noun
    if (isUnsupportedKind(r.kind, r.evidence)) flag(r.id, 'silent-noun', 'kin word absent from the quote');
    // 6 gendered kinship vs non-character endpoint
    for (const g of KIND_GENDER) {
      if (g.re.test(r.kind)) {
        const fk = entityKind.get(r.from_entity) ?? '';
        const tk = entityKind.get(r.to_entity) ?? '';
        if ((fk && fk !== 'character') || (tk && tk !== 'character')) {
          flag(r.id, 'kinship-vs-kind', `gendered kinship between non-characters (${fk}/${tk})`);
        }
        break;
      }
    }
    // 7 spouse stacking
    const key = [Math.min(r.from_entity, r.to_entity), Math.max(r.from_entity, r.to_entity)].join(':');
    const sibs = pairKinds.get(key) ?? [];
    if (spouseGroup(r.kind) && sibs.filter((s) => spouseGroup(s.kind)).length > 1) {
      flag(r.id, 'duplicate-spouse', 'husband/wife/spouse/married stacking on one pair');
    }
    // 8 duplicate reverse exact
    const rev = rows.some((o) => o.id !== r.id && o.from_entity === r.to_entity && o.to_entity === r.from_entity && normKind(o.kind) === kind);
    if (rev) flag(r.id, 'duplicate-reverse', 'same kind banked from both sides');
    // 9 case-variant duplicate (runtime dedupes lower, index is case-sensitive)
    const caseVar = rows.some((o) => o.id !== r.id && o.from_entity === r.from_entity && o.to_entity === r.to_entity && o.kind !== r.kind && normKind(o.kind) === kind);
    if (caseVar) flag(r.id, 'duplicate-case', 'case-variant of the same kind on the same direction');
    // 10 human ruling overwritten by model path (needs_review over user_confirmed impossible here, but stale accepted over contested)
    if (r.review_status === 'accepted' && r.conflict_status === 'contested') {
      flag(r.id, 'accepted-over-contested', 'accepted while a rival claim contests it');
    }
    // 11 retracted/superseded still accepted
    if ((r.ledger_state === 'retracted' || r.ledger_state === 'superseded') && r.review_status === 'accepted') {
      flag(r.id, 'ledger-mismatch', `${r.ledger_state} row still reads accepted`);
    }
    // 12 scope missing on revived row (scope coexistence requires explicit scope)
    if (r.ledger_state === 'superseded' && !r.scope) flag(r.id, 'scope-missing', 'superseded without a scope');
    // 13 unplaced but verified (no chunk, still ranked)
    try {
      const refs = JSON.parse(r.source_refs || '[]') as { chunk?: unknown }[];
      const placed = refs.some((x) => Number.isFinite(Number(x?.chunk)) && Number(x?.chunk) > 0);
      if (!placed && r.evidence.trim()) flag(r.id, 'unplaced-verified', 'verified quote with no resolving chunk');
    } catch { flag(r.id, 'bad-refs', 'source_refs not parseable'); }
    // 14 description contradicts kind (very cheap: description names a different closed label)
    // 15-20 reserved numeric guards below share one implementation budget
  }
  // 14 cross-pair: same quote proving two different pairs (copy-paste evidence)
  const quotePairs = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.evidence.trim()) continue;
    const q = r.evidence.trim().toLowerCase().slice(0, 120);
    quotePairs.set(q, new Set([...(quotePairs.get(q) ?? []), r.id]));
  }
  for (const [, set] of quotePairs) {
    if (set.size < 2) continue;
    const list = [...set];
    const pairs = list.map((id) => byId.get(id)!).map((r) => [Math.min(r.from_entity, r.to_entity), Math.max(r.from_entity, r.to_entity)].join(':'));
    if (new Set(pairs).size > 1) for (const id of list) flag(id, 'shared-quote', 'same quote proving two different pairs');
  }
  // 15 participant-less event check (relation references, event without participants)
  try {
    const lonely = db.all<{ id: number }>(
      `SELECT id FROM canon_event WHERE project_id = ? AND (participants IS NULL OR participants = '[]' OR participants = '') LIMIT 50`,
      projectId,
    );
    for (const e of lonely) flag(e.id * -1, 'event-no-participants', `canon_event ${e.id} names nobody`);
  } catch { /* old DBs without the table */ }
  // Apply flags: contested only, never facts.
  for (const h of hits) {
    if (h.id <= 0) continue;
    db.run(`UPDATE canon_relation SET conflict_status = 'contested' WHERE id = ? AND project_id = ?`, h.id, projectId);
  }
  return hits;
}

/** Frozen quarantine predicate: implement verbatim, adjust predicate never rows. */
export function quarantinePredicate(opts: {
  a: string; b: string; sharedScene: boolean; coSpeakerVeto: boolean; corroboration: number;
}): boolean {
  const strip = (s: string): string =>
    s.toLowerCase().replace(/[’']/g, '').replace(/s\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const match = strip(opts.a) === strip(opts.b) || strip(opts.a).startsWith(strip(opts.b)) || strip(opts.b).startsWith(strip(opts.a));
  return match && !opts.sharedScene && !opts.coSpeakerVeto && opts.corroboration < 2;
}

/* ------------------------------------------------- entity identity claims */

/**
 * A summary (or role) that says one row IS another row.
 *
 * Entity intake verifies the evidence quote but stores the summary verbatim,
 * so a claim like "X, also known as Y" banks whenever its attached quote
 * verifies — the gate checks the receipt, not what the summary says with it.
 * This rule mirrors the relations-side both-endpoints principle: an identity
 * claim needs a span-verified quote naming both names. Otherwise the row is
 * flagged needs_review (invisible to status, ranking, graph, and the answer
 * index) and the pair joins the quarantine list for human judgment.
 * Flags only: never edits text, never merges, never deletes.
 */
const IDENTITY_CLAIM_RES: RegExp[] = [
  /also known as\s+([^.,;()]+)/i,
  /\baka\b\s+([^.,;()]+)/i,
  /better known as\s+([^.,;()]+)/i,
  /\bis also\s+([^.,;()]+)/i,
  /\(\s*([^()]*?)\s*\)/,
];

/**
 * Bare copula ("X is Y") without an "also known as"-style marker.
 * Guarded: Y must read as a bare name, not name-plus-role ("the Dark
 * Lord's apprentice" is a relation phrasing, not an identity claim).
 * Generic English relational words only — never book terms.
 */
const COPULA_RE = /\b(?:is|was)\s+((?:the\s+)?[A-Z][\w']*(?:\s+[A-Z][\w']*)*)/;
const RELATION_WORD_AFTER_NAME = new Set([
  'apprentice', 'master', 'ally', 'friend', 'aide', 'mentor', 'servant',
  'enemy', 'rival', 'heir', 'successor', 'padawan', 'colleague', 'peer',
  'partner', 'opponent', 'teacher', 'student', 'agent',
]);

function identTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9']+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

/** True when needle appears as a contiguous word-run inside hay. */
function containsRun(hay: string[], needle: string[]): boolean {
  if (!needle.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Run all entity identity rules and flag unproven claims. Never writes facts. */
export function checkEntities(db: Db, projectId: number, opts: { ids?: number[] } = {}): RuleHit[] {
  const filter = opts.ids && opts.ids.length ? ` AND id IN (${opts.ids.map(() => '?').join(',')})` : '';
  const params: unknown[] = opts.ids && opts.ids.length ? [projectId, ...opts.ids] : [projectId];
  const rows = db.all<{
    id: number; kind: string; name: string; aliases: string; summary: string;
    role: string; evidence: string; review_status: string;
  }>(
    `SELECT id, kind, name, aliases, summary, role, evidence, review_status
       FROM canon_entity WHERE project_id = ?${filter} ORDER BY id`,
    ...params,
  );
  if (!rows.length) return [];
  const ownNames = new Map<number, string[]>();
  for (const r of rows) {
    let aliases: string[] = [];
    try { aliases = JSON.parse(r.aliases || '[]') as string[]; } catch { aliases = []; }
    ownNames.set(r.id, [r.name, ...aliases]);
  }
  const hits: RuleHit[] = [];
  const flag = (id: number, rule: string, reason: string): void => {
    if (hits.some((h) => h.id === id && h.rule === rule)) return;
    hits.push({ id, rule, reason });
  };
  const claimed: { id: number; otherId: number; otherName: string; span: string }[] = [];
  for (const r of rows) {
    if (r.review_status === 'user_confirmed' || r.review_status === 'rejected') continue;
    const text = `${r.summary || ''}\n${r.role || ''}`;
    const mine = ownNames.get(r.id)!.map((n) => identTokens(n)).filter((t) => t.length);
    const spans: string[] = [];
    for (const re of IDENTITY_CLAIM_RES) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
        const span = (m[1] ?? '').trim();
        if (span) spans.push(span);
      }
    }
    // Bare copula with no trailing role noun: "X is Darth Y" claims identity,
    // "X is Darth Y's apprentice" states a relation and is not one.
    for (const m of text.matchAll(new RegExp(COPULA_RE.source, COPULA_RE.flags + 'g'))) {
      const span = (m[1] ?? '').replace(/^the\s+/i, '').trim();
      if (!span) continue;
      const after = text.slice((m.index ?? 0) + m[0].length).trim().split(/[\s.,;()]+/).filter(Boolean)[0]?.toLowerCase() ?? '';
      if (RELATION_WORD_AFTER_NAME.has(after) || RELATION_WORD_AFTER_NAME.has(after.replace(/'s$/, ''))) continue;
      spans.push(span);
    }
    for (const span of spans) {
      const spanToks = identTokens(span);
      if (!spanToks.length) continue;
      // A span restating this row's own name is not a claim about another row.
      if (mine.some((t) => containsRun(spanToks, t) || containsRun(t, spanToks))) continue;
      for (const o of rows) {
        if (o.id === r.id) continue;
        const otherNames = ownNames.get(o.id)!;
        const match = otherNames.some((n) => {
          const t = identTokens(n);
          return t.length > 0 && (containsRun(spanToks, t) || containsRun(t, spanToks));
        });
        if (!match) continue;
        // Proven only by a quote naming both sides — the both-endpoints rule.
        const evToks = identTokens(r.evidence || '');
        const sideNamed = (names: string[]): boolean =>
          names.some((n) => containsRun(evToks, identTokens(n)));
        if (sideNamed(ownNames.get(r.id)!) && sideNamed(otherNames)) continue;
        flag(r.id, 'summary-identity-unproven', `summary claims "${span.trim().slice(0, 80)}" naming ${o.name} without a both-endpoints quote`);
        claimed.push({ id: r.id, otherId: o.id, otherName: o.name, span: span.trim().slice(0, 120) });
        break;
      }
    }
  }
  const now = new Date().toISOString();
  for (const h of hits) {
    if (h.rule !== 'summary-identity-unproven') continue;
    db.run(`UPDATE canon_entity SET review_status = 'needs_review', updated_at = ? WHERE id = ? AND project_id = ? AND review_status = 'accepted'`, now, h.id, projectId);
  }
  for (const c of claimed) {
    const claimer = rows.find((r) => r.id === c.id);
    if (!claimer) continue;
    db.run(
      `INSERT OR IGNORE INTO quarantine_alias (project_id, name, candidate, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      projectId, claimer.name, c.otherName, `summary-identity: claims "${c.span}"`, now,
    );
  }
  return hits;
}
