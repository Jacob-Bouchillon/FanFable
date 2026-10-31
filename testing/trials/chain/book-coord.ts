import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import * as controller from '/home/jacob/Documents/FanFable/fanfable/src/plan/controller.ts';
import * as lorebook from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const logDb = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
logDb.raw.exec("CREATE TABLE IF NOT EXISTS chain_log(id INTEGER PRIMARY KEY, run TEXT, kind TEXT, msg TEXT, at TEXT DEFAULT (datetime('now')))");
function liveLog(run: string, kind: string, msg: string): void {
  try { logDb.run('INSERT INTO chain_log(run, kind, msg) VALUES (?, ?, ?)', run, kind, msg); } catch {}
}
const RUN = 'book-coord-' + Date.now();
const src = controller.getProjectByName(db, 'bench-hp')!;
const llm = baselineClient();
const BUDGET = 6, HUB_DF = 0.5, MIN_STEPS = 3, DIM_ZERO_STREAK = 2;
const GLOBAL_WINDOW_BUDGET = 24, GLOBAL_DEAD_CHAINS = 2;
const PORTIONS = [10, 8, 6];
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s: string) => norm(s).split(' ').filter((t) => t.length >= 3);
const chunks = db.all<{ id: number; seq: number; text: string }>('SELECT id, seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcIdFix());
function srcIdFix() { return src.id; }
const NWIN = Math.ceil(chunks.length / 8);
const winOf = (seq: number) => Math.floor(seq / 8);
const entities = db.all<{ id: number; name: string; kind: string }>("SELECT id, name, kind FROM canon_entity WHERE project_id = ?", src.id);
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
const lastTok = (n: string) => { const p = norm(n).split(' ').filter(Boolean); return p.length ? p[p.length - 1]! : ''; };
const isGroupName = (n: string) => GROUP_PLURAL.has(lastTok(n));
const TITLEWORDS = new Set(['mr','mrs','ms','miss','dr','professor','prof','aunt','uncle','madam','sir','lady','lord','and']);
const nameToks = (n: string) => new Set(n.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t)));
function samePerson(a: string, b: string, known?: Map<string, number>): boolean {
  const A = nameToks(a), B = nameToks(b);
  if (!A.size || !B.size) return false;
  const ap = a.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  const bp = b.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  if (ap.length === 1 && bp.length > 1 && ap[0] === bp[bp.length - 1]) { if (known) { if ((known.get(ap[0]!) ?? 0) <= 1) return true; return false; } return true; }
  if (bp.length === 1 && ap.length > 1 && bp[0] === ap[ap.length - 1]) { if (known) { if ((known.get(bp[0]!) ?? 0) <= 1) return true; return false; } return true; }
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  if (![...s].every((t) => l.has(t))) return false;
  if (l.size === s.size) return true;
  if (s.size !== 1) return false;
  const only = [...s][0]!, last = [...l].pop()!;
  return only !== last;
}
const personCache = new Map<string, boolean>();
async function askOnce(name: string): Promise<boolean | null> {
  for (let k = 0; k < 2; k++) {
    try {
      const res = await llm.chat({ system: 'You classify story names. Reply with JSON only, exactly {"person": true} or {"person": false}. True only for one single human person (ghosts count true). False for pairs, teams, houses, creatures, objects, places, events, groups. No other words. Start with {.', messages: [{ role: 'user', content: `NAME: ${name}` }], temperature: 0, maxTokens: 20 });
      const txt = (res.text ?? '').replace(/```json|```/g, '').trim();
      const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
      if (a >= 0 && b > a) { const j: any = JSON.parse(txt.slice(a, b + 1)); if (j.person === true) return true; if (j.person === false) return false; }
    } catch {}
  }
  return null;
}
async function passStart(name: string): Promise<boolean> {
  const k = 's:' + name.toLowerCase();
  if (personCache.has(k)) return personCache.get(k)!;
  const v = await askOnce(name);
  const out = v === true;
  personCache.set(k, out);
  liveLog(RUN, 'ptest', `${name} -> ${out ? 'person' : 'not-person'}`);
  return out;
}
async function passHop(name: string): Promise<boolean | null> {
  const k = 'h:' + name.toLowerCase();
  if (personCache.has(k)) return personCache.get(k)!;
  const v = await askOnce(name);
  if (v === null) return null;
  personCache.set(k, v);
  liveLog(RUN, 'ptest', `${name} -> ${v ? 'person' : 'not-person'}`);
  return v;
}
// Starts: strict person gate.
const cands0 = entities.filter((e) => {
  if (e.kind !== 'character') return false;
  if (isGroupName(e.name)) return false;
  const n = entWindows.get(e.id)!.size;
  return n >= 3 && n / NWIN <= HUB_DF;
}).sort((a, b) => entFirst.get(a.id)! - entFirst.get(b.id)!);
const starts: typeof entities = [];
for (const e of cands0) {
  if (starts.length >= 3) break;
  if (!starts.every((s) => Math.abs(entFirst.get(s.id)! - entFirst.get(e.id)!) >= 8)) continue;
  if (await passStart(e.name)) starts.push(e);
}
console.log('starts:', starts.map((s) => s.name).join(' | '));
liveLog(RUN, 'coord', `portions ${PORTIONS.join('/')} tank 24. starts: ${starts.map((s) => s.name).join(' | ')}`);
let project = controller.getProjectByName(db, 'book-coord') ?? controller.createProject(db, 'book-coord');
for (const t of ['canon_relation', 'canon_fact', 'canon_timeline', 'canon_entity', 'canon_chunk', 'canon_source']) db.run(`DELETE FROM ${t} WHERE project_id = ?`, project.id);
const source = db.get<any>('SELECT * FROM canon_source WHERE project_id = ? LIMIT 1', src.id)!;
const res = db.run(`INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`, project.id, `${source.path}#book-coord`, source.title, source.author, source.format, source.sha256, source.byte_size, source.page_count);
const sourceId = res.lastInsertRowid;
let seq = 0, lastRelId = 0, lastEntId = 0, lastFactId = 0, lastTlId = 0;
const gVisitedEnt = new Set<number>();
const gReadWin = new Set<number>();
const knownSurnames = new Map<string, number>();
const surnameOf = (n: string) => { const p = n.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t)); return p.length ? p[p.length - 1]! : ''; };
const pool = new Set<string>(); // shared notes: name tokens from found ties.
let deadChains = 0, chainIdx = 0;
for (const start of starts) {
  if (gReadWin.size >= GLOBAL_WINDOW_BUDGET) { console.log('global stop: window budget'); break; }
  chainIdx++;
  const myPortion = PORTIONS[chainIdx - 1] ?? 6;
  let myRead = 0;
  const visited = new Set<number>([start.id]);
  const visitedNames: string[] = [start.name];
  const bs = surnameOf(start.name); if (bs) knownSurnames.set(bs, (knownSurnames.get(bs) ?? 0) + 1);
  let current = start, step = 0, zeroStreak = 0, chainNew = 0, chainRead = 0;
  console.log(`--- chain ${chainIdx}: start ${start.name} (portion ${myPortion})`);
  liveLog(RUN, 'chain', `start ${start.name} portion ${myPortion}`);
  while (true) {
    if (myRead >= myPortion) { console.log('  stop: portion done, handing back'); liveLog(RUN, 'coord', `chain ${chainIdx} portion done (${myRead}/${myPortion}), handing back ${myPortion - myRead}`); break; }
    const cw = entWindows.get(current.id)!;
    const pre: { e: { id: number; name: string; kind: string }; shared: number; pool: number }[] = [];
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
      if (shared === 0) continue;
      let pb = 0;
      for (const t of nameToks(e.name)) if (pool.has(t)) pb++;
      pre.push({ e, shared, pool: pb });
    }
    pre.sort((a, b) => (b.shared + b.pool) - (a.shared + a.pool) || a.e.id - b.e.id);
    const hopCands: typeof pre = [];
    for (const cd of pre.slice(0, 8)) {
      const v = await passHop(cd.e.name);
      if (v === true) hopCands.push(cd);
      if (hopCands.length >= 3) break;
    }
    if (!hopCands.length) { console.log('  stop: dead end (gated)'); break; }
    hopCands.sort((a, b) => (b.shared + b.pool) - (a.shared + a.pool) || a.e.id - b.e.id);
    const next = hopCands[0]!;
    const take = [...cw].filter((w) => entWindows.get(next.e.id)!.has(w) && !gReadWin.has(w)).slice(0, 2);
    // Portion guard: do not overspend my share.
    const allowed = take.slice(0, Math.max(0, myPortion - myRead));
    for (const w of allowed) {
      for (const c of chunks.filter((x) => winOf(x.seq) === w)) {
        const row: any = db.get('SELECT locator, heading, char_start, char_end, words, page_start, page_end FROM canon_chunk WHERE id = ?', c.id)!;
        db.run(`INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sourceId, project.id, seq++, row.locator, row.heading, c.text, row.char_start, row.char_end, row.words, row.page_start, row.page_end);
      }
      gReadWin.add(w);
    }
    myRead += allowed.length; chainRead += allowed.length;
    liveLog(RUN, 'choice', `${current.name} -> ${next.e.name} (pool+${next.pool})`);
    const st = await lorebook.extractLore(db, llm, project.id, { concurrency: 3, incremental: true });
    const fresh = db.all<any>(`SELECT r.id, fe.name AS f, te.name AS t FROM canon_relation r JOIN canon_entity fe ON fe.id=r.from_entity JOIN canon_entity te ON te.id=r.to_entity WHERE r.project_id = ? AND r.id > ? ORDER BY r.id`, project.id, lastRelId);
    for (const fr of fresh) {
      liveLog(RUN, 'tie', `${fr.f} --> ${fr.t}`);
      for (const t of nameToks(String(fr.f))) pool.add(t);
      for (const t of nameToks(String(fr.t))) pool.add(t);
    }
    for (const er of db.all<any>('SELECT id, kind, name FROM canon_entity WHERE project_id = ? AND id > ?', project.id, lastEntId)) { liveLog(RUN, 'hit', `[${er.kind}] ${er.name}`); lastEntId = Math.max(lastEntId, er.id); }
    lastRelId = db.get<{ m: number }>('SELECT MAX(id) AS m FROM canon_relation WHERE project_id = ?', project.id)?.m ?? lastRelId;
    step++; chainNew += fresh.length;
    console.log(`  step ${step}: ${current.name} -> ${next.e.name} (${allowed.length} new windows, ${fresh.length} new ties)`);
    liveLog(RUN, 'step', `${current.name} -> ${next.e.name} | ${allowed.length} windows | ${fresh.length} ties`);
    // Deserve check after hop 3: under 1.0 per page hands back early.
    if (step === 3) {
      const rate = chainRead > 0 ? chainNew / chainRead : 0;
      if (rate < 1.0) { console.log(`  holder cuts: rate ${rate.toFixed(2)} under bar, handing back`); liveLog(RUN, 'coord', `chain ${chainIdx} cut at hop 3 rate ${rate.toFixed(2)}, handing back ${myPortion - myRead}`); break; }
    }
    zeroStreak = fresh.length === 0 ? zeroStreak + 1 : 0;
    visited.add(next.e.id); visitedNames.push(next.e.name);
    const s2 = surnameOf(next.e.name); if (s2) knownSurnames.set(s2, (knownSurnames.get(s2) ?? 0) + 1);
    gVisitedEnt.add(next.e.id);
    current = next.e;
    if (step >= BUDGET) { console.log('  stop: budget'); break; }
    if (step >= MIN_STEPS && zeroStreak >= DIM_ZERO_STREAK) { console.log('  stop: vein empty'); break; }
  }
  if (chainNew === 0) deadChains++;
  console.log(`chain ${chainIdx} done: ${step} handoffs, ${chainNew} ties (mine ${chainRead}/${myPortion}, global ${gReadWin.size})`);
  liveLog(RUN, 'chain-done', `chain ${chainIdx}: ${step} handoffs, ${chainNew} ties, mine ${chainRead}/${myPortion}`);
}
const totals = { entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)?.n ?? 0, relations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n ?? 0 };
console.log(`BOOK-COORD DONE: ${chainIdx} chains, ${gReadWin.size} windows, ${totals.entities} beings, ${totals.relations} ties, pool ${pool.size}`);
liveLog(RUN, 'done', `${chainIdx} chains, ${gReadWin.size} windows, ${totals.relations} ties, pool ${pool.size} (portions+notes)`);
db.close();
