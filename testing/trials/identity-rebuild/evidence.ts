/**
 * Stage B of the rebuild: evidence regather, direction, families, status.
 *
 * Trial-only, copy-first. Steps (from the repo root):
 *   node --experimental-strip-types testing/trials/identity-rebuild/evidence.ts [cands|score|apply|verify|all]
 *
 * cands: per relation, every chunk with a sentence naming BOTH endpoints
 *   (full alias sets incl. merged aliases, case-insensitive token
 *   boundaries, surname-only when claimed by <=1 entity). First matching
 *   sentence per chunk. Writes evidence-work.json (gitignored).
 * score: one Ollama call per candidate (spark-x2-q8: the prescribed
 *   Spark-X2.6-4B-Q8 is not in the registry — disclosed fallback), temp 0,
 *   seed 42, think false, JSON {score, direction, family}. Resumable via
 *   scores.jsonl. Refuses when a foreign model is resident.
 * apply: best candidate wins. Winners store sentence + chunk; below 0.7 or
 *   no candidate -> needs_review (no-passage/below-bar, reason appended to
 *   supporting_evidence as {regather}). Direction flips from the passage
 *   (asymmetric families only), kind-less rows take the canonical family
 *   label, unsupported families -> needs_review (kind-unsupported),
 *   proof rows at non-character endpoints -> needs_review
 *   (noncharacter-endpoint). relation_status backfilled from cue words.
 * verify: live-apply gate (orphans, self-loops, both-endpoints evidence on
 *   every proof row, no proof row at a non-character, status non-null).
 *
 * Writes only under testing/trials/identity-rebuild/ (gitignored).
 * Reports print counts only, never passage prose or names.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/identity-rebuild';
const COPY = `${TRACK}/copy.db`;
const PROJECT = 1;
const PROOF = ['accepted', 'attested', 'user_confirmed'];
const MODEL = 'spark-x2-q8';
const OLLAMA = 'http://127.0.0.1:11434';
const BAR = 0.7;
const LANES = 3;

function fail(message: string): never {
  throw new Error(`evidence: ${message}`);
}

const fold = (s: string): string =>
  String(s ?? '').normalize('NFKC').replace(/[‘’‚‛`´]/g, "'").replace(/[“”„]/g, '"').toLowerCase();
const escRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toksOf = (s: string): string[] => fold(s).split(/[^a-z0-9']+/).filter((t) => t.length > 2);

/** The 12 families: canonical label, inverse, match keywords over bank kinds. */
export const FAMILIES: { family: string; canonical: string; inverse: string; keys: string[] }[] = [
  { family: 'parent', canonical: 'parent_of', inverse: 'child_of', keys: ['father of', 'mother of', 'parent of', 'son of', 'father', 'mother', 'parent'] },
  { family: 'child', canonical: 'child_of', inverse: 'parent_of', keys: ['son of', 'daughter of', 'child of', 'born to', 'clan', 'family'] },
  { family: 'master', canonical: 'master_of', inverse: 'apprentice_of', keys: ['master', 'mentor', 'teacher', 'trainer', 'padawan', 'apprentice', 'sith apprentice', 'student', 'disciple', 'trained', 'shepherd', 'guide'] },
  { family: 'ally', canonical: 'ally_of', inverse: 'ally_of', keys: ['ally', 'friend', 'partner', 'acquaintance', 'peer', 'contact', 'meeting', 'met with', 'collaborator', 'associate', 'appears_with', 'interacted', 'communicating', 'contacting', 'congratulating', 'introduced', 'invited', 'linked', 'relationship', 'concerned about'] },
  { family: 'enemy', canonical: 'enemy_of', inverse: 'enemy_of', keys: ['enemy', 'opponent', 'rival', 'suspected enemy', 'threatened', 'hated', 'choked', 'murderer', 'killer', 'skeptic', 'denigrated', 'criticized', 'challenged', 'competes', 'tricked', 'saboteur', 'liability', 'estranged', 'affected by', 'refuses'] },
  { family: 'member', canonical: 'member_of', inverse: 'member_of', keys: ['member', 'inhabitant', 'resident', 'crew member'] },
  { family: 'servant', canonical: 'servant_of', inverse: 'servant_of', keys: ['servant', 'serves', 'aide', 'assistant', 'apprentice to', 'follower', 'hired', 'informant', 'lobbyist', 'valued', 'appreciates', 'acknowledged', 'acknowledges', 'approved', 'sanctions', 'promotes', 'appointed ambassador', 'receives orders'] },
  { family: 'spouse', canonical: 'spouse_of', inverse: 'spouse_of', keys: ['married', 'spouse', 'lover', 'partner of'] },
  { family: 'sibling', canonical: 'sibling_of', inverse: 'sibling_of', keys: ['sibling', 'brother', 'sister'] },
  { family: 'debtor', canonical: 'debtor_of', inverse: 'creditor_of', keys: ['debtor', 'creditor', 'beneficiary', 'gifted'] },
  { family: 'employer', canonical: 'employer_of', inverse: 'employee_of', keys: ['employer', 'employee', 'leader', 'governs', 'governed', 'captain of', 'brokered', 'dictates'] },
  { family: 'located', canonical: 'located_in', inverse: 'located_in', keys: ['resident of', 'inhabitant of', 'homeworld', 'located', 'guest of'] },
];
const OTHER = 'other';
const VOCAB = [...FAMILIES.map((f) => f.family), OTHER];
const ASYMMETRIC = new Set(['parent', 'child', 'master', 'debtor', 'employer', 'located']);

export function familyOfKind(kind: string): string {
  const k = fold(kind).trim();
  if (!k) return '';
  for (const f of FAMILIES) {
    if (f.keys.some((key) => k.includes(key))) return f.family;
  }
  return OTHER;
}

export function statusOfPassage(sentence: string): 'current' | 'past' | 'suspected' {
  const s = fold(sentence);
  if (/\b(suspect|suspected|suspicion|believe|believed|rumou?r|appears? to|seems? to|seemed to|alleged|reportedly|may have|might have|possibly|perhaps|could be)\b/.test(s)) return 'suspected';
  if (/\b(was|were|had been|has been|former|formerly|used to|once|previously|no longer|when he was|when she was|as a child|in his youth|old)\b/.test(s)) return 'past';
  return 'current';
}

interface Cand { chunk: number; locator: string; sentence: string }
interface Scored extends Cand { score: number; direction: string; family: string }

function loadEntities(db: DatabaseSync): { id: number; name: string; aliases: string[] }[] {
  const rows = db.prepare('SELECT id, name, aliases FROM canon_entity WHERE project_id = ?').all(PROJECT) as { id: number; name: string; aliases: string }[];
  return rows.map((r) => {
    let aliases: string[] = [];
    try {
      const p = JSON.parse(r.aliases || '[]') as unknown;
      if (Array.isArray(p)) aliases = p.map(String);
    } catch { aliases = []; }
    return { id: r.id, name: r.name, aliases };
  });
}

export function cands(): Record<string, number> {
  const db = new DatabaseSync(COPY, { readOnly: true });
  try {
    const entities = loadEntities(db);
    const claimCount = new Map<string, number>();
    for (const e of entities) {
      const set = new Set([...toksOf(e.name), ...e.aliases.flatMap((a) => toksOf(a))]);
      for (const t of set) claimCount.set(t, (claimCount.get(t) ?? 0) + 1);
    }
    const formsFor = (e: { name: string; aliases: string[] }): RegExp[] => {
      const forms = new Set([fold(e.name), ...e.aliases.map(fold)].filter((f) => f && f.length > 2));
      const toks = toksOf(e.name);
      const sur = toks[toks.length - 1];
      if (sur && (claimCount.get(sur) ?? 0) <= 1) forms.add(sur);
      return [...forms].map((f) => new RegExp(`\\b${escRx(f)}\\b`));
    };
    const formCache = new Map(entities.map((e) => [e.id, formsFor(e)]));
    const chunks = db.prepare('SELECT id, locator, text FROM canon_chunk WHERE project_id = ?').all(PROJECT) as { id: number; locator: string; text: string }[];
    const rels = db.prepare('SELECT id, from_entity, to_entity FROM canon_relation WHERE project_id = ?').all(PROJECT) as { id: number; from_entity: number; to_entity: number }[];
    const work: Record<number, Cand[]> = {};
    let zero = 0;
    let total = 0;
    for (const r of rels) {
      const fa = formCache.get(r.from_entity);
      const fb = formCache.get(r.to_entity);
      if (!fa || !fb) {
        work[r.id] = [];
        zero++;
        continue;
      }
      const list: Cand[] = [];
      for (const c of chunks) {
        const sents = String(c.text).split(/(?<=[.!?])\s+/);
        const hit = sents.find((s) => {
          const f = fold(s);
          return fa.some((rx) => rx.test(f)) && fb.some((rx) => rx.test(f));
        });
        if (hit) list.push({ chunk: c.id, locator: c.locator, sentence: hit.trim().slice(0, 600) });
      }
      work[r.id] = list;
      total += list.length;
      if (!list.length) zero++;
    }
    writeFileSync(`${TRACK}/evidence-work.json`, JSON.stringify(work));
    console.log(`cands: relations ${rels.length} zero=${zero} candidates=${total}`);
    return { relations: rels.length, zero, candidates: total };
  } finally {
    db.close();
  }
}

function parseScore(raw: string): { score: number; direction: string; family: string } | null {
  const blocks = raw.match(/\{[^{}]*\}/g) ?? [];
  const greedy = raw.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) blocks.push(greedy);
  for (const block of blocks) {
    try {
      const o = JSON.parse(block) as { score?: unknown; direction?: unknown; family?: unknown };
      const score = Number(o.score);
      if (!Number.isFinite(score)) continue;
      const direction = String(o.direction ?? 'absent').toLowerCase();
      const family = String(o.family ?? OTHER).toLowerCase();
      return {
        score: Math.max(0, Math.min(1, score)),
        direction: ['as-stated', 'flipped', 'absent'].includes(direction) ? direction : 'absent',
        family: (VOCAB as string[]).includes(family) ? family : OTHER,
      };
    } catch { /* next */ }
  }
  return null;
}

async function scoreOne(aName: string, kind: string, bName: string, sentence: string): Promise<{ score: number; direction: string; family: string; unparsable: boolean }> {
  const kindPhrase = kind.trim() ? `"${kind.trim()}"` : 'connected to';
  const prompt =
    `Passage: "${sentence}"\n` +
    `Question: does this passage state that ${aName} ${kindPhrase} ${bName}? ` +
    `The subject must be ${aName}; if the passage states the reverse (subject ${bName}), say flipped. ` +
    `Reply with JSON only: {"score": <0-1 how strongly the passage states it>, "direction": "as-stated" | "flipped" | "absent", "family": one of parent|child|master|ally|enemy|member|servant|spouse|sibling|debtor|employer|located|other}.`;
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', think: false, options: { temperature: 0, seed: 42 } }),
  });
  if (!res.ok) fail(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const parsed = parseScore((data.message?.content ?? '').trim());
  if (!parsed) return { score: 0, direction: 'absent', family: OTHER, unparsable: true };
  return { ...parsed, unparsable: false };
}

function ollamaPs(): string {
  const ps = spawnSync('ollama', ['ps'], { encoding: 'utf8' });
  return String(ps.stdout ?? '');
}

export async function score(): Promise<void> {
  const rows = ollamaPs().split('\n').slice(1).filter((l) => l.trim());
  const foreign = rows.filter((l) => !l.startsWith(MODEL));
  if (foreign.length) fail(`non-judge model resident (${foreign.length} row(s)) — unload first`);
  const tags = await fetch(`${OLLAMA}/api/tags`);
  if (!tags.ok) fail(`ollama tags ${tags.status}`);
  if (!existsSync(`${TRACK}/evidence-work.json`)) fail('no evidence-work.json (run cands first)');
  const work = JSON.parse(readFileSync(`${TRACK}/evidence-work.json`, 'utf8')) as Record<number, Cand[]>;
  const db = new DatabaseSync(COPY, { readOnly: true });
  let names: Map<number, string>;
  let kinds: Map<number, string>;
  try {
    const rels = db.prepare('SELECT id, from_entity, to_entity, kind FROM canon_relation WHERE project_id = ?').all(PROJECT) as { id: number; from_entity: number; to_entity: number; kind: string }[];
    const ents = new Map(loadEntities(db).map((e) => [e.id, e.name]));
    names = new Map(rels.map((r) => [r.id, `${ents.get(r.from_entity) ?? '?'}|${ents.get(r.to_entity) ?? '?'}`]));
    kinds = new Map(rels.map((r) => [r.id, r.kind]));
    void names;
    // Flatten tasks, skipping already-scored (rel:chunk) pairs.
    const done = new Set<string>();
    if (existsSync(`${TRACK}/scores.jsonl`)) {
      for (const line of readFileSync(`${TRACK}/scores.jsonl`, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { rel: number; chunk: number };
          done.add(`${o.rel}:${o.chunk}`);
        } catch { /* skip */ }
      }
    }
    type Task = { rel: number; cand: Cand; a: string; b: string; kind: string };
    const tasks: Task[] = [];
    for (const [relS, list] of Object.entries(work)) {
      const rel = Number(relS);
      const [a, b] = String(names.get(rel) ?? '?|?').split('|') as [string, string];
      const kind = kinds.get(rel) ?? '';
      for (const cand of list) {
        if (!done.has(`${rel}:${cand.chunk}`)) tasks.push({ rel, cand, a, b, kind });
      }
    }
    console.log(`score: ${tasks.length} calls pending (${done.size} already scored), ${LANES} lanes, model ${MODEL}`);
    const t0 = Date.now();
    let finished = 0;
    let unparsable = 0;
    const worker = async (lane: Task[]): Promise<void> => {
      for (const t of lane) {
        try {
          const r = await scoreOne(t.a, t.kind, t.b, t.cand.sentence);
          if (r.unparsable) unparsable++;
          appendFileSync(`${TRACK}/scores.jsonl`, JSON.stringify({ rel: t.rel, chunk: t.cand.chunk, locator: t.cand.locator, sentence: t.cand.sentence, ...r }) + '\n');
        } catch (err) {
          appendFileSync(`${TRACK}/scores.jsonl`, JSON.stringify({ rel: t.rel, chunk: t.cand.chunk, locator: t.cand.locator, sentence: t.cand.sentence, score: 0, direction: 'absent', family: OTHER, error: (err as Error).message }) + '\n');
        }
        finished++;
        if (finished % 200 === 0 || finished === tasks.length) {
          const el = (Date.now() - t0) / 1000;
          console.log(`score: ${finished}/${tasks.length} ${(finished / Math.max(1, el)).toFixed(1)}/s unparsable=${unparsable}`);
        }
      }
    };
    const lanes: Task[][] = Array.from({ length: LANES }, () => []);
    tasks.forEach((t, i) => lanes[i % LANES]!.push(t));
    await Promise.all(lanes.map(worker));
    console.log(`score: done ${finished} calls unparsable=${unparsable}`);
  } finally {
    db.close();
  }
}

function appendRegather(supporting: string, reason: string, best: number): string {
  try {
    const arr = JSON.parse(supporting || '[]') as unknown[];
    if (!Array.isArray(arr)) return supporting;
    arr.push({ regather: { reason, best, at: new Date().toISOString().slice(0, 10) } });
    return JSON.stringify(arr);
  } catch {
    return supporting;
  }
}

export function applyEvidence(): Record<string, number> {
  const db = new DatabaseSync(COPY);
  try {
    // Completeness guard: every candidate in evidence-work.json must have a
    // score. Otherwise unscored relations would be mislabelled no-passage.
    if (!existsSync(`${TRACK}/evidence-work.json`)) fail('no evidence-work.json');
    const work = JSON.parse(readFileSync(`${TRACK}/evidence-work.json`, 'utf8')) as Record<number, { chunk: number }[]>;
    let expected = 0;
    for (const list of Object.values(work)) expected += list.length;
    const have = new Set<string>();
    if (existsSync(`${TRACK}/scores.jsonl`)) {
      for (const line of readFileSync(`${TRACK}/scores.jsonl`, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { rel: number; chunk: number };
          have.add(`${o.rel}:${o.chunk}`);
        } catch { /* skip */ }
      }
    }
    let missing = 0;
    for (const [rel, list] of Object.entries(work)) {
      for (const c of list) if (!have.has(`${rel}:${c.chunk}`)) missing++;
    }
    if (missing > 0) fail(`scores incomplete: ${missing}/${expected} candidate calls missing — finish scoring first`);
    // Additive status column (does not touch existing columns or modality).
    const cols = db.prepare('PRAGMA table_info(canon_relation)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'relation_status')) {
      db.prepare("ALTER TABLE canon_relation ADD COLUMN relation_status TEXT DEFAULT 'unknown'").run();
    }
    const scores = new Map<number, Scored[]>();
    if (existsSync(`${TRACK}/scores.jsonl`)) {
      for (const line of readFileSync(`${TRACK}/scores.jsonl`, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Scored & { rel: number };
          if (!scores.has(o.rel)) scores.set(o.rel, []);
          scores.get(o.rel)!.push(o);
        } catch { /* skip */ }
      }
    }
    const rels = db.prepare('SELECT * FROM canon_relation WHERE project_id = ?').all(PROJECT) as AnyRow[];
    const kindOf = new Map(loadEntities(db).map((e) => [e.id, '']));
    void kindOf;
    const entKind = new Map((db.prepare('SELECT id, kind FROM canon_entity WHERE project_id = ?').all(PROJECT) as { id: number; kind: string }[]).map((r) => [r.id, r.kind]));
    const counts: Record<string, number> = { winners: 0, noPassage: 0, belowBar: 0, kindUnsupported: 0, noncharacterEndpoint: 0, flips: 0, flipCollisions: 0, kindSet: 0 };
    const flips: string[] = [];
    const families: Record<number, string> = {};
    for (const row of rels) {
      const id = row.id as number;
      const list = (scores.get(id) ?? []).filter((s) => !('error' in s));
      const best = list.length ? list.reduce((x, y) => (y.score > x.score ? y : x)) : null;
      const fromKind = entKind.get(row.from_entity as number) ?? '';
      const toKind = entKind.get(row.to_entity as number) ?? '';
      const nonchar = fromKind !== 'character' || toKind !== 'character';
      if (!best) {
        db.prepare("UPDATE canon_relation SET review_status = 'needs_review', supporting_evidence = ?, relation_status = 'unknown' WHERE id = ?").run(
          appendRegather(String(row.supporting_evidence ?? '[]'), 'no-passage', 0), id);
        counts.noPassage = (counts.noPassage ?? 0) + 1;
        continue;
      }
      if (best.score < BAR) {
        db.prepare("UPDATE canon_relation SET review_status = 'needs_review', supporting_evidence = ?, relation_status = 'unknown' WHERE id = ?").run(
          appendRegather(String(row.supporting_evidence ?? '[]'), 'below-bar', best.score), id);
        counts.belowBar = (counts.belowBar ?? 0) + 1;
        continue;
      }
      // Winner: store sentence + chunk. Both sides guaranteed by retrieval.
      const refs = JSON.stringify([{ chunk: best.chunk, locator: best.locator }]);
      db.prepare('UPDATE canon_relation SET evidence = ?, source_refs = ? WHERE id = ?').run(best.sentence, refs, id);
      counts.winners = (counts.winners ?? 0) + 1;
      families[id] = best.family;
      // Direction flip (asymmetric families only).
      if (best.direction === 'flipped' && ASYMMETRIC.has(best.family)) {
        const from = row.from_entity as number;
        const to = row.to_entity as number;
        const clash = db.prepare('SELECT id FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ? AND scope = ? AND id != ?')
          .get(PROJECT, to, from, row.kind, row.scope, id) as { id: number } | undefined;
        if (!clash) {
          db.prepare('UPDATE canon_relation SET from_entity = ?, to_entity = ? WHERE id = ?').run(to, from, id);
          flips.push(`${id} flipped (${best.family})`);
          counts.flips = (counts.flips ?? 0) + 1;
        } else {
          db.prepare("UPDATE canon_relation SET review_status = 'needs_review', supporting_evidence = ? WHERE id = ?").run(
            appendRegather(String(row.supporting_evidence ?? '[]'), 'flip-collision', best.score), id);
          flips.push(`${id} flip-collision vs ${clash.id}`);
          counts.flipCollisions = (counts.flipCollisions ?? 0) + 1;
        }
      }
      // Kind-less rows take the canonical family label.
      if (!String(row.kind ?? '').trim() && best.family !== OTHER) {
        const canonical = FAMILIES.find((f) => f.family === best.family)?.canonical ?? best.family;
        db.prepare('UPDATE canon_relation SET kind = ? WHERE id = ?').run(canonical, id);
        counts.kindSet = (counts.kindSet ?? 0) + 1;
      }
      if (best.family === OTHER) {
        db.prepare("UPDATE canon_relation SET review_status = 'needs_review', supporting_evidence = ? WHERE id = ?").run(
          appendRegather(String(row.supporting_evidence ?? '[]'), 'kind-unsupported', best.score), id);
        counts.kindUnsupported = (counts.kindUnsupported ?? 0) + 1;
      }
      if (nonchar && PROOF.includes(String(row.review_status))) {
        db.prepare("UPDATE canon_relation SET review_status = 'needs_review', supporting_evidence = ? WHERE id = ?").run(
          appendRegather(String(row.supporting_evidence ?? '[]'), 'noncharacter-endpoint', best.score), id);
        counts.noncharacterEndpoint = (counts.noncharacterEndpoint ?? 0) + 1;
      }
      db.prepare('UPDATE canon_relation SET relation_status = ? WHERE id = ?').run(statusOfPassage(best.sentence), id);
    }
    writeFileSync(`${TRACK}/families.json`, JSON.stringify({ families, counts, flips }, null, 1));
    console.log(`apply: ${JSON.stringify(counts)}`);
    return counts;
  } finally {
    db.close();
  }
}

type AnyRow = Record<string, unknown>;

export function verifyEvidence(): Record<string, unknown> {
  const db = new DatabaseSync(COPY, { readOnly: true });
  try {
    const entRows = db.prepare('SELECT id, kind, name, aliases FROM canon_entity WHERE project_id = ?').all(PROJECT) as { id: number; kind: string; name: string; aliases: string }[];
    const entById = new Map(entRows.map((e) => [e.id, e]));
    const formsFor = (e: { name: string; aliases: string }): string[] => {
      let aliases: string[] = [];
      try {
        const p = JSON.parse(e.aliases || '[]') as unknown;
        if (Array.isArray(p)) aliases = p.map(String);
      } catch { aliases = []; }
      const forms = new Set([fold(e.name), ...aliases.map(fold)].filter((f) => f && f.length > 2));
      const toks = toksOf(e.name);
      const sur = toks[toks.length - 1];
      if (sur) forms.add(sur);
      return [...forms];
    };
    const formCache = new Map(entRows.map((e) => [e.id, formsFor(e)]));
    const rels = db.prepare('SELECT * FROM canon_relation WHERE project_id = ?').all(PROJECT) as AnyRow[];
    let orphans = 0;
    let selfLoops = 0;
    let proofLackingBoth = 0;
    let proofNonchar = 0;
    let nullStatus = 0;
    const lacking: number[] = [];
    for (const r of rels) {
      const a = entById.get(r.from_entity as number);
      const b = entById.get(r.to_entity as number);
      if (!a || !b) { orphans++; continue; }
      if (r.from_entity === r.to_entity) selfLoops++;
      if (!('relation_status' in r) || r.relation_status == null) nullStatus++;
      if (PROOF.includes(String(r.review_status))) {
        if (a.kind !== 'character' || b.kind !== 'character') proofNonchar++;
        const ev = fold(String(r.evidence ?? ''));
        const fa = formCache.get(a.id) ?? [];
        const fb = formCache.get(b.id) ?? [];
        if (!fa.some((f) => ev.includes(f)) || !fb.some((f) => ev.includes(f))) {
          proofLackingBoth++;
          if (lacking.length < 20) lacking.push(r.id as number);
        }
      }
    }
    const cols = db.prepare('PRAGMA table_info(canon_relation)').all() as { name: string }[];
    const hasStatusCol = cols.some((c) => c.name === 'relation_status');
    const dist = hasStatusCol
      ? (db.prepare('SELECT relation_status, count(*) c FROM canon_relation WHERE project_id = ? GROUP BY 1').all(PROJECT) as { relation_status: string; c: number }[])
      : [];
    const out = {
      orphans, selfLoops, proofLackingBoth, lackingSample: lacking,
      proofNonchar, nullStatus, hasStatusCol,
      statusDist: Object.fromEntries(dist.map((d) => [String(d.relation_status), d.c])),
    };
    writeFileSync(`${TRACK}/verify-evidence.json`, JSON.stringify(out, null, 1));
    console.log(`verify-evidence: orphans=${orphans} self=${selfLoops} lacking=${proofLackingBoth} nonchar=${proofNonchar} nullStatus=${nullStatus} dist=${JSON.stringify(out.statusDist)}`);
    if (orphans || selfLoops || proofLackingBoth || proofNonchar || nullStatus || !out.hasStatusCol) fail('evidence gate failed');
    return out;
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('evidence.ts')) {
  const step = process.argv[2] ?? 'all';
  (async () => {
    if (step === 'cands' || step === 'all') cands();
    if (step === 'score' || step === 'all') await score();
    if (step === 'apply' || step === 'all') applyEvidence();
    if (step === 'verify' || step === 'all') verifyEvidence();
    if (!['cands', 'score', 'apply', 'verify', 'all'].includes(step)) {
      console.error('evidence: use cands|score|apply|verify|all');
      process.exit(1);
    }
  })().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
