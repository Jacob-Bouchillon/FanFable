import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as controller from '/home/jacob/Documents/FanFable/fanfable/src/controller.ts';
import * as lorebook from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const logDb = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
logDb.raw.exec("CREATE TABLE IF NOT EXISTS chain_log(id INTEGER PRIMARY KEY, run TEXT, kind TEXT, msg TEXT, at TEXT DEFAULT (datetime('now')))");
function liveLog(run: string, kind: string, msg: string): void {
  try { logDb.run('INSERT INTO chain_log(run, kind, msg) VALUES (?, ?, ?)', run, kind, msg); } catch {}
}
const RUN = 'book-people-vq-' + Date.now();
const src = controller.getProjectByName(db, 'bench-hp')!;
const llm = baselineClient();
const BUDGET = 6, HUB_DF = 0.5, MIN_STEPS = 3, DIM_ZERO_STREAK = 2;
const GLOBAL_WINDOW_BUDGET = 24, GLOBAL_DEAD_CHAINS = 2;
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s: string) => norm(s).split(' ').filter((t) => t.length >= 3);
const chunks = db.all<{ id: number; seq: number; text: string }>(
  'SELECT id, seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', src.id,
);
const NWIN = Math.ceil(chunks.length / 8);
const winOf = (seq: number) => Math.floor(seq / 8);
const entities = db.all<{ id: number; name: string; kind: string }>(
  'SELECT id, name, kind FROM canon_entity WHERE project_id = ?', src.id,
);
const entWindows = new Map<number, Set<number>>();
const entFirst = new Map<number, number>();
for (const e of entities) {
  const et = new Set(toks(e.name));
  const s = new Set<number>();
  for (const c of chunks) {
    const words = new Set(norm(c.text).split(' '));
    if ([...et].some((t) => words.has(t))) s.add(winOf(c.seq));
  }
  entWindows.set(e.id, s);
  entFirst.set(e.id, s.size ? Math.min(...s) : NWIN + 1);
}
const GROUP_PLURAL = new Set(['twins','triplets','siblings','sisters','brothers','cousins','parents','children','friends','enemies','rivals','classmates','teammates','teachers','students','professors','neighbours','neighbors','allies','servants','masters','guardians','mentors','team','crew','gang','club','squad']);
const lastTok = (n: string) => {
  const parts = norm(n).split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
};
const isGroupName = (n: string) => GROUP_PLURAL.has(lastTok(n));
const TITLEWORDS = new Set(['mr','mrs','ms','miss','dr','professor','prof','aunt','uncle','madam','sir','lady','lord','and']);
const nameToks = (n: string) => new Set(
  n.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t)),
);
function samePerson(a: string, b: string, knownSurnames?: Map<string, number>): boolean {
  const A = nameToks(a), B = nameToks(b);
  if (!A.size || !B.size) return false;
  const aParts = a.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  const bParts = b.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  if (aParts.length === 1 && bParts.length > 1 && aParts[0] === bParts[bParts.length - 1]) {
    if (knownSurnames) {
      const n = knownSurnames.get(aParts[0]!) ?? 0;
      if (n <= 1) return true;
      return false;
    }
    return true;
  }
  if (bParts.length === 1 && aParts.length > 1 && bParts[0] === aParts[aParts.length - 1]) {
    if (knownSurnames) {
      const n = knownSurnames.get(bParts[0]!) ?? 0;
      if (n <= 1) return true;
      return false;
    }
    return true;
  }
  const ta = a.toLowerCase().replace(/\./g, ' ').split(/\s+/).find((t) => TITLEWORDS.has(t)) ?? null;
  const tb = b.toLowerCase().replace(/\./g, ' ').split(/\s+/).find((t) => TITLEWORDS.has(t)) ?? null;
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  if (![...s].every((t) => l.has(t))) return false;
  if (l.size === s.size) return ta === tb || ta === null || tb === null;
  if (s.size !== 1) return false;
  const only = [...s][0]!;
  const last = [...l].pop()!;
  return only !== last;
}
// Strict ask: JSON only, retry once, parse true/false words.
const personCache = new Map<string, boolean>();
async function askOnce(name: string): Promise<boolean | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await llm.chat({
        system: 'You classify story names. Reply with JSON only, exactly {"person": true} or {"person": false}. True only for one single human person (ghosts count true). False for pairs, teams, houses, creatures, objects, places, events, groups. No other words. Start with {.',
        messages: [{ role: 'user', content: `NAME: ${name}` }],
        temperature: 0, maxTokens: 20,
      });
      const txt = (res.text ?? '').replace(/```json|```/g, '').trim();
      const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
      if (a >= 0 && b > a) {
        const j: any = JSON.parse(txt.slice(a, b + 1));
        if (j.person === true) return true;
        if (j.person === false) return false;
      }
      const low = txt.toLowerCase();
      if (/\btrue\b/.test(low) && !/\bfalse\b/.test(low)) return true;
      if (/\bfalse\b/.test(low) && !/\btrue\b/.test(low)) return false;
    } catch {}
  }
  return null;
}
async function isSinglePersonStart(name: string): Promise<boolean> {
  const k = 's:' + name.toLowerCase().trim();
  if (personCache.has(k)) return personCache.get(k)!;
  const v = await askOnce(name);
  // Starts: block on misfire. Never list what we cannot confirm.
  const out = v === true;
  personCache.set(k, out);
  liveLog(RUN, 'ptest', `${name} -> ${out ? 'person' : 'not-person'}${v === null ? ' (misfire-block)' : ''}`);
  return out;
}
async function isSinglePersonHop(name: string): Promise<boolean | null> {
  const k = 'h:' + name.toLowerCase().trim();
  if (personCache.has(k)) return personCache.get(k)!;
  const v = await askOnce(name);
  if (v === null) return null;
  personCache.set(k, v);
  liveLog(RUN, 'ptest', `${name} -> ${v ? 'person' : 'not-person'}`);
  return v;
}
const cands0 = entities
  .filter((e) => {
    if (e.kind !== 'character') return false;
    if (isGroupName(e.name)) return false;
    const n = entWindows.get(e.id)!.size;
    return n >= 3 && n / NWIN <= HUB_DF;
  })
  .sort((a, b) => entFirst.get(a.id)! - entFirst.get(b.id)!);
const starts: typeof entities = [];
for (const e of cands0) {
  if (starts.length >= 3) break;
  if (!starts.every((s) => Math.abs(entFirst.get(s.id)! - entFirst.get(e.id)!) >= 8)) continue;
  if (await isSinglePersonStart(e.name)) starts.push(e);
  else liveLog(RUN, 'ptest', `start blocked: ${e.name}`);
}
console.log('starts:', starts.map((s) => s.name).join(' | ') || '(none passed)');
liveLog(RUN, 'people-pilot', `starts: ${starts.map((s) => s.name).join(' | ')} (strict-ask, tank 24)`);
let project = controller.getProjectByName(db, 'book-people-vq') ?? controller.createProject(db, 'book-people-vq');
for (const t of ['canon_relation', 'canon_fact', 'canon_timeline', 'canon_entity', 'canon_chunk', 'canon_source']) {
  db.run(`DELETE FROM ${t} WHERE project_id = ?`, project.id);
}
const source = db.get<any>('SELECT * FROM canon_source WHERE project_id = ? LIMIT 1', src.id)!;
const res = db.run(
  `INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  project.id, `${source.path}#book-people-vq`, source.title, source.author, source.format, source.sha256, source.byte_size, source.page_count,
);
const sourceId = res.lastInsertRowid;
let seq = 0, lastRelId = 0, lastEntId = 0, lastFactId = 0, lastTlId = 0;
const gVisitedEnt = new Set<number>();
const gReadWin = new Set<number>();
const knownSurnames = new Map<string, number>();
const surnameOf = (n: string) => {
  const parts = n.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  return parts.length ? parts[parts.length - 1]! : '';
};
const bumpSurname = (n: string) => {
  const s = surnameOf(n);
  if (s) knownSurnames.set(s, (knownSurnames.get(s) ?? 0) + 1);
};
let deadChains = 0, chainIdx = 0;
for (const start of starts) {
  if (gReadWin.size >= GLOBAL_WINDOW_BUDGET) { console.log('global stop: window budget'); break; }
  if (deadChains >= GLOBAL_DEAD_CHAINS && chainIdx >= 2) { console.log('global stop: veins empty'); break; }
  chainIdx++;
  const visited = new Set<number>([start.id]);
  const visitedNames: string[] = [start.name];
  bumpSurname(start.name);
  let current = start, step = 0, zeroStreak = 0, chainNew = 0;
  console.log(`--- chain ${chainIdx}: start ${start.name}`);
  liveLog(RUN, 'chain', `start ${start.name}`);
  while (true) {
    const cw = entWindows.get(current.id)!;
    const pre: { e: { id: number; name: string; kind: string }; shared: number }[] = [];
    for (const e of entities) {
      if (e.kind !== 'character') continue;
      if (isGroupName(e.name)) continue;
      if (samePerson(current.name, e.name, knownSurnames)) continue;
      if (visitedNames.some((vn) => samePerson(vn, e.name, knownSurnames))) continue;
      if (visited.has(e.id) || gVisitedEnt.has(e.id)) continue;
      const ew = entWindows.get(e.id)!;
      if (ew.size / NWIN > HUB_DF) continue;
      let shared = 0;
      for (const w of cw) if (ew.has(w)) shared++;
      if (shared > 0) pre.push({ e, shared });
    }
    pre.sort((a, b) => b.shared - a.shared || a.e.id - b.e.id);
    const hopCands: typeof pre = [];
    for (const cd of pre.slice(0, 8)) {
      const v = await isSinglePersonHop(cd.e.name);
      if (v === true) hopCands.push(cd);
      else if (v === false) liveLog(RUN, 'ptest', `hop blocked: ${cd.e.name}`);
      if (hopCands.length >= 3) break;
    }
    if (!hopCands.length) { console.log('  stop: dead end (gated)'); liveLog(RUN, 'ptest', `${current.name}: all top gated out`); break; }
    hopCands.sort((a, b) => b.shared - a.shared || a.e.id - b.e.id);
    const next = hopCands[0]!;
    const take = [...cw].filter((w) => entWindows.get(next.e.id)!.has(w) && !gReadWin.has(w)).slice(0, 2);
    for (const w of take) {
      for (const c of chunks.filter((x) => winOf(x.seq) === w)) {
        const row: any = db.get('SELECT locator, heading, char_start, char_end, words, page_start, page_end FROM canon_chunk WHERE id = ?', c.id)!;
        db.run(
          `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sourceId, project.id, seq++, row.locator, row.heading, c.text, row.char_start, row.char_end, row.words, row.page_start, row.page_end,
        );
      }
      gReadWin.add(w);
    }
    liveLog(RUN, 'choice', `${current.name}: cands ` + hopCands.slice(0, 3).map((c) => `${c.e.name}(${c.shared})`).join(', ') + ` -> picked ${next.e.name}`);
    const st = await lorebook.extractLore(db, llm, project.id, { concurrency: 3, incremental: true });
    liveLog(RUN, 'verify', `claimed=${st.verification.claimed} verified=${st.verification.verified} repointed=${st.verification.repointed} dropped=${st.verification.dropped} unresolved=${st.verification.unresolved}`);
    const fresh = db.all<any>(
      `SELECT r.id, fe.name AS f, te.name AS t, r.kind FROM canon_relation r
       JOIN canon_entity fe ON fe.id=r.from_entity JOIN canon_entity te ON te.id=r.to_entity
       WHERE r.project_id = ? AND r.id > ? ORDER BY r.id`, project.id, lastRelId,
    );
    for (const fr of fresh) liveLog(RUN, 'tie', `${fr.f} --${fr.kind}--> ${fr.t}`);
    for (const er of db.all<any>('SELECT id, kind, name FROM canon_entity WHERE project_id = ? AND id > ?', project.id, lastEntId)) {
      liveLog(RUN, 'hit', `[${er.kind}] ${er.name}`); lastEntId = Math.max(lastEntId, er.id);
    }
    for (const fr2 of db.all<any>('SELECT id, statement FROM canon_fact WHERE project_id = ? AND id > ?', project.id, lastFactId)) {
      liveLog(RUN, 'hit', `fact: ${String(fr2.statement).slice(0, 90)}`); lastFactId = Math.max(lastFactId, fr2.id);
    }
    for (const tr of db.all<any>('SELECT id, title FROM canon_timeline WHERE project_id = ? AND id > ?', project.id, lastTlId)) {
      liveLog(RUN, 'hit', `event: ${tr.title}`); lastTlId = Math.max(lastTlId, tr.id);
    }
    lastRelId = db.get<{ m: number }>('SELECT MAX(id) AS m FROM canon_relation WHERE project_id = ?', project.id)?.m ?? lastRelId;
    step++;
    chainNew += fresh.length;
    console.log(`  step ${step}: ${current.name} -> ${next.e.name} (${take.length} new windows, ${fresh.length} new ties)`);
    liveLog(RUN, 'step', `${current.name} -> ${next.e.name} | ${take.length} windows | ${fresh.length} ties`);
    zeroStreak = fresh.length === 0 ? zeroStreak + 1 : 0;
    visited.add(next.e.id);
    visitedNames.push(next.e.name);
    bumpSurname(next.e.name);
    gVisitedEnt.add(next.e.id);
    current = next.e;
    if (step >= BUDGET) { console.log('  stop: budget'); break; }
    if (step >= MIN_STEPS && zeroStreak >= DIM_ZERO_STREAK) { console.log('  stop: vein empty'); break; }
  }
  if (chainNew === 0) deadChains++;
  console.log(`chain ${chainIdx} done: ${step} handoffs, ${chainNew} ties (global windows: ${gReadWin.size})`);
  liveLog(RUN, 'chain-done', `${step} handoffs, ${chainNew} ties, ${gReadWin.size} windows read`);
}
const totals = {
  entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)?.n ?? 0,
  relations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n ?? 0,
};
console.log(`BOOK-PEOPLE-VQ DONE: ${chainIdx} chains, ${gReadWin.size} windows read, ~${gReadWin.size * 3} calls, ${totals.entities} beings, ${totals.relations} ties (+ptest ${personCache.size})`);
liveLog(RUN, 'done', `${chainIdx} chains, ${gReadWin.size} windows, ${totals.relations} ties, ptest ${personCache.size} (strict-ask)`);
db.close();
