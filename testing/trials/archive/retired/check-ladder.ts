import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const log = (m: string) => {
  try { db.run("INSERT INTO chain_log(run, kind, msg) VALUES ('ladder','ladder', ?)", m); } catch {}
};
const srcId = db.get<{ id: number }>("SELECT id FROM project WHERE name='bench-hp'")!.id;
const chunks = db.all<{ id: number; seq: number; text: string }>(
  'SELECT id, seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcId,
);
const fullText = chunks.map((c) => c.text).join('\n');
const entities = db.all<{ id: number; name: string; kind: string }>(
  "SELECT id, name, kind FROM canon_entity WHERE project_id = ? AND kind='character'", srcId,
);
// Build 20 close pairs: first 20 character pairs sharing a window, deterministic.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const entWins = new Map<number, Set<number>>();
const NWIN = Math.ceil(chunks.length / 8);
const winOf = (seq: number) => Math.floor(seq / 8);
for (const e of entities) {
  const et = new Set(norm(e.name).split(' ').filter((t) => t.length >= 3));
  const s = new Set<number>();
  chunks.forEach((c) => {
    const w = new Set(norm(c.text).split(' '));
    if ([...et].some((t) => w.has(t))) s.add(winOf(c.seq));
  });
  entWins.set(e.id, s);
}
const pairs: { from: string; to: string; mid: string; pos: number }[] = [];
outer: for (let i = 0; i < entities.length; i++) {
  for (let j = i + 1; j < entities.length; j++) {
    const a = entities[i]!, b = entities[j]!;
    const shared = [...entWins.get(a.id)!].filter((w) => entWins.get(b.id)!.has(w));
    if (!shared.length) continue;
    // Find first co-occurrence in full text.
    const ia = fullText.indexOf(a.name), ib = fullText.indexOf(b.name);
    if (ia < 0 || ib < 0) continue;
    const s = Math.min(ia, ib), e2 = Math.max(ia, ib);
    const mid = fullText.slice(s, e2 + Math.max(a.name.length, b.name.length));
    if (mid.length > 5000 || mid.length < 20) continue;
    pairs.push({ from: a.name, to: b.name, mid, pos: s });
    if (pairs.length >= 20) break outer;
  }
}
console.log('pairs:' + pairs.length);
const MENU = ['husband of','wife of','father of','mother of','son of','daughter of','brother of','sister of','uncle of','aunt of','nephew of','niece of','cousin of','friend of','enemy of','rival of','teacher of','student of','professor of','headmaster of','colleague of','teammate of','classmate of','neighbor of','servant of','master of','guardian of','mentor of','ally of','stranger to','not directly related'];
const llm = baselineClient();
const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const widths = [0, 500, 1500, 3000];
const OUT = '/tmp/opencode/ladder.jsonl';
if (existsSync(OUT)) writeFileSync(OUT, '');
for (const w of widths) {
  let keep = 0;
  const t0 = Date.now();
  for (const p of pairs) {
    const s = Math.max(0, p.pos - w), e2 = Math.min(fullText.length, p.pos + p.mid.length + w);
    const shown = fullText.slice(s, e2);
    const flat = normQ(shown);
    let best: any = null, ok = false;
    for (let a = 1; a <= 2 && !ok; a++) {
      try {
        const sys = 'Two people are named below, then book text. Find what they are to each other. Reply with JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": ["1 to 3 short exact quotes under 120 chars"], "evidence": "strongest quote copied exactly"}. Start with {. No other words.';
        const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${p.from} / ${p.to}\n\nTEXT:\n${shown.slice(0, 6000)}` }], temperature: 0.1, maxTokens: 400 });
        const raw = (res.text ?? '').replace(/```json|```/g, '');
        const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
        if (si < 0) continue;
        best = JSON.parse(raw.slice(si, ei + 1));
        if (!MENU.includes(String(best?.relationship ?? '').toLowerCase().trim())) continue;
        if (!Array.isArray(best.signals) || !best.signals.length) continue;
        const ev = normQ(String(best.evidence ?? ''));
        if (ev.length > 10 && flat.includes(ev) && best.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); })) ok = true;
      } catch {}
    }
    if (ok) keep++;
    const row = { width: w, from: p.from, to: p.to, kept: ok, rel: best?.relationship ?? null };
    writeFileSync(OUT, (existsSync(OUT) ? readFileSync(OUT, 'utf8') : '') + JSON.stringify(row) + '\n');
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`WIDTH ${w}: kept ${keep}/${pairs.length} in ${secs}s`);
  log(`width ${w}: kept ${keep}/${pairs.length} in ${secs}s`);
}
db.close();
