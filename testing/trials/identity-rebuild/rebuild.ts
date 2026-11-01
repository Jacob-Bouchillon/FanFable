/**
 * Stage A of the identity-and-evidence rebuild: audit and repair the
 * character roster on a disposable copy.
 *
 * Trial-only. The live bank is NEVER opened here — not even read-only.
 * Step `backup` hashes the live main file (sha256, streaming read) and
 * copies it twice under testing/trials/identity-rebuild/ (timestamped
 * backup + working copy.db); every later step touches only the copy.
 * Step `verify` re-hashes the live file and fails unless byte-identical.
 *
 * Steps (from the repo root):
 *   node --experimental-strip-types testing/trials/identity-rebuild/rebuild.ts [backup|roster|merge|propose|cover|verify|all]
 *
 * Writes only under testing/trials/identity-rebuild/ (gitignored).
 * No model calls. No status promotions/demotions anywhere (merges on the
 * copy only). Reports print counts only, never passage prose; names appear
 * only inside the CSV artifacts the user must confirm.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/identity-rebuild';
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const COPY = `${TRACK}/copy.db`;
const PROJECT = 1;
const PROOF = ['accepted', 'attested', 'user_confirmed'];

function fail(message: string): never {
  throw new Error(`rebuild: ${message}`);
}

function sha256(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Fold for mechanical comparison: NFKC, straight quotes, lower, collapse. */
function fold(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Punctuation-stripped fold for rule (b): drop apostrophes/hyphens. */
function foldBare(s: string): string {
  return fold(s).replace(/['’‘\-_]/g, '').replace(/\s+/g, ' ').trim();
}

const TITLES = ['supreme chancellor', 'darth', 'captain', 'senator', 'master', 'king', 'magister'];

function stripTitle(norm: string): string | null {
  for (const t of TITLES) {
    if (norm.startsWith(t + ' ')) return norm.slice(t.length + 1).trim();
  }
  return null;
}

function tokens(norm: string): string[] {
  return norm.split(' ').filter(Boolean);
}

interface Entity {
  id: number;
  name: string;
  aliases: string[];
  mentions: number;
  review_status: string;
}

function loadEntities(db: DatabaseSync): Entity[] {
  const rows = db
    .prepare('SELECT id, name, aliases, mentions, review_status FROM canon_entity WHERE project_id = ? AND kind = ? ORDER BY id')
    .all(PROJECT, 'character') as { id: number; name: string; aliases: string; mentions: number; review_status: string }[];
  return rows.map((r) => {
    let aliases: string[] = [];
    try {
      const p = JSON.parse(r.aliases || '[]') as unknown;
      if (Array.isArray(p)) aliases = p.map(String);
    } catch { aliases = []; }
    return { id: r.id, name: r.name, aliases, mentions: r.mentions, review_status: r.review_status };
  });
}

function forms(e: Entity): string[] {
  return [e.name, ...e.aliases].filter(Boolean);
}

export function backup(): { liveSha: string; liveSize: number; stamp: string } {
  mkdirSync(TRACK, { recursive: true });
  if (!existsSync(LIVE)) fail(`live bank missing at ${LIVE}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const liveSha = sha256(LIVE);
  const liveSize = readFileSync(LIVE).length;
  copyFileSync(LIVE, `${TRACK}/backup-halfbook-${stamp}.db`);
  if (existsSync(COPY)) rmSync(COPY);
  for (const suf of ['-wal', '-shm', '-journal']) {
    if (existsSync(COPY + suf)) rmSync(COPY + suf);
  }
  copyFileSync(LIVE, COPY);
  const copySha = sha256(COPY);
  if (copySha !== liveSha) fail('copy hash mismatch');
  const manifest = { stamp, live: LIVE, liveSha, liveSize, copySha, copy: COPY };
  writeFileSync(`${TRACK}/manifest.json`, JSON.stringify(manifest, null, 1));
  console.log(`backup: live sha ${liveSha.slice(0, 12)} size ${liveSize} stamp ${stamp} copy ok`);
  return { liveSha, liveSize, stamp };
}

function proofCount(db: DatabaseSync, entityId: number): number {
  const q = `SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status IN (${PROOF.map(() => '?').join(',')}) AND (from_entity = ? OR to_entity = ?)`;
  return (db.prepare(q).get(PROJECT, ...PROOF, entityId, entityId) as { c: number }).c;
}

function needsCount(db: DatabaseSync, entityId: number): number {
  return (
    db.prepare('SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status = ? AND (from_entity = ? OR to_entity = ?)')
      .get(PROJECT, 'needs_review', entityId, entityId) as { c: number }
  ).c;
}

export function roster(): number {
  const db = new DatabaseSync(COPY, { readOnly: true });
  try {
    const entities = loadEntities(db);
    const lines = ['id,name,aliases,mentions,proof_rows,needs_review_rows,review_status'];
    for (const e of entities) {
      lines.push(
        [e.id, csvCell(e.name), csvCell(JSON.stringify(e.aliases)), e.mentions, proofCount(db, e.id), needsCount(db, e.id), e.review_status].join(','),
      );
    }
    writeFileSync(`${TRACK}/roster.csv`, lines.join('\n') + '\n');
    console.log(`roster: ${entities.length} characters dumped`);
    return entities.length;
  } finally {
    db.close();
  }
}

interface Merge {
  loser: number;
  loserName: string;
  survivor: number;
  survivorName: string;
  rule: string;
}

/** Find mechanically-certain merges; union-find over entity ids. */
export function findMerges(entities: Entity[]): Merge[] {
  const parent = new Map<number, number>();
  const ruleOf = new Map<string, string>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const link = (a: number, b: number, rule: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Survivor: higher mentions wins, tie -> lower id. Record rule on pair.
    parent.set(Math.max(ra, rb), Math.min(ra, rb));
    const key = [Math.min(a, b), Math.max(a, b)].join(':');
    if (!ruleOf.has(key)) ruleOf.set(key, rule);
  };
  for (const e of entities) parent.set(e.id, e.id);
  // Placeholders never auto-merge (invented/kin labels, not persons).
  const excluded = new Set(entities.filter((e) => isPlaceholderName(fold(e.name))).map((e) => e.id));

  const normForms = new Map<number, Set<string>>();
  const bareForms = new Map<number, Set<string>>();
  for (const e of entities) {
    normForms.set(e.id, new Set(forms(e).map(fold).filter(Boolean)));
    bareForms.set(e.id, new Set(forms(e).map(foldBare).filter(Boolean)));
  }

  /** Guard: two entities each carrying a different given name never merge.
   * Leading titles are not given names (Senator Pax Teem vs Pax Teem). */
  const givenNameClash = (a: Entity, b: Entity): boolean => {
    const stripAll = (s: string): string[] => {
      let t = tokens(fold(s));
      for (;;) {
        let cut = false;
        for (const title of [...TITLES].sort((x, y) => y.length - x.length)) {
          const wt = title.split(' ');
          if (wt.every((w, k) => t[k] === w)) {
            t = t.slice(wt.length);
            cut = true;
            break;
          }
        }
        if (!cut) break;
      }
      return t;
    };
    const ta = stripAll(a.name);
    const tb = stripAll(b.name);
    if (ta.length > 1 && tb.length > 1 && ta[0] !== tb[0]) return true;
    // Single-token vs multi-token sharing only the surname: keep apart
    // (e.g. bare surname vs full name with a different given name).
    if (ta.length === 1 && tb.length > 1 && tb[tb.length - 1] === ta[0]) return true;
    if (tb.length === 1 && ta.length > 1 && ta[ta.length - 1] === tb[0]) return true;
    return false;
  };

  const ids = entities.map((e) => e.id);
  const byId = new Map(entities.map((e) => [e.id, e]));

  // (a) identical normalized name/alias.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (excluded.has(ids[i]!) || excluded.has(ids[j]!)) continue;
      const A = normForms.get(ids[i]!)!;
      const B = normForms.get(ids[j]!)!;
      let hit = false;
      for (const f of A) if (B.has(f)) { hit = true; break; }
      if (hit && !givenNameClash(byId.get(ids[i]!)!, byId.get(ids[j]!)!)) link(ids[i]!, ids[j]!, 'a');
    }
  }
  // (b) punctuation/spacing variants: bare match without a plain match.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (excluded.has(ids[i]!) || excluded.has(ids[j]!)) continue;
      if (find(ids[i]!) === find(ids[j]!)) continue;
      const A = bareForms.get(ids[i]!)!;
      const B = bareForms.get(ids[j]!)!;
      const An = normForms.get(ids[i]!)!;
      const Bn = normForms.get(ids[j]!)!;
      let bareHit = false;
      for (const f of A) if (B.has(f)) { bareHit = true; break; }
      if (!bareHit) continue;
      let plainHit = false;
      for (const f of An) if (Bn.has(f)) { plainHit = true; break; }
      if (plainHit) continue; // already rule (a) territory
      if (!givenNameClash(byId.get(ids[i]!)!, byId.get(ids[j]!)!)) link(ids[i]!, ids[j]!, 'b');
    }
  }
  // (c) title-prefix strip leaves the other name exactly + shared token.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (excluded.has(ids[i]!) || excluded.has(ids[j]!)) continue;
      if (find(ids[i]!) === find(ids[j]!)) continue;
      const A = byId.get(ids[i]!)!;
      const B = byId.get(ids[j]!)!;
      if (givenNameClash(A, B)) continue;
      const fa = [...normForms.get(A.id)!];
      const fb = [...normForms.get(B.id)!];
      let hit = false;
      for (const x of fa) {
        const sx = stripTitle(x);
        if (sx && fb.includes(sx) && tokens(sx).some((t) => tokens(x).includes(t))) { hit = true; break; }
      }
      if (!hit) {
        for (const y of fb) {
          const sy = stripTitle(y);
          if (sy && fa.includes(sy) && tokens(sy).some((t) => tokens(y).includes(t))) { hit = true; break; }
        }
      }
      if (hit) link(A.id, B.id, 'c');
    }
  }

  // Emit loser -> survivor per group (survivor: max mentions, tie lowest id).
  const groups = new Map<number, number[]>();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }
  const merges: Merge[] = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((x, y) => {
      const ex = byId.get(x)!;
      const ey = byId.get(y)!;
      if (ey.mentions !== ex.mentions) return ey.mentions - ex.mentions;
      return x - y;
    });
    const survivor = sorted[0]!;
    for (const loser of sorted.slice(1)) {
      const key = [Math.min(loser, survivor), Math.max(loser, survivor)].join(':');
      merges.push({
        loser,
        loserName: byId.get(loser)!.name,
        survivor,
        survivorName: byId.get(survivor)!.name,
        rule: ruleOf.get(key) ?? 'a',
      });
    }
  }
  return merges;
}

function coverageOn(db: DatabaseSync): { chars: number; proofRows: number; tied: number } {
  const chars = (db.prepare('SELECT count(*) c FROM canon_entity WHERE project_id = ? AND kind = ?').get(PROJECT, 'character') as { c: number }).c;
  const proofRows = db
    .prepare(`SELECT id, from_entity, to_entity FROM canon_relation WHERE project_id = ? AND review_status IN (${PROOF.map(() => '?').join(',')})`)
    .all(PROJECT, ...PROOF) as { id: number; from_entity: number; to_entity: number }[];
  const tied = new Set<number>();
  for (const r of proofRows) {
    tied.add(r.from_entity);
    tied.add(r.to_entity);
  }
  // Restrict to character ids (relations may touch other kinds).
  const charIds = new Set(
    (db.prepare('SELECT id FROM canon_entity WHERE project_id = ? AND kind = ?').all(PROJECT, 'character') as { id: number }[]).map((r) => r.id),
  );
  let tiedChars = 0;
  for (const id of tied) if (charIds.has(id)) tiedChars++;
  return { chars, proofRows: proofRows.length, tied: tiedChars };
}

type AnyRow = Record<string, unknown>;

const REL_RANK: Record<string, number> = { user_confirmed: 5, attested: 4, accepted: 3, needs_review: 2, provisional: 1 };

/** Union two source_refs JSON arrays, deduped by JSON text. */
function unionRefs(a: string, b: string): string {
  try {
    const la = JSON.parse(a || '[]') as unknown[];
    const lb = JSON.parse(b || '[]') as unknown[];
    const seen = new Set(la.map((x) => JSON.stringify(x)));
    for (const x of lb) {
      const k = JSON.stringify(x);
      if (!seen.has(k)) {
        seen.add(k);
        la.push(x);
      }
    }
    return JSON.stringify(la);
  } catch {
    return a || b || '[]';
  }
}

/** Dropped-row log (folds + self-loops), flushed to the merge log. */
export const droppedLog: string[] = [];

function logDropped(what: string, row: AnyRow): void {
  droppedLog.push(`${what} ${JSON.stringify(row)}`);
}
function relWinner(a: AnyRow, b: AnyRow): AnyRow {
  const ra = REL_RANK[String(a.review_status)] ?? 0;
  const rb = REL_RANK[String(b.review_status)] ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  const ca = Number(a.confidence ?? 0);
  const cb = Number(b.confidence ?? 0);
  if (ca !== cb) return ca > cb ? a : b;
  return Number(a.id) < Number(b.id) ? a : b;
}

/**
 * Pre-check: would this merge touch any user_confirmed row destructively?
 * A UC row that would collide (fold/delete) or become a self-loop vetoes
 * the whole merge — user_confirmed rows must never change. Returns reason.
 */
function ucRisk(db: DatabaseSync, loser: number, survivor: number): string | null {
  const ucRows = db
    .prepare("SELECT * FROM canon_relation WHERE project_id = ? AND review_status = 'user_confirmed' AND (from_entity = ? OR to_entity = ?)")
    .all(PROJECT, loser, loser) as AnyRow[];
  for (const row of ucRows) {
    const from = row.from_entity === loser ? survivor : (row.from_entity as number);
    const to = row.to_entity === loser ? survivor : (row.to_entity as number);
    if (from === to) return `uc-selfloop row ${row.id}`;
    const clash = db
      .prepare('SELECT id FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ? AND scope = ? AND id != ?')
      .get(row.project_id, from, to, row.kind, row.scope, row.id) as { id: number } | undefined;
    if (clash) return `uc-collision row ${row.id} vs ${clash.id}`;
  }
  return null;
}
/**
 * Re-point one entity-FK column, folding rows that would collide on the
 * table's uniqueness key. Returns folded count. Folded rows merge their
 * source_refs into the winner and fill empty description/evidence.
 * (UC rows never reach here: ucRisk vetoes such merges first.)
 */
function repointRelationColumn(db: DatabaseSync, column: 'from_entity' | 'to_entity', loser: number, survivor: number): number {
  const rows = db.prepare(`SELECT * FROM canon_relation WHERE ${column} = ?`).all(loser) as AnyRow[];
  let folded = 0;
  for (const row of rows) {
    const from = column === 'from_entity' ? survivor : (row.from_entity as number);
    const to = column === 'to_entity' ? survivor : (row.to_entity as number);
    const clash = db
      .prepare('SELECT * FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ? AND scope = ? AND id != ?')
      .get(row.project_id, from, to, row.kind, row.scope, row.id) as AnyRow | undefined;
    if (!clash) {
      db.prepare(`UPDATE canon_relation SET ${column} = ? WHERE id = ?`).run(survivor, row.id);
      continue;
    }
    const moved: AnyRow = { ...row, [column]: survivor };
    const winMoved = relWinner(moved, clash) === moved;
    if (!winMoved) {
      // Pre-existing row wins: the moved row is a duplicate. Delete it and
      // log it in full. (No endpoint update needed — the row is gone, so no
      // cascade risk. UC keepers are never content-modified.)
      if (String(clash.review_status) === 'user_confirmed') logDropped(`relfold-vs-uc-kept-${clash.id}`, row);
      else logDropped(`relfold-into-${clash.id}`, row);
      db.prepare('DELETE FROM canon_relation WHERE id = ?').run(row.id);
      folded++;
      continue;
    }
    // Moved row wins: remove the clash first (frees the unique key), then
    // re-point the endpoint and merge content. Endpoint update MUST happen
    // before the loser-entity delete or the cascade takes the keeper.
    if (String(moved.review_status) === 'user_confirmed') logDropped(`relfold-vs-uc-kept-${row.id}`, clash);
    else logDropped(`relfold-into-${row.id}`, clash);
    db.prepare('DELETE FROM canon_relation WHERE id = ?').run(clash.id);
    db.prepare(`UPDATE canon_relation SET ${column} = ? WHERE id = ?`).run(survivor, row.id);
    if (String(moved.review_status) !== 'user_confirmed') {
      db.prepare('UPDATE canon_relation SET source_refs = ?, description = ?, evidence = ? WHERE id = ?').run(
        unionRefs(String(moved.source_refs ?? '[]'), String(clash.source_refs ?? '[]')),
        (moved.description as string) || (clash.description as string) || '',
        (moved.evidence as string) || (clash.evidence as string) || '',
        row.id,
      );
    }
    folded++;
  }
  return folded;
}

/** Re-point thread endpoints; unique-identity collisions fold into lower id. */
function repointThreadColumn(db: DatabaseSync, column: 'a_entity' | 'b_entity', loser: number, survivor: number): number {
  const rows = db.prepare(`SELECT * FROM canon_thread WHERE ${column} = ?`).all(loser) as AnyRow[];
  let folded = 0;
  for (const row of rows) {
    try {
      db.prepare(`UPDATE canon_thread SET ${column} = ? WHERE id = ?`).run(survivor, row.id);
    } catch {
      // UNIQUE collision: find the row holding the would-be key, keep the
      // lower id, drop the other.
      const moved: AnyRow = { ...row, [column]: survivor };
      const clash = (db.prepare('SELECT * FROM canon_thread WHERE id != ?').all(row.id) as AnyRow[]).find(
        (r) =>
          r.project_id === moved.project_id &&
          r.kind === moved.kind &&
          r.a_entity === moved.a_entity &&
          (r.b_entity ?? null) === (moved.b_entity ?? null) &&
          (r.parent_a_thread ?? null) === (moved.parent_a_thread ?? null) &&
          (r.parent_b_thread ?? null) === (moved.parent_b_thread ?? null) &&
          (r.period_label ?? null) === (moved.period_label ?? null),
      );
      if (!clash) throw new Error(`rebuild: thread re-point failed without visible clash (row ${row.id})`);
      db.prepare('DELETE FROM canon_thread WHERE id = ?').run(Math.max(Number(row.id), Number(clash.id)));
      folded++;
    }
  }
  return folded;
}
function repointTieColumn(db: DatabaseSync, column: 'from_entity' | 'to_entity', loser: number, survivor: number): number {
  const rows = db.prepare(`SELECT * FROM canon_tie_note WHERE ${column} = ?`).all(loser) as AnyRow[];
  let folded = 0;
  for (const row of rows) {
    const from = column === 'from_entity' ? survivor : (row.from_entity as number);
    const to = column === 'to_entity' ? survivor : (row.to_entity as number);
    const clash = db
      .prepare('SELECT * FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ? AND id != ?')
      .get(row.project_id, from, to, row.attempted_kind, row.id) as AnyRow | undefined;
    if (!clash) {
      db.prepare(`UPDATE canon_tie_note SET ${column} = ? WHERE id = ?`).run(survivor, row.id);
      continue;
    }
    const keepLower = Number(row.id) < Number(clash.id);
    if (!keepLower) {
      logDropped(`tiefold-into-${clash.id}`, row);
      db.prepare('DELETE FROM canon_tie_note WHERE id = ?').run(row.id);
      folded++;
      continue;
    }
    logDropped(`tiefold-into-${row.id}`, clash);
    db.prepare('DELETE FROM canon_tie_note WHERE id = ?').run(clash.id);
    db.prepare(`UPDATE canon_tie_note SET ${column} = ? WHERE id = ?`).run(survivor, row.id);
    db.prepare('UPDATE canon_tie_note SET source_refs = ?, evidence = ? WHERE id = ?').run(
      unionRefs(String(row.source_refs ?? '[]'), String(clash.source_refs ?? '[]')),
      (row.evidence as string) || (clash.evidence as string) || '',
      row.id,
    );
    folded++;
  }
  return folded;
}

export function merge(): Merge[] {
  const db = new DatabaseSync(COPY);
  try {
    const before = coverageOn(db);
    const ucBefore = (db.prepare("SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status = 'user_confirmed'").get(PROJECT) as { c: number }).c;
    const entities = loadEntities(db);
    const byId = new Map(entities.map((e) => [e.id, e]));
    const merges = findMerges(entities);

    const map = new Map<number, number>();
    for (const m of merges) map.set(m.loser, m.survivor);

    const updFact = db.prepare('UPDATE canon_fact SET subject_entity_id = ? WHERE subject_entity_id = ?');
    const updPart = db.prepare('UPDATE canon_event_participant SET entity_id = ? WHERE entity_id = ?');
    const updChar = db.prepare('UPDATE character SET canon_entity_id = ? WHERE canon_entity_id = ?');

    // Self-loops created by the merge are artifacts: count and remove.
    // (UC self-loops impossible: ucRisk vetoes those merges first.)
    let selfLoopsRemoved = 0;
    let relFolded = 0;
    let tieFolded = 0;
    let threadFolded = 0;
    const skipped: { loser: number; loserName: string; survivor: number; survivorName: string; rule: string; reason: string }[] = [];

    for (const m of merges) {
      const risk = ucRisk(db, m.loser, m.survivor);
      if (risk) {
        skipped.push({ ...m, reason: risk });
        continue;
      }
      relFolded += repointRelationColumn(db, 'from_entity', m.loser, m.survivor);
      relFolded += repointRelationColumn(db, 'to_entity', m.loser, m.survivor);
      tieFolded += repointTieColumn(db, 'from_entity', m.loser, m.survivor);
      tieFolded += repointTieColumn(db, 'to_entity', m.loser, m.survivor);
      updFact.run(m.survivor, m.loser);
      updPart.run(m.survivor, m.loser);
      threadFolded += repointThreadColumn(db, 'a_entity', m.loser, m.survivor);
      threadFolded += repointThreadColumn(db, 'b_entity', m.loser, m.survivor);
      updChar.run(m.survivor, m.loser);
      // Fold loser's name + aliases into survivor aliases; sum mentions.
      const s = byId.get(m.survivor)!;
      const l = byId.get(m.loser)!;
      const aliasSet = new Set([...s.aliases, l.name, ...l.aliases].filter((a) => fold(a) !== fold(s.name)));
      db.prepare('UPDATE canon_entity SET aliases = ?, mentions = ? WHERE id = ?').run(JSON.stringify([...aliasSet]), s.mentions + l.mentions, s.id);
      s.aliases = [...aliasSet];
      s.mentions += l.mentions;
      if (l.review_status === 'needs_review' && s.review_status !== 'needs_review') {
        db.prepare("UPDATE canon_entity SET review_status = 'needs_review' WHERE id = ?").run(s.id);
        s.review_status = 'needs_review';
      }
      db.prepare('DELETE FROM canon_entity WHERE id = ?').run(m.loser);
    }
    const selfLoops = db
      .prepare('SELECT id FROM canon_relation WHERE project_id = ? AND from_entity = to_entity')
      .all(PROJECT) as { id: number }[];
    // Only loops involving a merged endpoint are ours; others predate us.
    const mergedEndpoints = new Set<number>();
    for (const m of merges) mergedEndpoints.add(m.survivor);
    for (const row of selfLoops) {
      const r = db.prepare('SELECT from_entity FROM canon_relation WHERE id = ?').get(row.id) as { from_entity: number };
      if (mergedEndpoints.has(r.from_entity)) {
        const full = db.prepare('SELECT * FROM canon_relation WHERE id = ?').get(row.id) as AnyRow;
        logDropped('selfloop', full);
        db.prepare('DELETE FROM canon_relation WHERE id = ?').run(row.id);
        selfLoopsRemoved++;
      }
    }

    const after = coverageOn(db);
    const ucAfter = (db.prepare("SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status = 'user_confirmed'").get(PROJECT) as { c: number }).c;
    const lines = ['loser_id,loser_name,survivor_id,survivor_name,rule'];
    for (const m of merges.filter((x) => !skipped.some((s) => s.loser === x.loser))) {
      lines.push([m.loser, csvCell(m.loserName), m.survivor, csvCell(m.survivorName), m.rule].join(','));
    }
    writeFileSync(`${TRACK}/merges.csv`, lines.join('\n') + '\n');
    const skipLines = ['loser_id,loser_name,survivor_id,survivor_name,rule,reason'];
    for (const s of skipped) skipLines.push([s.loser, csvCell(s.loserName), s.survivor, csvCell(s.survivorName), s.rule, csvCell(s.reason)].join(','));
    writeFileSync(`${TRACK}/skipped.csv`, skipLines.join('\n') + '\n');
    // Flush this process's dropped rows; textmerge() folds them into merge-log.md.
    writeFileSync(`${TRACK}/dropped-mechanical.md`, droppedLog.map((d) => `- ${d}`).join('\n') + '\n');
    writeFileSync(
      `${TRACK}/coverage.json`,
      JSON.stringify({ before, after, selfLoopsRemoved, relFolded, tieFolded, threadFolded, userConfirmedBefore: ucBefore, userConfirmedAfter: ucAfter }, null, 1),
    );
    const rules = { a: 0, b: 0, c: 0 } as Record<string, number>;
    const applied = merges.filter((x) => !skipped.some((s) => s.loser === x.loser));
    for (const m of applied) rules[m.rule] = (rules[m.rule] ?? 0) + 1;
    console.log(`merge: ${applied.length} applied (rules a=${rules.a} b=${rules.b} c=${rules.c}) skipped=${skipped.length} selfLoopsRemoved=${selfLoopsRemoved} relFolded=${relFolded} tieFolded=${tieFolded} threadFolded=${threadFolded} uc ${ucBefore}->${ucAfter}`);
    console.log(`cover: chars ${before.chars}->${after.chars} proofRows ${before.proofRows}->${after.proofRows} tied ${before.tied}->${after.tied}`);
    if (ucBefore !== ucAfter) fail('user_confirmed row count moved');
    return applied;
  } finally {
    db.close();
  }
}

/** Edit distance over short strings (surname-variant check). */
function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m]![n]!;
}

interface Proposal {
  a: number;
  b: number | '';
  nameA: string;
  nameB: string;
  kind: string;
  evidence: string;
  confidence: number;
}

const ORG_WORDS = ['security', 'armor', 'armour', 'order', 'council', 'knights', 'resources', 'program', 'vigos', 'circle', 'sun', 'baktoid', 'santhe', 'zillo', 'fuel', 'legislative', 'youth', 'trade', 'federation'];
const ROLE_WORDS = ['croupier', 'ambassador', 'manager', 'lobbyist', 'assassin', 'assassins', 'female', 'senators', 'cloners', 'personnel', 'guards'];
const SPECIES = ['weequay', 'quarren', 'ithorian', "twi'lek", 'twi-lek', 'twilek', "twi'leks", 'twi', 'wookiee', 'barabel', 'barabels', 'iktotchi', 'kaminoan', 'sluissi', 'nightsister', 'bothan', 'bothans', 'gran', 'human', 'echani', 'zabrak', 'sullustan', 'neimoidian', 'neimoidians', 'dug', 'dugs', 'kubaz', 'muun', "shi'ido", 'nikto'];

const PLACEHOLDER_RE = /\(son\)|\bmother\b|\bfather\b|\bsiblings\b|\bbrother\b|\bsister\b|\bfamily\b|\bclan\b/;
const TITLE_WORDS = new Set(['supreme', 'chancellor', 'darth', 'captain', 'senator', 'master', 'king', 'magister', 'queen', 'prince', 'chairman', 'viceroy', 'padawan']);

export function isPlaceholderName(folded: string): boolean {
  return folded === 'darth valorum' || PLACEHOLDER_RE.test(folded);
}

export function propose(): Proposal[] {
  const db = new DatabaseSync(COPY, { readOnly: true });
  try {
    const entities = loadEntities(db);
    const out: Proposal[] = [];
    const seen = new Set<string>();
    const push = (p: Proposal): void => {
      const key = `${p.kind}|${p.a}|${p.b}|${p.evidence}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };

    // --- non-persons and placeholders (single-entity rows) ---
    for (const e of entities) {
      const n = fold(e.name);
      const toks = tokens(n);
      if (isPlaceholderName(n)) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'placeholder', evidence: n === 'darth valorum' ? 'invented persona label, not a distinct person' : 'kin/family label, not a distinct person', confidence: 0.2 });
        continue;
      }
      if (/\bthe (second|first|third|fourth)\b/.test(n)) continue; // generational person (Kerred Santhe the Second), not an org
      if (/'s\b/.test(n) && !toks.some((t) => /^[A-Z]/.test(t))) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'possessive descriptor phrase, not an individual proper name', confidence: 0.25 });
        continue;
      }
      if (/^[a-z]/.test(e.name.trim()) && toks.length > 1) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'lowercase descriptor phrase, not a proper name', confidence: 0.25 });
        continue;
      }
      if (toks.length === 1 && /^[a-z]/.test(e.name.trim()) && ROLE_WORDS.includes(n)) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'lowercase role noun, not a proper name', confidence: 0.2 });
        continue;
      }
      const last = toks[toks.length - 1] ?? '';
      if (SPECIES.includes(n) || SPECIES.includes(last) || (toks.length === 1 && n.endsWith('s') && SPECIES.includes(n.slice(0, -1)))) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'species-form name (plural or bare people name), not an individual', confidence: 0.25 });
        continue;
      }
      if (toks.length > 1 && ORG_WORDS.some((w) => toks.includes(w))) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'organisation-form name (org keyword), not an individual', confidence: 0.3 });
        continue;
      }
      if (toks.length > 1 && ROLE_WORDS.some((w) => toks.includes(w))) {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'role/descriptor phrase, no individual proper name', confidence: 0.3 });
        continue;
      }
      if (n === 'geonosis') {
        push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'place name, not a person', confidence: 0.2 });
        continue;
      }
      if (toks.length === 1 && (n.endsWith('s') || n.endsWith('n') || n.endsWith('i'))) {
        // Bare plural-form collectives that read as peoples, not persons.
        if (/^(weequay|quarren|ithorian|twi|wookiee|barabel|iktotchi|gran|human|echani|zabrak|sullustan|bothan|nightsister|sluissi|kaminoan)/.test(n)) {
          push({ a: e.id, b: '', nameA: e.name, nameB: '', kind: 'non-person', evidence: 'people-form name, not an individual', confidence: 0.25 });
        }
      }
    }

    // --- pair proposals ---
    const byId = new Map(entities.map((e) => [e.id, e]));
    const nonPerson = new Set(out.filter((p) => p.kind === 'non-person' || p.kind === 'placeholder').map((p) => p.a));
    const surnameOf = (e: Entity): string => {
      const t = tokens(fold(e.name));
      return t.length ? t[t.length - 1]! : '';
    };
    const stripLeadingTitles = (toks: string[]): string[] => {
      let t = [...toks];
      for (;;) {
        let cut = false;
        for (const title of [...TITLES].sort((x, y) => y.length - x.length)) {
          const wt = title.split(' ');
          if (wt.every((w, k) => t[k] === w)) {
            t = t.slice(wt.length);
            cut = true;
            break;
          }
        }
        if (!cut) break;
      }
      return t;
    };
    // Pairs the job explicitly decides: never same-person candidates.
    const decidedKeep = new Set(['palpatine|cosinga palpatine']);
    const pairKey = (x: string, y: string): string => [x, y].sort().join('|');
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const A = entities[i]!;
        const B = entities[j]!;
        if (nonPerson.has(A.id) || nonPerson.has(B.id)) continue;
        if (decidedKeep.has(pairKey(fold(A.name), fold(B.name)))) continue;
        const ta = new Set(tokens(fold(A.name)));
        const tb = new Set(tokens(fold(B.name)));
        const shared = [...ta].filter((t) => tb.has(t) && t.length > 2 && !TITLES.includes(t) && t !== 'the');
        if (!shared.length) continue;
        const sa = surnameOf(A);
        const sb = surnameOf(B);
        const sta = stripLeadingTitles(tokens(fold(A.name)));
        const stb = stripLeadingTitles(tokens(fold(B.name)));
        const single = sta.length === 1 || stb.length === 1;
        if (!single && sa && sa === sb && sta[0] !== stb[0]) {
          // Same surname, distinct real given names: must stay apart.
          push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'different-people-keep', evidence: `shared surname only; distinct given names`, confidence: 0.3 });
          continue;
        }
        if (!single && sta[0] !== undefined && sta[0] === stb[0] && sa !== sb) {
          // Shared given name, distinct tails: epithet-forms (Jabba the
          // Hutt) and near-spelling variants (Lo Bu / Lo Bukk) are
          // same-person candidates; truly distinct surnames stay apart.
          const epithetThe = sta.includes('the') || stb.includes('the');
          const dist = lev(sta.join(' '), stb.join(' '));
          if (epithetThe || dist <= 2) {
            push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'same-person', evidence: epithetThe ? 'shared given name with epithet-form; confirm' : 'near-spelling variant; confirm', confidence: 0.45 });
          } else {
            push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'different-people-keep', evidence: 'shared given name, distinct surnames', confidence: 0.3 });
          }
          continue;
        }
        if (!single && sa === sb) {
          // Same stripped surname with a title-form on one side
          // (King Tapalo vs Bon Tapalo): ambiguous, confirm.
          push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'same-person', evidence: 'title-form vs fuller name; confirm', confidence: 0.35 });
          continue;
        }
        const contains = fold(A.name).includes(fold(B.name)) || fold(B.name).includes(fold(A.name));
        if (contains || single) {
          // Bare form vs fuller name (or containment): candidate, but the
          // bare form may belong to another bearer — confirm.
          push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'same-person', evidence: 'bare form contained in fuller name; confirm bearer', confidence: 0.35 });
        } else if (shared.length >= 1 && sta[0] === stb[0]) {
          push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'same-person', evidence: 'shared given name token', confidence: 0.5 });
        }
      }
    }

    // --- alias-linkage same-person candidates (one side's name echoes the other's alias) ---
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const A = entities[i]!;
        const B = entities[j]!;
        if (nonPerson.has(A.id) || nonPerson.has(B.id)) continue;
        const na = fold(A.name);
        const nb = fold(B.name);
        const aliasHit =
          [...B.aliases.map(fold), ...A.aliases.map(fold)].length > 0 &&
          (A.aliases.map(fold).some((x) => x && (nb.includes(x) || x.includes(nb))) ||
            B.aliases.map(fold).some((x) => x && (na.includes(x) || x.includes(na))));
        if (!aliasHit) continue;
        // Skip pairs already proposed above.
        const already = out.some((p) => p.kind === 'same-person' && ((p.a === A.id && p.b === B.id) || (p.a === B.id && p.b === A.id)));
        if (already) continue;
        // Never propose fusing distinct given names via aliases either.
        const ta = tokens(na);
        const tb = tokens(nb);
        if (ta.length > 1 && tb.length > 1 && ta[0] !== tb[0]) continue;
        push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'same-person', evidence: 'alias linkage across roster rows', confidence: 0.45 });
      }
    }

    // --- the masked-identity case: find both ends by name ---
    const findBy = (want: string): Entity | undefined => entities.find((e) => fold(e.name) === want);
    const chancellor = findBy('palpatine');
    const lord = entities.find((e) => fold(e.name).includes('sidious'));
    if (chancellor && lord) {
      push({
        a: chancellor.id, b: lord.id, nameA: chancellor.name, nameB: lord.name, kind: 'same-person',
        evidence: 'masked-identity case: the public office-holder and the Sith persona resolve to one man in-text; confirm against the reveal before merging',
        confidence: 0.6,
      });
    }

    // --- skipped auto-merges return as manual-confirm proposals ---
    // (upgrade, not duplicate: if the pair already has a same-person row,
    // rewrite it with the UC-block note).
    if (existsSync(`${TRACK}/skipped.csv`)) {
      for (const line of readFileSync(`${TRACK}/skipped.csv`, 'utf8').split('\n').slice(1)) {
        if (!line.trim()) continue;
        const cells = line.split(',');
        const lid = Number(cells[0]);
        const sid = Number(cells[2]);
        const A = byId.get(lid);
        const B = byId.get(sid);
        if (!A || !B) continue; // ids pre-merge; both rows still exist (skip = no-op)
        const prior = out.find((p) => p.kind === 'same-person' && ((p.a === A.id && p.b === B.id) || (p.a === B.id && p.b === A.id)));
        if (prior) {
          prior.evidence = 'mechanically certain but blocked: user_confirmed rows at stake; confirm manually';
          prior.confidence = 0.55;
        } else {
          push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'same-person', evidence: 'mechanically certain but blocked: user_confirmed rows at stake; confirm manually', confidence: 0.55 });
        }
      }
    }

    // --- guard: the required keep-apart pairs must all be present ---
    const mustKeep = [
      ['larsh hill', 'san hill'],
      ['palpatine', 'cosinga palpatine'],
      ['ranulph tarkin', 'wilhuff tarkin'],
      ['pax teem', 'ainlee teem'],
      ['diva shaliqua', 'diva funquita'],
      ['jabba the hutt', 'gardulla the hutt'],
      ['ian lago', 'kun lago'],
    ] as [string, string][];
    const byFold = new Map(entities.map((e) => [fold(e.name), e]));
    for (const [fa, fb] of mustKeep) {
      const A = [...byFold.entries()].find(([k]) => k.includes(fa))?.[1];
      const B = [...byFold.entries()].find(([k]) => k.includes(fb))?.[1];
      if (!A || !B) {
        console.log(`propose guard: pair not found for ${fa} / ${fb}`);
        continue;
      }
      const present = out.some((p) => p.kind === 'different-people-keep' && ((p.a === A.id && p.b === B.id) || (p.a === B.id && p.b === A.id)));
      if (!present) {
        push({ a: A.id, b: B.id, nameA: A.name, nameB: B.name, kind: 'different-people-keep', evidence: 'required keep-apart pair (surname/given collision)', confidence: 0.3 });
      }
    }

    out.sort((x, y) => x.confidence - y.confidence || x.kind.localeCompare(y.kind));
    const lines = ['entity_a,entity_b,name_a,name_b,kind,evidence,confidence'];
    for (const p of out) lines.push([p.a, p.b, csvCell(p.nameA), csvCell(p.nameB), p.kind, csvCell(p.evidence), p.confidence].join(','));
    writeFileSync(`${TRACK}/review.csv`, lines.join('\n') + '\n');
    const kinds: Record<string, number> = {};
    for (const p of out) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    console.log(`propose: ${out.length} rows ${JSON.stringify(kinds)}`);
    return out;
  } finally {
    db.close();
  }
}

/** Coverage after-state incl. non-person-excluded denominators (reads review.csv). */export function cover(): Record<string, unknown> {
  const db = new DatabaseSync(COPY, { readOnly: true });
  try {
    const after = coverageOn(db);
    const cov = JSON.parse(readFileSync(`${TRACK}/coverage.json`, 'utf8')) as {
      before: { chars: number; proofRows: number; tied: number };
      after: { chars: number; proofRows: number; tied: number };
      selfLoopsRemoved: number;
      userConfirmedBefore: number;
      userConfirmedAfter: number;
    };
    // Non-person ids from the review file (single-entity non-person rows).
    const review = readFileSync(`${TRACK}/review.csv`, 'utf8').split('\n').slice(1).filter(Boolean);
    const nonPersonIds = new Set<number>();
    for (const line of review) {
      const parts = line.split(',');
      if (parts[4] === 'non-person' || parts[4] === 'placeholder') nonPersonIds.add(Number(parts[0]));
    }
    const tiedSet = new Set<number>();
    const proofRows = db
      .prepare(`SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ? AND review_status IN (${PROOF.map(() => '?').join(',')})`)
      .all(PROJECT, ...PROOF) as { from_entity: number; to_entity: number }[];
    for (const r of proofRows) {
      tiedSet.add(r.from_entity);
      tiedSet.add(r.to_entity);
    }
    let tiedPersons = 0;
    for (const id of tiedSet) if (!nonPersonIds.has(id)) tiedPersons++;
    const denomPersons = after.chars - nonPersonIds.size;
    // Before persons-only, computed on the pristine timestamped backup
    // (same id space; merged losers were all person-rows, still present).
    const backupFile = readdirSync(TRACK).find((f) => f.startsWith('backup-halfbook-') && f.endsWith('.db'));
    if (!backupFile) fail('no timestamped backup found');
    const bdb = new DatabaseSync(`${TRACK}/${backupFile}`, { readOnly: true });
    let tiedPersonsBefore = 0;
    let charsBefore = 0;
    try {
      charsBefore = (bdb.prepare('SELECT count(*) c FROM canon_entity WHERE project_id = ? AND kind = ?').get(PROJECT, 'character') as { c: number }).c;
      const bproof = bdb
        .prepare(`SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ? AND review_status IN (${PROOF.map(() => '?').join(',')})`)
        .all(PROJECT, ...PROOF) as { from_entity: number; to_entity: number }[];
      const bset = new Set<number>();
      for (const r of bproof) {
        bset.add(r.from_entity);
        bset.add(r.to_entity);
      }
      for (const id of bset) if (!nonPersonIds.has(id)) tiedPersonsBefore++;
    } finally {
      bdb.close();
    }
    const denomBefore = charsBefore - nonPersonIds.size;
    const out = {
      before: cov.before,
      mechanical: { after: cov.after, selfLoopsRemoved: cov.selfLoopsRemoved, relFolded: cov.relFolded, tieFolded: cov.tieFolded, threadFolded: cov.threadFolded, userConfirmedBefore: cov.userConfirmedBefore, userConfirmedAfter: cov.userConfirmedAfter },
      current: { chars: after.chars, proofRows: after.proofRows, tied: after.tied, coverage: after.chars ? Number((after.tied / after.chars).toFixed(3)) : 0 },
      beforePersonsOnly: {
        chars: denomBefore,
        tied: tiedPersonsBefore,
        coverage: denomBefore ? Number((tiedPersonsBefore / denomBefore).toFixed(3)) : 0,
      },
      nonPersonLabels: nonPersonIds.size,
    };
    writeFileSync(`${TRACK}/coverage.json`, JSON.stringify(out, null, 1));
    console.log(`cover: before ${cov.before.tied}/${cov.before.chars} current ${after.tied}/${after.chars} rows=${after.proofRows} before-persons-only ${tiedPersonsBefore}/${denomBefore}`);
    return out;
  } finally {
    db.close();
  }
}

export function verify(): Record<string, unknown> {
  // Live proof first: byte-identical.
  const manifest = JSON.parse(readFileSync(`${TRACK}/manifest.json`, 'utf8')) as { liveSha: string; liveSize: number };
  const liveSha = sha256(LIVE);
  const liveSize = readFileSync(LIVE).length;
  const liveOk = liveSha === manifest.liveSha && liveSize === manifest.liveSize;

  const db = new DatabaseSync(COPY);
  try {
    const charIds = new Set(
      (db.prepare('SELECT id FROM canon_entity WHERE project_id = ?').all(PROJECT) as { id: number }[]).map((r) => r.id),
    );
    const orphans = db
      .prepare('SELECT id, from_entity, to_entity FROM canon_relation WHERE project_id = ?')
      .all(PROJECT) as { id: number; from_entity: number; to_entity: number }[];
    let orphanRows = 0;
    for (const r of orphans) {
      if (!charIds.has(r.from_entity) || !charIds.has(r.to_entity)) orphanRows++;
    }
    const selfLoops = (db.prepare('SELECT count(*) c FROM canon_relation WHERE project_id = ? AND from_entity = to_entity').get(PROJECT) as { c: number }).c;
    // Family-surname fusion check: re-examine every applied merge from the
    // pre-merge roster names — flag any row where the two sides carry
    // different given names (multi-token both sides, first tokens differ) or
    // a bare surname fused onto a fuller name with another given name.
    const splitCsv = (line: string): string[] => {
      const cells: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quoted) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
          } else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { cells.push(cur); cur = ''; }
        else cur += ch;
      }
      cells.push(cur);
      return cells;
    };
    const rosterName = new Map<number, string>();
    const rosterAliases = new Map<number, string[]>();
    for (const line of readFileSync(`${TRACK}/roster.csv`, 'utf8').split('\n').slice(1)) {
      if (!line.trim()) continue;
      const cells = splitCsv(line);
      rosterName.set(Number(cells[0]), cells[1] ?? '');
      try {
        const p = JSON.parse(cells[2] || '[]') as unknown;
        rosterAliases.set(Number(cells[0]), Array.isArray(p) ? p.map(String) : []);
      } catch {
        rosterAliases.set(Number(cells[0]), []);
      }
    }
    let fusedDistinct = 0;
    const fusedPairs: string[] = [];
    const stripTitles = (toks: string[]): string[] => {
      let t = [...toks];
      for (;;) {
        let cut = false;
        for (const title of [...TITLES].sort((x, y) => y.length - x.length)) {
          const wt = title.split(' ');
          if (wt.every((w, k) => t[k] === w)) {
            t = t.slice(wt.length);
            cut = true;
            break;
          }
        }
        if (!cut) break;
      }
      return t;
    };
    for (const line of readFileSync(`${TRACK}/merges.csv`, 'utf8').split('\n').slice(1)) {
      if (!line.trim()) continue;
      const cells = splitCsv(line);
      const loserId = Number(cells[0]);
      const survId = Number(cells[2]);
      const ln = stripTitles(tokens(fold(rosterName.get(loserId) ?? '')));
      const sn = stripTitles(tokens(fold(rosterName.get(survId) ?? '')));
      // Alias-identity: one side's stripped full name is claimed as an alias
      // by the other side (the rule-a/c basis) — not a fusion.
      const lAliases = (rosterAliases.get(loserId) ?? []).map((a) => stripTitles(tokens(fold(a))).join(' '));
      const sAliases = (rosterAliases.get(survId) ?? []).map((a) => stripTitles(tokens(fold(a))).join(' '));
      const aliasIdentity = lAliases.includes(sn.join(' ')) || sAliases.includes(ln.join(' '));
      let fused = false;
      if (ln.join(' ') === sn.join(' ')) {
        fused = false; // same stripped identity: title-form merge, sanctioned
      } else if (aliasIdentity) {
        fused = false; // alias-claimed identity, sanctioned
      } else if (ln.length > 1 && sn.length > 1 && ln[0] !== sn[0]) {
        fused = true; // distinct given names fused
      } else if (ln.length === 1 && sn.length > 1) {
        fused = true; // bare surname absorbed into a fuller distinct name
      } else if (sn.length === 1 && ln.length > 1) {
        fused = true;
      } else {
        fused = true;
      }
      if (fused) {
        fusedDistinct++;
        fusedPairs.push(`${loserId}->${survId}`);
      }
    }
    const out = { liveByteIdentical: liveOk, liveSha: liveSha.slice(0, 12), orphanRelationRows: orphanRows, selfRelations: selfLoops, fusedDistinctPersons: fusedDistinct, fusedPairs };
    writeFileSync(`${TRACK}/verify.json`, JSON.stringify(out, null, 1));
    console.log(`verify: liveIdentical=${liveOk} orphans=${orphanRows} selfLoops=${selfLoops} fused=${fusedDistinct}`);
    if (!liveOk) fail('live bank changed');
    if (orphanRows !== 0) fail(`${orphanRows} orphan relation rows`);
    if (selfLoops !== 0) fail(`${selfLoops} self-relations remain`);
    if (fusedDistinct !== 0) fail(`${fusedDistinct} fused distinct persons: ${fusedPairs.join(' ')}`);
    return out;
  } finally {
    db.close();
  }
}

/**
 * Textual identity merges, user-authorised on textual evidence (not
 * mechanical rules). Each requires its establishing sentence to be present
 * in the copy's chunks; otherwise it refuses. UC rows are re-pointed but
 * never content-modified; UC-vs-UC collisions keep the lower id with the
 * dropped row logged in full.
 */
const TEXT_MERGES: { loser: string; survivor: string; chunk: number; sentence: string }[] = [
  {
    loser: 'Damask',
    survivor: 'Darth Plagueis',
    chunk: 176,
    sentence: 'where Hego Damask—as Plagueis was known to everyone but the late Darth Tenebrous—and 11-4D were waiting',
  },
  {
    loser: 'Palpatine',
    survivor: 'Darth Sidious',
    chunk: 1190,
    sentence: 'Unlike Darth Sidious, who masqueraded as Republic Senator Palpatine and debated complex issues in the Senate, Maul lacked a secret identity',
  },
  {
    loser: 'Senator Palpatine',
    survivor: 'Darth Sidious',
    chunk: 1190,
    sentence: 'Unlike Darth Sidious, who masqueraded as Republic Senator Palpatine and debated complex issues in the Senate, Maul lacked a secret identity',
  },
];

function entityIdByName(db: DatabaseSync, name: string): number {
  const row = db.prepare('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?').get(PROJECT, name) as { id: number } | undefined;
  if (!row) fail(`textmerge: entity missing: ${name}`);
  return row.id;
}

export function textmerge(): Record<string, unknown> {
  const db = new DatabaseSync(COPY);
  try {
    const applied: { loser: number; loserName: string; survivor: number; survivorName: string }[] = [];
    for (const t of TEXT_MERGES) {
      const chunk = db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(t.chunk) as { text: string } | undefined;
      if (!chunk || !String(chunk.text).includes(t.sentence)) {
        console.log(`textmerge: REFUSED ${t.loser} -> ${t.survivor} (establishing sentence not in chunk ${t.chunk})`);
        continue;
      }
      const loser = entityIdByName(db, t.loser);
      const survivor = entityIdByName(db, t.survivor);
      if (loser === survivor) continue;
      let relFolded = 0;
      let tieFolded = 0;
      let threadFolded = 0;
      relFolded += repointRelationColumn(db, 'from_entity', loser, survivor);
      relFolded += repointRelationColumn(db, 'to_entity', loser, survivor);
      tieFolded += repointTieColumn(db, 'from_entity', loser, survivor);
      tieFolded += repointTieColumn(db, 'to_entity', loser, survivor);
      db.prepare('UPDATE canon_fact SET subject_entity_id = ? WHERE subject_entity_id = ?').run(survivor, loser);
      db.prepare('UPDATE canon_event_participant SET entity_id = ? WHERE entity_id = ?').run(survivor, loser);
      threadFolded += repointThreadColumn(db, 'a_entity', loser, survivor);
      threadFolded += repointThreadColumn(db, 'b_entity', loser, survivor);
      db.prepare('UPDATE character SET canon_entity_id = ? WHERE canon_entity_id = ?').run(survivor, loser);
      // Fold loser name + aliases into survivor; UC self-loops impossible to
      // leave: any self-loop on the survivor is removed and logged.
      const s = db.prepare('SELECT aliases, mentions FROM canon_entity WHERE id = ?').get(survivor) as { aliases: string; mentions: number };
      const l = db.prepare('SELECT name, aliases, mentions, review_status FROM canon_entity WHERE id = ?').get(loser) as { name: string; aliases: string; mentions: number; review_status: string };
      let sAliases: string[] = [];
      let lAliases: string[] = [];
      try { sAliases = JSON.parse(s.aliases || '[]') as string[]; } catch { sAliases = []; }
      try { lAliases = JSON.parse(l.aliases || '[]') as string[]; } catch { lAliases = []; }
      const sName = (db.prepare('SELECT name FROM canon_entity WHERE id = ?').get(survivor) as { name: string }).name;
      const aliasSet = new Set([...sAliases, l.name, ...lAliases].filter((a) => fold(a) !== fold(sName)));
      db.prepare('UPDATE canon_entity SET aliases = ?, mentions = ? WHERE id = ?').run(JSON.stringify([...aliasSet]), s.mentions + l.mentions, survivor);
      if (l.review_status === 'needs_review') db.prepare("UPDATE canon_entity SET review_status = 'needs_review' WHERE id = ?").run(survivor);
      db.prepare('DELETE FROM canon_entity WHERE id = ?').run(loser);
      const loops = db.prepare('SELECT * FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ?').all(PROJECT, survivor, survivor) as AnyRow[];
      for (const loop of loops) {
        logDropped('textmerge-selfloop', loop);
        db.prepare('DELETE FROM canon_relation WHERE id = ?').run(loop.id);
      }
      applied.push({ loser, loserName: t.loser, survivor, survivorName: t.survivor });
      console.log(`textmerge: ${t.loser} -> ${t.survivor} relFolded=${relFolded} tieFolded=${tieFolded} threadFolded=${threadFolded} selfLoops=${loops.length}`);
    }
    const ucAfter = (db.prepare("SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status = 'user_confirmed'").get(PROJECT) as { c: number }).c;
    const lines = ['# Merge log (Stage A + textual identities)', ''];
    lines.push(`textual merges applied: ${applied.length}/${TEXT_MERGES.length}; user_confirmed rows now ${ucAfter}`);
    for (const t of TEXT_MERGES) {
      const done = applied.some((a) => a.loserName === t.loser);
      lines.push(`- ${done ? 'APPLIED' : 'REFUSED'}: ${t.loser} -> ${t.survivor} (chunk ${t.chunk}): "${t.sentence}"`);
    }
    lines.push('', '## Dropped / folded rows (mechanical + textual)');
    if (existsSync(`${TRACK}/dropped-mechanical.md`)) {
      lines.push('', '### Mechanical merges');
      lines.push(readFileSync(`${TRACK}/dropped-mechanical.md`, 'utf8').trimEnd());
      lines.push('', '### Textual merges');
    }
    for (const d of droppedLog) lines.push(`- ${d}`);
    writeFileSync(`${TRACK}/merge-log.md`, lines.join('\n') + '\n');
    // Mechanical merges table appended for one log.
    const mech = existsSync(`${TRACK}/merges.csv`) ? readFileSync(`${TRACK}/merges.csv`, 'utf8').split('\n').slice(1).filter(Boolean) : [];
    console.log(`textmerge: applied ${applied.length}, mechanical ${mech.length}, dropped-logged ${droppedLog.length}, uc=${ucAfter}`);
    return { applied: applied.length, mechanical: mech.length, dropped: droppedLog.length, userConfirmed: ucAfter };
  } finally {
    db.close();
  }
}

/**
 * Re-kind non-persons by changing `kind` (never deleting rows): species
 * and peoples -> 'group', organisations -> 'organisation', places ->
 * 'place', generic roles -> 'role', placeholders -> 'unknown'.
 * Labels come from review.csv evidence prefixes. Relations stay attached.
 * "Plagueis' father" stays a character: the text identifies him as a
 * distinct person (chunk 298: Caar Damask, clan father, administrator).
 */
export function rekind(): Record<string, number> {
  const db = new DatabaseSync(COPY);
  try {
    const review = readFileSync(`${TRACK}/review.csv`, 'utf8').split('\n').slice(1).filter(Boolean);
    const counts: Record<string, number> = { group: 0, organisation: 0, place: 0, role: 0, unknown: 0 };
    const kept: string[] = [];
    for (const line of review) {
      const cells = line.split(',');
      const kind = cells[4];
      if (kind !== 'non-person' && kind !== 'placeholder') continue;
      const id = Number(cells[0]);
      const ev = (cells[5] ?? '').replace(/^"/, '');
      const row = db.prepare('SELECT name FROM canon_entity WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) continue;
      if (fold(row.name) === "plagueis' father") {
        kept.push(`${id} ${row.name} stays character: text identifies Caar Damask, clan father and administrator (chunk 298)`);
        continue;
      }
      let to = '';
      if (kind === 'placeholder') to = 'unknown';
      else if (ev.startsWith('species-form') || ev.startsWith('people-form')) to = 'group';
      else if (ev.startsWith('organisation-form')) to = 'organisation';
      else if (ev.startsWith('place name')) to = 'place';
      else to = 'role';
      db.prepare('UPDATE canon_entity SET kind = ? WHERE id = ?').run(to, id);
      counts[to] = (counts[to] ?? 0) + 1;
    }
    writeFileSync(`${TRACK}/rekind.json`, JSON.stringify({ counts, kept }, null, 1));
    console.log(`rekind: ${JSON.stringify(counts)} kept=${kept.length}`);
    return counts;
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('rebuild.ts')) {
  const step = process.argv[2] ?? 'all';
  try {
    if (step === 'backup' || step === 'all') backup();
    if (step === 'roster' || step === 'all') roster();
    if (step === 'merge' || step === 'all') merge();
    if (step === 'propose' || step === 'all') propose();
    if (step === 'cover' || step === 'all') cover();
    if (step === 'textmerge' || step === 'all') textmerge();
    if (step === 'rekind' || step === 'all') rekind();
    if (step === 'verify' || step === 'all') verify();
    if (!['backup', 'roster', 'merge', 'propose', 'cover', 'textmerge', 'rekind', 'verify', 'all'].includes(step)) {
      console.error('rebuild: use backup|roster|merge|propose|cover|textmerge|rekind|verify|all');
      process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
