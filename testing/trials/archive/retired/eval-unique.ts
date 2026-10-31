import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const srcId = db.get<{ id: number }>("SELECT id FROM project WHERE name='bench-hp'")!.id;
const coordId = db.get<{ id: number }>("SELECT id FROM project WHERE name='book-coord'")!.id;
const chunks = db.all<{ seq: number; text: string }>('SELECT seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcId);
const fullText = chunks.map((c) => c.text).join('\n');
const rels = db.all<{ f: string; t: string }>(`SELECT fe.name AS f, te.name AS t FROM canon_relation r JOIN canon_entity fe ON fe.id=r.from_entity JOIN canon_entity te ON te.id=r.to_entity WHERE r.project_id = ?`, coordId);
const MENU = ['husband of','wife of','father of','mother of','son of','daughter of','brother of','sister of','uncle of','aunt of','nephew of','niece of','cousin of','friend of','enemy of','rival of','teacher of','student of','professor of','headmaster of','colleague of','teammate of','classmate of','neighbor of','servant of','master of','guardian of','mentor of','ally of','stranger to','not directly related'];
const STOP = new Set(['of','to','the','a','an','as','not','directly','related']);
const SYN: Record<string,string[]> = {'husband of':['husband','wife','married'],'wife of':['wife','husband','married'],'mother of':['mother','mum','mummy','mom'],'father of':['father','dad','daddy'],'teacher of':['teacher','teach'],'teammate of':['team','teammate'],'classmate of':['class','classmate'],'aunt of':['aunt','auntie'],'enemy of':['enemy','enemies'],'ally of':['ally','allies'],'neighbor of':['neighbour','neighbor'],'servant of':['servant','serve']};
const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const norm = (s: string) => normQ(s).toLowerCase();
function groundingWords(label: string): string[] {
  const key = label.toLowerCase().trim();
  if (key === 'not directly related') return [];
  if (key in SYN) return SYN[key]!;
  return key.split(/[^a-z]+/).filter((w) => w && !STOP.has(w));
}
function grounded(label: string, flat: string, names: string[]): boolean {
  let scrubbed = norm(flat);
  for (const nm of names) { const full = norm(nm); if (full.length > 3) scrubbed = scrubbed.split(full).join(' '); }
  const words = groundingWords(label);
  if (!words.length) return true;
  return words.some((w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(scrubbed));
}
const llm = baselineClient();
const best = new Map<string, { f: string; t: string; rel: string }>();
const t0 = Date.now();
for (const r of rels) {
  const ia = fullText.indexOf(r.f), ib = fullText.indexOf(r.t);
  if (ia < 0 || ib < 0) continue;
  const s = Math.min(ia, ib), e2 = Math.max(ia, ib) + Math.max(r.f.length, r.t.length);
  const shown = fullText.slice(Math.max(0, s - 500), Math.min(fullText.length, e2 + 500));
  const flat = normQ(shown);
  let hit: { rel: string } | null = null;
  for (let a = 1; a <= 2 && !hit; a++) {
    try {
      const sys = 'Two people are named below, then book text. Reply JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": ["1 to 3 short exact quotes under 120 chars"], "evidence": "strongest quote"}. Label words must appear in text. Copy quotes exactly. Start with {.';
      const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${r.f} / ${r.t}\n\nTEXT:\n${shown.slice(0, 6000)}` }], temperature: 0.1, maxTokens: 400 });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
      if (si < 0) continue;
      const b: any = JSON.parse(raw.slice(si, ei + 1));
      const rel = String(b?.relationship ?? '').toLowerCase().trim();
      if (!MENU.includes(rel)) continue;
      if (!Array.isArray(b.signals) || !b.signals.length) continue;
      const ev = normQ(String(b.evidence ?? ''));
      if (!(ev.length > 10 && flat.includes(ev) && b.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); }))) continue;
      if (!grounded(rel, flat, [r.f, r.t])) continue;
      hit = { rel };
    } catch {}
  }
  if (!hit) continue;
  const k = [r.f, r.t].sort().join('|');
  if (!best.has(k)) best.set(k, { f: r.f, t: r.t, rel: hit.rel });
}
console.log(`UNIQUE KEEPERS ${best.size}/${rels.length} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const v of best.values()) console.log(`KEEP ${v.f} -> ${v.t} (${v.rel})`);
db.close();
