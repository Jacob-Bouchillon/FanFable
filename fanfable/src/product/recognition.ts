/**
 * Recognition filter for dense PPR seeds.
 *
 * Dense seeds are resemblance without lexical backing: the query says
 * "sibling" and a triple says "brother", so cosine fires even when the
 * passage behind the triple says nothing about siblings. Before PPR spreads
 * those scores everywhere, each dense-only seed is checked against its own
 * passage text with one cheap batched yes/no call. Lexical seeds are never
 * filtered — what the query names outranks what it resembles.
 *
 * The filter judges support, not truth: a passage that states the relation
 * keeps its seed even if the book is wrong about the world. Canon is the
 * book, not the world. Anything uncertain stays: a dropped seed is one the
 * text contradicts or ignores, never one the model is unsure about, and any
 * error keeps every seed (fail-open).
 */
import { Db } from '../core/db.ts';
import { extractJson } from '../core/json.ts';
import type { LlmClient } from '../core/llm.ts';
import { truncate } from '../core/text.ts';
import type { DenseSeed, Graph } from '../graph.ts';

export interface RecognitionOptions {
  /** The query the seeds serve: the model judges support for this. */
  query?: string;
  /** Most seeds checked in the single call. Default 10. */
  maxSeeds?: number;
  /** Token budget for the single call. Default 400. */
  maxTokens?: number;
  /** Ids with lexical backing: auto-kept, never sent to the model. */
  lexicalIds?: ReadonlySet<string>;
}

export interface SeedVerdict {
  id: string;
  reason: string;
}

export interface FilterResult {
  kept: SeedVerdict[];
  dropped: SeedVerdict[];
  /** Seeds actually judged by the model (the rest were auto-kept). */
  checked: number;
}

const RECOGNIZE_SYSTEM =
  'For each candidate state supported:true/false with the candidate id. ' +
  'Supported means the passage text states or directly implies the relation/fact; ' +
  'resemblance of words is not support. ' +
  'Reply JSON only: {results:[{id, supported}]}.';

/** The passage text behind a chunk id, or undefined when it is gone. */
function chunkText(db: Db, projectId: number, chunkId: number): string | undefined {
  try {
    return db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ? AND project_id = ?', chunkId, projectId)
      ?.text;
  } catch {
    return undefined;
  }
}

/**
 * What the model judges a seed against: the seed's own evidence plus the
 * passages behind it. Passage seeds are judged against their chunk text.
 */
function seedEvidence(db: Db, projectId: number, graph: Graph, id: string): { label: string; evidence: string } {
  const node = graph.nodes.get(id);
  if (!node) {
    const edge = graph.edges.find((e) => e.id === id);
    if (!edge) return { label: id, evidence: '' };
    const from = graph.nodes.get(edge.from)?.name ?? edge.from;
    const to = graph.nodes.get(edge.to)?.name ?? edge.to;
    return {
      label: `${from} --${edge.type}--> ${to}`,
      evidence: [edge.description, edge.evidence].filter(Boolean).join('\n'),
    };
  }
  if (node.kind === 'canon-passage') {
    const text = chunkText(db, projectId, node.numericId) ?? String(node.extra?.text ?? '');
    return { label: `${node.name} (passage)`, evidence: truncate(text, 600) };
  }
  const parts: string[] = [];
  if (node.evidence) parts.push(`Stated: ${node.evidence}`);
  if (node.summary) parts.push(`Recorded: ${truncate(node.summary, 300)}`);
  let shown = 0;
  for (const ref of node.sourceRefs) {
    if (shown >= 2) break;
    if (typeof ref.chunk !== 'number') continue;
    const text = chunkText(db, projectId, ref.chunk);
    if (!text) continue;
    parts.push(`Passage (${ref.locator || ref.chunk}): ${truncate(text, 600)}`);
    shown++;
  }
  return { label: `${node.name} [${node.kind}]`, evidence: parts.join('\n') };
}

interface ResultItem {
  id?: unknown;
  supported?: unknown;
}

/** Verdicts the model actually stated, id -> supported. */
function statedVerdicts(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const take = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = raw as ResultItem;
      if (typeof item?.id === 'string' && typeof item.supported === 'boolean' && !out.has(item.id)) {
        out.set(item.id, item.supported);
      }
    }
  };
  const parsed = extractJson<{ results?: unknown }>(text);
  take(parsed?.results);
  // A truncated answer may still hold well-formed items past the parse
  // point; salvage each object on its own. Seeds left without any verdict
  // stay kept (fail-open).
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      take([JSON.parse(match[0])]);
    } catch {
      /* a fragment is not a verdict */
    }
  }
  return out;
}

/**
 * Check dense-only seeds against their passage text in one model call.
 *
 * Returns every seed either kept or dropped. Dropped means the model said
 * the text does not support it; everything else — lexical ids, over-cap
 * seeds, unparseable verdicts, any error at all — stays kept.
 */
export async function filterDenseSeeds(
  llm: LlmClient,
  seeds: DenseSeed[],
  graph: Graph,
  db: Db,
  projectId: number,
  opts: RecognitionOptions = {},
): Promise<FilterResult> {
  const kept: SeedVerdict[] = [];
  const dropped: SeedVerdict[] = [];
  const lexical = opts.lexicalIds;
  const checkable = seeds.filter((s) => !(lexical && lexical.has(s.id)));
  for (const s of seeds) {
    if (lexical && lexical.has(s.id)) kept.push({ id: s.id, reason: 'lexical' });
  }
  const maxSeeds = opts.maxSeeds ?? 10;
  const batch = checkable.slice(0, Math.max(0, maxSeeds));
  for (const s of checkable.slice(batch.length)) kept.push({ id: s.id, reason: 'over-cap' });
  if (!batch.length) return { kept, dropped, checked: 0 };

  let verdicts: Map<string, boolean>;
  try {
    const candidates = batch
      .map((s) => {
        const { label, evidence } = seedEvidence(db, projectId, graph, s.id);
        return `[id: ${s.id}] ${label}\n${evidence || '(no evidence recorded)'}`;
      })
      .join('\n\n');
    const content = opts.query ? `Query: ${opts.query}\n\n${candidates}` : candidates;
    const res = await llm.chat({
      system: RECOGNIZE_SYSTEM,
      messages: [{ role: 'user', content }],
      temperature: 0.0,
      maxTokens: opts.maxTokens ?? 400,
    });
    verdicts = statedVerdicts(res.text);
  } catch {
    for (const s of batch) kept.push({ id: s.id, reason: 'filter-error' });
    return { kept, dropped, checked: 0 };
  }

  for (const s of batch) {
    const v = verdicts.get(s.id);
    if (v === false) dropped.push({ id: s.id, reason: 'unsupported' });
    else kept.push({ id: s.id, reason: v === true ? 'supported' : 'fail-open' });
  }
  return { kept, dropped, checked: batch.length };
}
