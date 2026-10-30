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
const RUN = 'book-people-vl-' + Date.now();
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
function samePerson(a: string, b: string): boolean {
  const A = nameToks(a), B = nameToks(b);
  if (!A.size || !B.size) return false;
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
const cands = entities
  .filter((e) => {
    if (e.kind !== 'character') return false;
    if (isGroupName(e.name)) return false;
    const n = entWindows.get(e.id)!.size;
    return n >= 3 && n / NWIN <= HUB_DF;
  })
  .sort((a, b) => entFirst.get(a.id)! - entFirst.get(b.id)!);
const starts: typeof entities = [];
for (const e of cands) {
  if (starts.length >= 3) break;
  if (starts.every((s) => Math.abs(entFirst.get(s.id)! - entFirst.get(e.id)!) >= 8)) starts.push(e);
}
console.log('starts:', starts.map((s) => s.name).join(' | '));
liveLog(RUN, 'people-pilot', `starts: ${starts.map((s) => s.name).join(' | ')} (lookback, tank 24)`);
let project = controller.getProjectByName(db, 'book-people-vl') ?? controller.createProject(db, 'book-people-vl');
for (const t of ['canon_relation', 'canon_fact', 'canon_timeline', 'canon_entity', 'canon_chunk', 'canon_source']) {
  db.run(`DELETE FROM ${t} WHERE project_id = ?`, project.id);
}
const source = db.get<any>('SELECT * FROM canon_source WHERE project_id = ? LIMIT 1', src.id)!;
const res = db.run(
  `INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  project.id, `${source.path}#book-people-vl`, source.title, source.author, source.format, source.sha256, source.byte_size, source.page_count,
);
const sourceId = res.lastInsertRowid;
let seq = 0, lastRelId = 0, lastEntId = 0, lastFactId = 0, lastTlId = 0;
const gVisitedEnt = new Set<number>();
const gReadWin = new Set<number>();
let deadChains = 0, chainIdx = 0;
for (const start of starts) {
  if (gReadWin.size >= GLOBAL_WINDOW_BUDGET) { console.log('global stop: window budget'); break; }
  if (deadChains >= GLOBAL_DEAD_CHAINS && chainIdx >= 2) { console.log('global stop: veins empty'); break; }
  chainIdx++;
  const visited = new Set<number>([start.id]);
  const visitedNames: string[] = [start.name];
  let current = start, step = 0, zeroStreak = 0, chainNew = 0;
  console.log(`--- chain ${chainIdx}: start ${start.name}`);
  liveLog(RUN, 'chain', `start ${start.name}`);
  while (true) {
    const cw = entWindows.get(current.id)!;
    const hopCands: { e: { id: number; name: string; kind: string }; shared: number }[] = [];
    for (const e of entities) {
      if (e.kind !== 'character') continue;
      if (isGroupName(e.name)) continue;
      if (samePerson(current.name, e.name)) continue;
      if (visitedNames.some((vn) => samePerson(vn, e.name))) continue;
      if (visited.has(e.id) || gVisitedEnt.has(e.id)) continue;
      const ew = entWindows.get(e.id)!;
      if (ew.size / NWIN > HUB_DF) continue;
      let shared = 0;
      for (const w of cw) if (ew.has(w)) shared++;
      if (shared > 0) hopCands.push({ e, shared });
    }
    hopCands.sort((a, b) => b.shared - a.shared || a.e.id - b.e.id);
    const next = hopCands[0];
    if (!next) { console.log('  stop: dead end'); break; }
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
console.log(`BOOK-PEOPLE-VL DONE: ${chainIdx} chains, ${gReadWin.size} windows read, ~${gReadWin.size * 3} calls, ${totals.entities} beings, ${totals.relations} ties`);
liveLog(RUN, 'done', `${chainIdx} chains, ${gReadWin.size} windows, ${totals.relations} ties (lookback)`);
db.close();
