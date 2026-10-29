import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

/* count-ties.ts with two fixes: every row in the project (no 49 cap) and
 * case-insensitive endpoint lookup. Same menu, window, tries, sampling and
 * exact-quote check. Count-only output. */

const projectName = process.argv[2];
if (!projectName) throw new Error('usage: count-ties-full.ts <project-name>');
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const srcId = db.get<{ id: number }>("SELECT id FROM project WHERE name='bench-hp'")!.id;
const coordId = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName)!.id;
const chunks = db.all<{ seq: number; text: string }>('SELECT seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcId);
const fullText = chunks.map((c) => c.text).join('\n');
const lowerText = fullText.toLowerCase();
const rels = db.all<{ f: string; t: string; kind: string }>(`SELECT fe.name AS f, te.name AS t, r.kind FROM canon_relation r JOIN canon_entity fe ON fe.id=r.from_entity JOIN canon_entity te ON te.id=r.to_entity WHERE r.project_id = ?`, coordId);
console.log('ties:' + rels.length);
const MENU = ['husband of','wife of','father of','mother of','son of','daughter of','brother of','sister of','uncle of','aunt of','nephew of','niece of','cousin of','friend of','enemy of','rival of','teacher of','student of','professor of','headmaster of','colleague of','teammate of','classmate of','neighbor of','servant of','master of','guardian of','mentor of','ally of','stranger to','not directly related'];
const llm = baselineClient();
const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
let keep = 0, scored = 0, skipped = 0;
const t0 = Date.now();
for (const r of rels) {
  const ia = lowerText.indexOf(r.f.toLowerCase()), ib = lowerText.indexOf(r.t.toLowerCase());
  if (ia < 0 || ib < 0) { skipped++; console.log('SKIP'); continue; }
  scored++;
  const s = Math.min(ia, ib), e2 = Math.max(ia, ib) + Math.max(r.f.length, r.t.length);
  const cs = Math.max(0, s - 500), ce = Math.min(fullText.length, e2 + 500);
  const shown = fullText.slice(cs, ce);
  const flat = normQ(shown);
  let ok = false;
  for (let a = 1; a <= 2 && !ok; a++) {
    try {
      const sys = 'Two people are named below, then book text. Find what they are to each other. Reply with JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": ["1 to 3 short exact quotes under 120 chars"], "evidence": "strongest quote copied exactly"}. Start with {. No other words.';
      const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${r.f} / ${r.t}\n\nTEXT:\n${shown.slice(0, 6000)}` }], temperature: 0.1, maxTokens: 400 });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
      if (si < 0) continue;
      const best: any = JSON.parse(raw.slice(si, ei + 1));
      if (!MENU.includes(String(best?.relationship ?? '').toLowerCase().trim())) continue;
      if (!Array.isArray(best.signals) || !best.signals.length) continue;
      const ev = normQ(String(best.evidence ?? ''));
      if (ev.length > 10 && flat.includes(ev) && best.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); })) ok = true;
    } catch {}
  }
  if (ok) keep++;
  console.log(ok ? 'KEEP' : 'DROP');
}
console.log(`KEEPERS ${keep}/${scored} scored (${rels.length} rows, ${skipped} skipped: endpoint absent) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
db.close();
