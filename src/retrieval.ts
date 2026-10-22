/**
 * Unified retrieval.
 *
 * The old pipeline answered a question with passages, and answered "what does
 * this character know" with a text filter on the character's name. That finds
 * what is *mentioned*; it does not find what is *connected*.
 *
 * This service combines the two:
 *
 *   - passages found through FTS5 (existing search, unchanged)
 *   - graph entities, events, facts and relationships found by traversal
 *   - the source passages that substantiate those graph claims
 *   - the story's own approved events, knowledge and memory
 *
 * The result is one compact package, ranked, de-duplicated and inside a word
 * budget, ready to drop into a prompt. The interface leaves room for a vector
 * index later: `RetrievalPackage` is what the rest of the program consumes,
 * not a particular search backend.
 */
import { Db } from './db.ts';
import type { LlmClient } from './llm.ts';
import * as lore from './lore.ts';
import * as graph from './graph.ts';
import { truncate } from './text.ts';

export interface RetrievalRequest {
  /** The question or the scene's subject. */
  query?: string;
  /** Names the scene is about: characters, places, objects. */
  focus?: string[];
  scope?: graph.GraphScope;
  /** How many edges away to walk. One or two is the useful range. */
  hops?: number;
  /** Maximum number of passages. */
  passageLimit?: number;
  /** Total word budget for the assembled text. */
  maxWords?: number;
  /** Anchor for the story-relative timeline. */
  atEventId?: number;
  /** Include the source passages behind the graph claims. */
  includePassages?: boolean;
  includeGraph?: boolean;
  /** Skip the model call that expands the query. */
  skipExpansion?: boolean;
}

export interface RetrievalPackage {
  passages: lore.Passage[];
  graph: graph.GraphContext;
  text: string;
  stats: {
    passages: number;
    graphNodes: number;
    graphEdges: number;
    supportingPassages: number;
    words: number;
    truncated: boolean;
  };
}

/**
 * Retrieve everything relevant to a scene, from text and graph alike.
 */
export async function retrieve(
  db: Db,
  llm: LlmClient,
  projectId: number,
  req: RetrievalRequest = {},
): Promise<RetrievalPackage> {
  const passageLimit = req.passageLimit ?? 6;
  // The package has to hold passages, connections and evidence, so it needs
  // more room than a passage list alone.
  const maxWords = req.maxWords ?? 1600;
  const focus = (req.focus ?? []).filter(Boolean);
  const query = req.query ?? '';

  /* ------------------------------------------------- passages (FTS5) */
  const searchTerms = [query, ...focus].filter(Boolean).join(' ');
  let passages: lore.Passage[] = [];
  if (searchTerms) {
    const expand = req.skipExpansion ? [] : await lore.expandQuery(llm, searchTerms);
    passages = lore.searchCanon(db, projectId, searchTerms, {
      limit: passageLimit,
      expand,
    });
  }

  /* --------------------------------------------- graph (connected context) */
  let graphContext: graph.GraphContext = {
    nodes: [],
    edges: [],
    passages: [],
    text: '',
    truncated: false,
    stats: { nodes: 0, edges: 0, passages: 0, words: 0 },
  };
  if (req.includeGraph !== false) {
    graphContext = graph.buildGraphContext(db, projectId, {
      query,
      focus: focus.length ? focus : graph.terms(query).slice(0, 3),
      hops: req.hops ?? 1,
      scope: req.scope,
      atEventId: req.atEventId,
      // A two-hop walk needs room: the answer is often at the far end.
      maxNodes: (req.hops ?? 1) > 1 ? 70 : 45,
      maxWords: Math.round(maxWords * 0.70),
    });
  }

  /* ------------------------- the passages that back the graph's claims */
  const supporting: lore.Passage[] = [];
  if (req.includePassages !== false) {
    for (const p of graphContext.passages) {
      const found = passages.find((x) => x.chunkId === p.chunkId);
      if (found) continue;
      const chunk = lore.getChunk(db, p.chunkId);
      if (chunk) {
        supporting.push(chunk);
        passages.push(chunk);
      }
    }
  }

  /* ------------------------------------------- rank, de-duplicate, budget */
  const seenChunks = new Set<number>();
  const deduped: lore.Passage[] = [];
  for (const p of passages) {
    if (seenChunks.has(p.chunkId)) continue;
    seenChunks.add(p.chunkId);
    deduped.push(p);
  }

  const passageBudget = Math.round(maxWords * 0.30);
  const keptPassages: lore.Passage[] = [];
  let used = 0;
  for (const p of deduped) {
    const words = p.text.split(/\s+/).length;
    if (used + words > passageBudget && keptPassages.length) break;
    keptPassages.push(p);
    used += words;
  }

  // The graph context was already rendered inside its own budget, so it is
  // used as it is; a second trim here would cut the connections off.
  const trimmedGraph = graphContext.text;

  const parts: string[] = [];
  if (keptPassages.length) {
    parts.push(
      'CANON EVIDENCE (use these for facts and wording; do not copy the sentences):\n' +
        lore.formatPassages(keptPassages),
    );
  }
  if (trimmedGraph.trim()) {
    parts.push(`CONNECTED CONTEXT (what this scene touches, and how):\n${trimmedGraph.trim()}`);
  }

  const text = parts.join('\n\n');
  const finalWords = text.split(/\s+/).length;

  return {
    passages: keptPassages,
    graph: graphContext,
    text,
    stats: {
      passages: keptPassages.length,
      graphNodes: graphContext.nodes.length,
      graphEdges: graphContext.edges.length,
      supportingPassages: supporting.length,
      words: finalWords,
      truncated: graphContext.truncated || finalWords > maxWords,
    },
  };
}

/**
 * The retrieval used for a chapter: canon evidence, connected canon, and the
 * story's own memory, all inside one budget.
 */
export async function retrieveForScene(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: {
    focus: string[];
    query?: string;
    atEventId?: number;
    maxWords?: number;
    hops?: number;
  },
): Promise<RetrievalPackage> {
  return retrieve(db, llm, projectId, {
    focus: opts.focus,
    query: opts.query,
    atEventId: opts.atEventId,
    maxWords: opts.maxWords ?? 1600,
    hops: opts.hops ?? 1,
  });
}

/** A short, plain summary of a package, for logs and the interface. */
export function describePackage(pkg: RetrievalPackage): string {
  return [
    `${pkg.stats.passages} passages`,
    `${pkg.stats.graphNodes} graph nodes`,
    `${pkg.stats.graphEdges} connections`,
    `${pkg.stats.words} words`,
  ].join(', ');
}

export { truncate };
