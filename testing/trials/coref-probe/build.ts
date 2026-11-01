/**
 * Coref probe packets — LitBank gold NOM descriptions with named answers.
 *
 * Trial-only. Joins CoNLL identity chains to brat mention types by
 * normalized text in occurrence order (no heuristics on labels): a NOM_PER
 * span whose chain holds a PROP_PER span is resolvable (answer: that chain's
 * most frequent proper text); a NOM_PER span in a chain with no proper
 * mention at all is a hard negative (answer: nobody). Candidates per packet
 * are the document's named characters plus the literal "nobody"; packets
 * carry no answer (labels.json does). Nothing banks — measurement, verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/coref-probe/build.ts
 *
 * Writes only under testing/trials/coref-probe/ (gitignored; data/ holds the
 * cloned gold). Reports print counts only, never description text, names, or
 * passage prose.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const TRACK = 'testing/trials/coref-probe';
const DATA = `${TRACK}/data`;
const SEED = 42;
const MAX_RESOLVABLE = 200;
const MAX_NEG = 50;

function fail(message: string): never {
  throw new Error(`coref-probe: ${message}`);
}

const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Deterministic RNG for the seed-42 sample. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ChainSpan {
  chain: string;
  text: string;
  block: number;
}

function parseConll(path: string): { chains: Map<string, ChainSpan[]>; blocks: string[][] } {
  const chains = new Map<string, ChainSpan[]>();
  const blocks: string[][] = [];
  let cur: { word: string; coref: string }[] = [];
  let blockIdx = -1;
  const flush = (): void => {
    if (cur.length) {
      blocks.push(cur.map((t) => t.word));
      blockIdx++;
    }
    cur = [];
  };
  const open = new Map<string, { chain: string; start: number; block: number }>();
  const pushSpan = (chain: string, words: string[], block: number): void => {
    const list = chains.get(chain) ?? [];
    list.push({ chain, text: words.join(' '), block });
    chains.set(chain, list);
  };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('#') || !line.trim()) {
      // Blank line ends a block; spans close at block end implicitly.
      if (cur.length) {
        const words = cur.map((t) => t.word);
        for (const [, o] of open) {
          const span = words.slice(o.start);
          if (span.length) pushSpan(o.chain, span, o.block);
        }
        open.clear();
        flush();
      }
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const word = parts[3]!;
    const coref = parts[parts.length - 1]!.trim();
    cur.push({ word, coref });
    const tokIdx = cur.length - 1;
    if (blockIdx + 1 < 0) void 0;
    const bIdx = blocks.length;
    for (const m of coref.matchAll(/\((\d+)/g)) {
      open.set(`${m[1]}`, { chain: m[1]!, start: tokIdx, block: bIdx });
    }
    for (const m of coref.matchAll(/(\d+)\)/g)) {
      const key = `${m[1]}`;
      const o = open.get(key);
      if (o) {
        pushSpan(o.chain, cur.slice(o.start, tokIdx + 1).map((t) => t.word), o.block);
        open.delete(key);
      }
    }
  }
  if (cur.length) {
    const words = cur.map((t) => t.word);
    for (const [, o] of open) {
      const span = words.slice(o.start);
      if (span.length) pushSpan(o.chain, span, o.block);
    }
    flush();
  }
  return { chains, blocks };
}

interface BratMention {
  cls: string;
  text: string;
}

function parseBrat(path: string): BratMention[] {
  const out: BratMention[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('T')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const cls = parts[1]!.split(' ')[0]!;
    out.push({ cls, text: parts[2]! });
  }
  return out;
}

const detok = (words: string[]): string =>
  words
    .join(' ')
    .replace(/\s+([.,!?;:…%‰'’"”)\]}»])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

export function build(): void {
  const conllDir = `${DATA}/coref/conll`;
  const bratDir = `${DATA}/coref/brat`;
  const docs = readdirSync(conllDir)
    .filter((f) => f.endsWith('.conll'))
    .map((f) => f.replace(/_brat\.conll$/, ''))
    .sort();
  if (!docs.length) fail(`no conll documents in ${conllDir}`);
  interface Cand {
    doc: string;
    desc: string;
    context: string;
    answer: string;
  }
  const resolvable: Cand[] = [];
  const negatives: Cand[] = [];
  const perDocResolvable = new Map<string, number>();
  const candidateSizes: number[] = [];
  const docCharacters = new Map<string, string[]>();
  for (const doc of docs) {
    let chains: Map<string, ChainSpan[]>;
    let blocks: string[][];
    try {
      ({ chains, blocks } = parseConll(`${conllDir}/${doc}_brat.conll`));
    } catch {
      continue;
    }
    let brat: BratMention[];
    try {
      brat = parseBrat(`${bratDir}/${doc}_brat.ann`);
    } catch {
      continue;
    }
    // Type each chain span by text+order matching against brat mentions.
    const bratByText = new Map<string, BratMention[]>();
    for (const m of brat) {
      const list = bratByText.get(norm(m.text)) ?? [];
      list.push(m);
      bratByText.set(norm(m.text), list);
    }
    const conllByText = new Map<string, ChainSpan[]>();
    for (const spans of chains.values()) {
      for (const s of spans) {
        const list = conllByText.get(norm(s.text)) ?? [];
        list.push(s);
        conllByText.set(norm(s.text), list);
      }
    }
    const spanClass = new Map<ChainSpan, string>();
    for (const [text, spans] of conllByText) {
      const ms = bratByText.get(text) ?? [];
      const n = Math.min(spans.length, ms.length);
      for (let i = 0; i < n; i++) spanClass.set(spans[i]!, ms[i]!.cls);
    }
    // Characters: chains with a PROP_PER span, named by most frequent proper.
    const charName = new Map<string, string>();
    for (const [chain, spans] of chains) {
      const propers = spans.filter((s) => spanClass.get(s) === 'PROP_PER');
      if (!propers.length) continue;
      const freq = new Map<string, number>();
      for (const s of propers) freq.set(s.text, (freq.get(s.text) ?? 0) + 1);
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
      charName.set(chain, top[0]);
    }
    const candidates = [...new Set(charName.values())];
    if (!candidates.length) continue;
    candidateSizes.push(candidates.length);
    docCharacters.set(doc, [...candidates, 'nobody']);
    const contextOf = (block: number): string => {
      const parts: string[] = [];
      for (let b = Math.max(0, block - 2); b <= Math.min(blocks.length - 1, block + 2); b++) {
        parts.push(detok(blocks[b]!));
      }
      return parts.join(' ');
    };
    let docResolvable = 0;
    for (const [chain, spans] of chains) {
      const answer = charName.get(chain);
      for (const s of spans) {
        if (spanClass.get(s) !== 'NOM_PER') continue;
        if (answer !== undefined) {
          resolvable.push({ doc, desc: s.text, context: contextOf(s.block), answer });
          docResolvable++;
        } else {
          // Hard negative only when the chain has no proper mention at all.
          const hasProper = spans.some(
            (x) => spanClass.get(x) === 'PROP_PER' || spanClass.get(x) === 'PROP_FAC',
          );
          void hasProper;
          const anyProper = [...chains.get(chain)!].some((x) => {
            const c = spanClass.get(x) ?? '';
            return c.startsWith('PROP_');
          });
          if (!anyProper) negatives.push({ doc, desc: s.text, context: contextOf(s.block), answer: 'nobody' });
        }
      }
    }
    perDocResolvable.set(doc, docResolvable);
  }
  console.log(
    `pool: resolvable NOM ${resolvable.length} across ${perDocResolvable.size} documents; ` +
      `hard negatives ${negatives.length}`,
  );
  // Stratified sample: round-robin across documents, seed-42 shuffled within.
  const rand = mulberry32(SEED);
  const byDoc = new Map<string, Cand[]>();
  for (const c of resolvable) {
    const list = byDoc.get(c.doc) ?? [];
    list.push(c);
    byDoc.set(c.doc, list);
  }
  for (const list of byDoc.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
  }
  const sampled: Cand[] = [];
  const docIds = [...byDoc.keys()].sort();
  let progress = true;
  while (sampled.length < MAX_RESOLVABLE && progress) {
    progress = false;
    for (const doc of docIds) {
      const list = byDoc.get(doc)!;
      if (list.length && sampled.length < MAX_RESOLVABLE) {
        sampled.push(list.shift()!);
        progress = true;
      }
    }
  }
  // Hard negatives: seed-42 sample, capped.
  const negs = [...negatives];
  for (let i = negs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [negs[i], negs[j]] = [negs[j]!, negs[i]!];
  }
  const sampledNeg = negs.slice(0, MAX_NEG);
  interface Packet {
    id: string;
    doc: string;
    desc: string;
    context: string;
    candidates: string[];
  }
  interface Label {
    id: string;
    answer: string;
  }
  const packets: Packet[] = [];
  const labels: Record<string, string> = {};
  const emit = (list: Cand[], prefix: string): void => {
    list.forEach((c, i) => {
      const id = `${prefix}${i + 1}`;
      packets.push({
        id,
        doc: c.doc,
        desc: c.desc,
        context: c.context,
        candidates: docCharacters.get(c.doc) ?? ['nobody'],
      });
      labels[id] = c.answer;
    });
  };
  emit(sampled, 'r');
  emit(sampledNeg, 'n');
  mkdirSync(TRACK, { recursive: true });
  writeFileSync(
    `${TRACK}/pool.json`,
    JSON.stringify(
      {
        resolvable: resolvable.length,
        documents: perDocResolvable.size,
        negatives: negatives.length,
        candidateSizes: {
          n: candidateSizes.length,
          min: Math.min(...candidateSizes),
          max: Math.max(...candidateSizes),
          mean: Number((candidateSizes.reduce((a, b) => a + b, 0) / Math.max(1, candidateSizes.length)).toFixed(1)),
        },
      },
      null,
      1,
    ),
  );
  console.log(`sample: resolvable ${sampled.length} negatives ${sampledNeg.length}`);
  mkdirSync(TRACK, { recursive: true });
  writeFileSync(`${TRACK}/packets.json`, JSON.stringify({ seed: SEED, n: packets.length, packets }, null, 1));
  writeFileSync(
    `${TRACK}/labels.json`,
    JSON.stringify({ resolvable: sampled.length, negatives: sampledNeg.length, labels }, null, 1),
  );
  console.log(`packets: ${packets.length} (labels held separately)`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('build.ts')) {
  try {
    build();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
