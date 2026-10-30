/**
 * Emit a chain handoff file from a banked project, in the shared language.
 *
 * A walk calls this once at the end of its run (or a later run calls it for
 * an existing bank). It reads the bank read-only and writes one JSON file
 * the next read opens: windows in read order, thin names + where they
 * appear, banked pairs with quote + place + flag. No model calls, no
 * database writes. Garbage never survives: the shared builder drops it.
 *
 * Usage:
 *   node --no-warnings testing/trials/chain/emit-handoff.ts <bank-name> <run> <out-path>
 */

import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { buildHandoff, type ChainHandoff } from './chain-handoff.ts';

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s: string): string[] => norm(s).split(' ').filter((t) => t.length >= 3);

export function emitHandoff(dbPath: string, bankName: string, run: string, outPath: string): ChainHandoff {
  const db = new Db(dbPath);
  try {
    const bank = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', bankName);
    if (!bank) throw new Error(`no bank named "${bankName}"`);

    // Windows in the order they were read (bank seq order, 8 chunks each).
    const chunks = db.all<{ seq: number; locator: string; text: string }>(
      'SELECT seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
      bank.id,
    );
    const windows: number[] = [];
    const seenWin = new Set<number>();
    for (const c of chunks) {
      const w = Math.floor(c.seq / 8);
      if (!seenWin.has(w)) {
        seenWin.add(w);
        windows.push(w);
      }
    }
    const winText = new Map<number, string>();
    for (const c of chunks) {
      const w = Math.floor(c.seq / 8);
      winText.set(w, `${winText.get(w) ?? ''}\n${c.text}`);
    }

    const entities = db.all<{ id: number; name: string; kind: string; mentions: number }>(
      'SELECT id, name, kind, mentions FROM canon_entity WHERE project_id = ?',
      bank.id,
    );
    const tieCount = new Map<number, number>();
    for (const r of db.all<{ from_entity: number; to_entity: number }>(
      'SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?',
      bank.id,
    )) {
      tieCount.set(r.from_entity, (tieCount.get(r.from_entity) ?? 0) + 1);
      tieCount.set(r.to_entity, (tieCount.get(r.to_entity) ?? 0) + 1);
    }

    // Thin names: characters with no ties, plus where they show in this bank.
    const thin: { name: string; windows: number[]; mentions: number; ties: number }[] = [];
    for (const e of entities) {
      if (e.kind !== 'character') continue;
      if ((tieCount.get(e.id) ?? 0) > 0) continue;
      const et = new Set(toks(e.name));
      if (!et.size) continue;
      const hits: number[] = [];
      for (const [w, text] of winText) {
        const words = new Set(norm(text).split(' '));
        if ([...et].some((t) => words.has(t))) hits.push(w);
      }
      if (hits.length) thin.push({ name: e.name, windows: hits.sort((a, b) => a - b), mentions: e.mentions ?? 0, ties: 0 });
    }

    // Banked pairs with full context: label + sentence + quote + place + flag.
    const chunkSeq = new Map<number, { seq: number; locator: string }>();
    for (const c of db.all<{ id: number; seq: number; locator: string }>(
      'SELECT id, seq, locator FROM canon_chunk WHERE project_id = ?',
      bank.id,
    )) {
      chunkSeq.set(c.id, { seq: c.seq, locator: c.locator });
    }
    const firstChunkOf = (refs: string): number | undefined => {
      try {
        const arr = JSON.parse(refs) as { chunk?: number }[];
        for (const r of arr) if (typeof r.chunk === 'number') return r.chunk;
      } catch {
        /* unparseable refs: place unknown */
      }
      return undefined;
    };
    const pairs: {
      from: string; to: string; label: string; sentence: string; quote: string;
      locator: string; chunkSeq: number | null; review: 'accepted' | 'needs_review';
    }[] = [];
    for (const r of db.all<{
      kind: string; description: string; evidence: string; source_refs: string;
      review_status: string; f: string; t: string;
    }>(
      `SELECT r.kind, r.description, r.evidence, r.source_refs, r.review_status,
              fe.name AS f, te.name AS t
       FROM canon_relation r
       JOIN canon_entity fe ON fe.id = r.from_entity
       JOIN canon_entity te ON te.id = r.to_entity
       WHERE r.project_id = ? ORDER BY r.id`,
      bank.id,
    )) {
      const chunkId = firstChunkOf(r.source_refs);
      const place = chunkId !== undefined ? chunkSeq.get(chunkId) : undefined;
      pairs.push({
        from: r.f,
        to: r.t,
        label: r.kind,
        sentence: r.description ?? '',
        quote: r.evidence ?? '',
        locator: place?.locator ?? '',
        chunkSeq: place ? place.seq : null,
        review: r.review_status === 'needs_review' ? 'needs_review' : 'accepted',
      });
    }

    const { handoff } = buildHandoff({ run, windows, thin, pairs });
    writeFileSync(outPath, JSON.stringify(handoff, null, 2));
    return handoff;
  } finally {
    db.close();
  }
}

const [bankName, run, outPath] = process.argv.slice(2);
if (process.argv[1]?.endsWith('emit-handoff.ts') && (!bankName || !run || !outPath)) {
  throw new Error('usage: emit-handoff.ts <bank-name> <run> <out-path>');
}
if (process.argv[1]?.endsWith('emit-handoff.ts') && bankName && run && outPath) {
  const h = emitHandoff(
    '/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db',
    bankName,
    run,
    outPath,
  );
  console.log(`handoff: ${h.windows.length} windows, ${h.thin.length} thin, ${h.pairs.length} pairs -> ${outPath}`);
}
