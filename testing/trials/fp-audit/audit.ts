/**
 * False-positive audit of the 90 newly moved rows (34 attested + 56 accepted).
 *
 * Trial-only, read-only. Step `mech` re-verifies every row component-wise
 * (cited chunk exists, strict + audit verbatim, endpoints in scope per grade,
 * distinct identities, anchor where required, tie-word presence, gate
 * agreement) and runs the identity-pollution check (no same-person pairs, no
 * species-as-character). Steps `sample`/`judge` blind-judge a seed-42
 * stratified 45 (25 accepted + 20 attested) with qwen3.5:9b — never the
 * assessor of these rows — verdict supported / co-presence-only / wrong-kind
 * / wrong-direction / cannot-tell. Step `score` writes the scorecard.
 * Nothing here writes, demotes, or banks: flags are reported, never fixed.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/fp-audit/audit.ts [mech|sample|judge|score|all]
 *
 * Writes only under testing/trials/fp-audit/out/ (gitignored). The bank is
 * opened read-only and never written. The judge step refuses to run while a
 * non-qwen model is resident (one model at a time; never evict blindly).
 * Reports print counts only, never passage prose, quotes, or names.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../../../fanfable/src/core/db.ts';
import {
  mentionSpans,
  citationWords,
} from '../../../fanfable/src/gates/gates.ts';
import { canonicalName, nameRelation } from '../../../fanfable/src/identity/names.ts';
import { canPromoteRelation } from '../../../fanfable/src/lorebook.ts';

const TRACK = 'testing/trials/fp-audit';
const OUT_DIR = `${TRACK}/out`;
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const PROJECT = 'halfbook';
const SLATE = 'testing/trials/combine/factory-slate.json';

const QWEN = 'qwen3.5:9b';
const OLLAMA = 'http://127.0.0.1:11434';
const SEED = 42;

function fail(message: string): never {
  throw new Error(`fp-audit: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(resolve(LIVE));
  return { main: `${st.size}:${st.mtimeMs}` };
}

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

interface Row {
  id: number;
  grade: 'attested' | 'accepted';
  fromId: number;
  toId: number;
  kind: string;
  evidence: string;
  sourceRefs: string;
  kindSource: string;
  anchorEvidence: string;
  fromName: string;
  fromAliases: string;
  toName: string;
  toAliases: string;
  fromKind: string;
  toKind: string;
  status: string;
}

function loadBatch(): { rows: Row[]; batch: string } {
  const slate = JSON.parse(readFileSync(SLATE, 'utf8')) as {
    newAttestedIds: number[];
    newAcceptedIds: number[];
  };
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const ids = [...slate.newAttestedIds, ...slate.newAcceptedIds];
    const rows: Row[] = [];
    for (const id of ids) {
      const row = db.prepare(
        `SELECT r.id, r.from_entity AS fromId, r.to_entity AS toId, r.kind, r.evidence,
                r.source_refs AS sourceRefs, r.kind_source AS kindSource,
                r.anchor_evidence AS anchorEvidence, r.review_status AS status,
                a.name AS fromName, a.aliases AS fromAliases, a.kind AS fromKind,
                b.name AS toName, b.aliases AS toAliases, b.kind AS toKind
           FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity
          WHERE r.project_id = ? AND r.id = ?`,
      ).get(project.id, id) as Row | undefined;
      if (!row) fail(`batch row ${id} missing from live bank`);
      rows.push({
        ...row,
        grade: slate.newAttestedIds.includes(id) ? 'attested' : 'accepted',
      });
    }
    return { rows, batch: `factory 34 attested + 56 accepted (${ids.length} rows)` };
  } finally {
    db.close();
  }
}

const strList = (json: string): string[] => {
  try {
    const list = JSON.parse(json || '[]') as unknown[];
    return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

export function mech(): Record<string, unknown> {
  const before = dbStat();
  const { rows, batch } = loadBatch();
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  const dbLike = {
    all: <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: unknown[]): T | undefined => db.prepare(sql).get(...params) as T | undefined,
    run: (): never => {
      throw new Error('fp-audit: writes disabled');
    },
  };
  const fails: Record<string, number> = {};
  const failingIds: number[] = [];
  const gateDisagree: number[] = [];
  const identityViolations: number[] = [];
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    for (const row of rows) {
      const bad: string[] = [];
      // Cited chunk exists.
      let chunkId = 0;
      let chunkText: string | null = null;
      try {
        const refs = JSON.parse(row.sourceRefs || '[]') as { chunk?: unknown }[];
        const found = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0);
        if (found) {
          chunkId = Number(found.chunk);
          const crow = db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(chunkId) as
            | { text: string }
            | undefined;
          chunkText = crow?.text ?? null;
        }
      } catch {
        chunkText = null;
      }
      if (!chunkId || !chunkText) bad.push('no-chunk');
      const quote = String(row.evidence ?? '').trim();
      // Strict verbatim.
      if (!quote || !chunkText || !chunkText.includes(quote)) bad.push('strict-verbatim');
      // Audit (word-level) verbatim, mirroring the demote rule.
      const wordNorm = (s: string): string =>
        String(s ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9' ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      if (!quote || !chunkText || !wordNorm(chunkText).includes(wordNorm(quote))) {
        bad.push('audit-verbatim');
      }
      // Endpoints in scope per grade.
      const fromSpans = mentionSpans(quote, row.fromName, strList(row.fromAliases));
      const toSpans = mentionSpans(quote, row.toName, strList(row.toAliases));
      if (row.grade === 'accepted') {
        if (!fromSpans.length || !toSpans.length) bad.push('endpoint-scope');
      } else {
        const inChunk = (name: string, aliases: string[]): boolean =>
          mentionSpans(chunkText ?? '', name, aliases).length > 0;
        if (!inChunk(row.fromName, strList(row.fromAliases)) || !inChunk(row.toName, strList(row.toAliases))) {
          bad.push('endpoint-scope');
        }
      }
      // Distinct identities: ids differ, names neither same nor nested.
      if (row.fromId === row.toId) bad.push('same-id');
      else {
        const rel =
          nameRelation(canonicalName(row.fromName), canonicalName(row.toName)) ??
          nameRelation(canonicalName(row.toName), canonicalName(row.fromName));
        if (rel === 'same' || rel === 'containment') bad.push('name-identity');
        const shared = strList(row.fromAliases).some((a) =>
          strList(row.toAliases).some((b) => canonicalName(a) === canonicalName(b) && canonicalName(a).length > 0),
        );
        if (shared) bad.push('shared-alias');
      }
      // Species-as-character: both endpoints must be persons.
      if (row.fromKind !== 'character' || row.toKind !== 'character') bad.push('non-person-endpoint');
      // Anchor where required: an accepted quote naming fewer than two
      // endpoints must lean on a stored anchor sentence.
      if (row.grade === 'accepted' && (!fromSpans.length || !toSpans.length) && !row.anchorEvidence.trim()) {
        bad.push('anchor-missing');
      }
      // Tie word: the citation must carry non-name words for the kind.
      const cited = citationWords(
        row.kindSource || row.evidence,
        row.kind,
        row.fromName,
        strList(row.fromAliases),
        row.toName,
        strList(row.toAliases),
      ).filter((w) => w.length >= 3);
      if (!cited.length) bad.push('tie-word-absent');
      // Gate agreement (sentence-proof standard, read-only).
      const decision = canPromoteRelation(dbLike as unknown as Db, project.id, row.id);
      if (row.grade === 'accepted' && !decision.ok) gateDisagree.push(row.id);
      // Identity pollution roll-up.
      if (bad.some((b) => ['same-id', 'name-identity', 'shared-alias', 'non-person-endpoint'].includes(b))) {
        identityViolations.push(row.id);
      }
      for (const b of bad) {
        fails[b] = (fails[b] ?? 0) + 1;
      }
      if (bad.length) failingIds.push(row.id);
    }
    const out = {
      batch,
      n: rows.length,
      pass: rows.length - failingIds.length,
      fails,
      failingIds,
      gateDisagreeAccepted: gateDisagree,
      identityViolations,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/mech.json`, JSON.stringify(out, null, 1));
    console.log(`mech: n ${rows.length} pass ${out.pass} fails ${JSON.stringify(fails)}`);
    console.log(`mech: gate-disagree ${gateDisagree.length} identity-violations ${identityViolations.length}`);
    return out;
  } finally {
    db.close();
  }
}

export function sample(): void {
  const { rows } = loadBatch();
  const rand = mulberry32(SEED);
  const pick = (list: Row[], n: number): Row[] => {
    const pool = [...list];
    const out: Row[] = [];
    while (pool.length && out.length < n) {
      out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
    }
    return out;
  };
  const sampled = [
    ...pick(rows.filter((r) => r.grade === 'accepted'), 25),
    ...pick(rows.filter((r) => r.grade === 'attested'), 20),
  ];
  if (sampled.length !== 45) fail(`sampled ${sampled.length}, need 45`);
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  try {
    const packets = sampled.map((row) => {
      let chunkText = '';
      try {
        const refs = JSON.parse(row.sourceRefs || '[]') as { chunk?: unknown }[];
        const found = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0);
        if (found) {
          chunkText =
            (db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(Number(found.chunk)) as
              | { text: string }
              | undefined)?.text ?? '';
        }
      } catch {
        chunkText = '';
      }
      return {
        id: row.id,
        pair: [row.fromName, row.toName],
        kind: row.kind,
        quote: row.evidence,
        passage: chunkText,
      };
    });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/packets.json`, JSON.stringify({ seed: SEED, n: packets.length, packets }, null, 1));
    console.log(`sample: seed ${SEED} n ${packets.length} (25 accepted + 20 attested)`);
  } finally {
    db.close();
  }
}

export type BlindVerdict = 'supported' | 'co-presence-only' | 'wrong-kind' | 'wrong-direction' | 'cannot-tell';

function twelveWords(reason: string): string {
  return String(reason ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
}

/** First parseable JSON block wins; greedy spans across prose do not. */
export function parseVerdict(raw: string): { verdict: BlindVerdict | null; reason: string } {
  const blocks = raw.match(/\{[^{}]*\}/g) ?? [];
  const greedy = raw.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) blocks.push(greedy);
  for (const block of blocks) {
    try {
      const obj = JSON.parse(block) as { verdict?: string; reason?: string };
      const v = String(obj.verdict ?? '').toLowerCase();
      if (
        v === 'supported' ||
        v === 'co-presence-only' ||
        v === 'wrong-kind' ||
        v === 'wrong-direction' ||
        v === 'cannot-tell'
      ) {
        return { verdict: v, reason: String(obj.reason ?? '') };
      }
    } catch {
      /* try the next block */
    }
  }
  return { verdict: null, reason: '' };
}

async function chat(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      // qwen3.5 thinks out loud and its thinking eats the output budget
      // (empty content + done_reason length); grading needs the answer only.
      think: false,
      options: { temperature: 0, seed: SEED },
    }),
  });
  if (!res.ok) fail(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return (data.message?.content ?? '').trim();
}

export async function judge(): Promise<void> {
  // One model at a time: refuse when anything but the judge is resident.
  const ps = spawnSync('ollama', ['ps'], { encoding: 'utf8' });
  const lines = String(ps.stdout ?? '').split('\n').slice(1).filter((l) => l.trim().length > 0);
  const foreign = lines.filter((l) => !l.startsWith(QWEN));
  if (foreign.length) {
    fail(`non-judge model resident (${foreign.length} row(s)) — unload first, never evict blindly`);
  }
  const packetsPath = `${OUT_DIR}/packets.json`;
  if (!existsSync(packetsPath)) fail(`no ${packetsPath} (run sample first)`);
  const { packets } = JSON.parse(readFileSync(packetsPath, 'utf8')) as {
    packets: { id: number; pair: [string, string]; kind: string; quote: string; passage: string }[];
  };
  try {
    const tags = await fetch(`${OLLAMA}/api/tags`);
    if (!tags.ok) fail(`ollama tags ${tags.status}`);
  } catch (err) {
    fail(`ollama unreachable: ${(err as Error).message}`);
  }
  const results: { id: number; verdict: BlindVerdict; reason: string; unparsable: boolean }[] = [];
  let n = 0;
  for (const packet of packets) {
    const prompt =
      `You are grading a claimed relationship from a novel. Pair: "${packet.pair[0]}" / "${packet.pair[1]}". ` +
      `Claimed kind: "${packet.kind}". Quote: "${packet.quote}". Passage: "${packet.passage}". ` +
      `Reply with JSON only: {"verdict": "supported" | "co-presence-only" | "wrong-kind" | "wrong-direction" | "cannot-tell", ` +
      `"reason": "<at most 12 words>"}. supported = the passage states this tie between them; ` +
      `co-presence-only = they co-occur with no tie stated; wrong-kind = a tie is stated but not this kind; ` +
      `wrong-direction = the tie runs the other way; cannot-tell = undecidable from this passage alone.`;
    let raw = '';
    try {
      raw = await chat(prompt);
    } catch (err) {
      fail(`ollama call failed at packet ${packet.id}: ${(err as Error).message}`);
    }
    let verdict: BlindVerdict = 'cannot-tell';
    let reason = '';
    let unparsable = false;
    const parsed = parseVerdict(raw);
    if (parsed.verdict === null) {
      unparsable = true;
    } else {
      verdict = parsed.verdict;
      reason = parsed.reason;
    }
    results.push({ id: packet.id, verdict, reason: twelveWords(reason), unparsable });
    n++;
    if (n % 10 === 0) process.stderr.write(`${n}/${packets.length}\n`);
  }
  writeFileSync(`${OUT_DIR}/verdicts.json`, JSON.stringify({ model: QWEN, temp: 0, seed: SEED, results }, null, 1));
  const counts = (v: BlindVerdict): number => results.filter((r) => r.verdict === v).length;
  console.log(
    `judge: model ${QWEN} n ${results.length} supported ${counts('supported')} ` +
      `co-presence ${counts('co-presence-only')} wrong-kind ${counts('wrong-kind')} ` +
      `wrong-direction ${counts('wrong-direction')} cannot-tell ${counts('cannot-tell')} ` +
      `unparsable ${results.filter((r) => r.unparsable).length}`,
  );
}

/** Wilson 95% interval for k/n. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const round3 = (x: number): number => Number(x.toFixed(3));
  return { p: round3(p), lo: round3(Math.max(0, center - half)), hi: round3(Math.min(1, center + half)) };
}

export function score(): Record<string, unknown> {
  const before = dbStat();
  const mechData = JSON.parse(readFileSync(`${OUT_DIR}/mech.json`, 'utf8')) as {
    n: number;
    pass: number;
    fails: Record<string, number>;
  };
  const { results } = JSON.parse(readFileSync(`${OUT_DIR}/verdicts.json`, 'utf8')) as {
    results: { id: number; verdict: BlindVerdict }[];
  };
  const { packets } = JSON.parse(readFileSync(`${OUT_DIR}/packets.json`, 'utf8')) as {
    packets: { id: number }[];
  };
  if (results.length !== packets.length) fail('verdict/packet count mismatch');
  const byId = new Map(results.map((r) => [r.id, r.verdict]));
  for (const p of packets) {
    if (!byId.has(p.id)) fail(`no verdict for packet ${p.id}`);
  }
  const supported = results.filter((r) => r.verdict === 'supported').length;
  const overall = wilson(supported, results.length);
  const split = (ids: number[]): { n: number; supported: number } => {
    const rows = results.filter((r) => ids.includes(r.id));
    return { n: rows.length, supported: rows.filter((r) => r.verdict === 'supported').length };
  };
  const slate = JSON.parse(readFileSync(SLATE, 'utf8')) as { newAttestedIds: number[]; newAcceptedIds: number[] };
  const attested = split(slate.newAttestedIds);
  const accepted = split(slate.newAcceptedIds);
  const attestedW = wilson(attested.supported, attested.n);
  const acceptedW = wilson(accepted.supported, accepted.n);
  const rate = overall.p;
  const verdict = rate >= 0.8 ? 'SAFE' : rate >= 0.6 ? 'MIXED' : 'BAD';
  const manifest = {
    mech: mechData,
    blind: {
      model: QWEN,
      n: results.length,
      supported,
      byVerdict: {
        supported,
        'co-presence-only': results.filter((r) => r.verdict === 'co-presence-only').length,
        'wrong-kind': results.filter((r) => r.verdict === 'wrong-kind').length,
        'wrong-direction': results.filter((r) => r.verdict === 'wrong-direction').length,
        'cannot-tell': results.filter((r) => r.verdict === 'cannot-tell').length,
      },
      precision: overall.p,
      wilsonLow: overall.lo,
      wilsonHigh: overall.hi,
      attested: { ...attested, ...attestedW },
      accepted: { ...accepted, ...acceptedW },
    },
    verdict,
    demoteNote:
      verdict === 'BAD'
        ? 'batch below 60%: recommend demote via the committed demote path, dry-run only (not executed)'
        : 'no demote action',
    reviewStatus: 'Nothing banks, nothing demotes here — flags reported, never fixed',
    dbUntouched: dbStat(),
    dbBefore: before,
  };
  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
  const after = dbStat();
  if (after.main !== before.main) fail('bank moved during scoring');
  console.log(`score: supported ${supported}/${results.length} precision ${overall.p} (${overall.lo}-${overall.hi})`);
  console.log(`score: attested ${attested.supported}/${attested.n} accepted ${accepted.supported}/${accepted.n}`);
  console.log(`verdict: ${verdict}`);
  return manifest;
}

async function main(argv: string[]): Promise<void> {
  const step = argv[0] ?? 'all';
  if (step === 'mech') mech();
  else if (step === 'sample') sample();
  else if (step === 'judge') await judge();
  else if (step === 'score') score();
  else if (step === 'all') {
    mech();
    sample();
    await judge();
    score();
  } else fail(`unknown step "${step}"`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('audit.ts')) {
  mkdirSync(OUT_DIR, { recursive: true });
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
