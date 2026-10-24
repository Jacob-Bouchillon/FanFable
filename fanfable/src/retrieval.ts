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
 * Phase 1 adds a router. Every query used to pay for a model call to expand it
 * and a graph walk it did not need; on an 8GB machine that latency is the
 * difference between usable and not. A fact lookup now goes to FTS5 alone, a
 * relational question is seeded from the relation it names, and only a vague
 * query falls back to expansion-first.
 *
 * The result is one compact package, ranked, de-duplicated and inside a word
 * budget, ready to drop into a prompt. The interface leaves room for a vector
 * index later: `RetrievalPackage` is what the rest of the program consumes,
 * not a particular search backend.
 */
import { Db } from './db.ts';
import type { LlmClient } from './llm.ts';
import * as lore from './lore.ts';
import * as lorebook from './lorebook.ts';
import * as embeddings from './embeddings.ts';
import * as graph from './graph.ts';

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
  /** Override the router. Used by tests and by a caller that knows better. */
  route?: RetrievalRoute;
  /**
   * Mine the windows behind unmined passage hits before assembling the graph.
   *
   * Defaults on for everything except the fast lookup path, which answers
   * from text alone. At most two windows per query; a failure falls back to
   * today's unmined behavior.
   */
  lazyExtract?: boolean;
  /**
   * Seed PPR with dense cosine matches alongside the lexical triple/event
   * seeds. Defaults on for everything except the fast lookup path, which
   * pays zero embedding work. Currently takes effect on the relational path
   * only; lookup and vague behave exactly as before.
   */
  dense?: boolean;
}

/** What kind of question this is, and therefore which path answers it. */
export type RetrievalRoute = 'lookup' | 'relational' | 'vague';

export interface RetrievalCoverage {
  /** Names the request was about. */
  requested: string[];
  /** Names found in the graph context or in the kept passages. */
  covered: string[];
  /** Names neither the graph nor the passages carry. */
  missing: string[];
  /** The package had nothing to say about the missing names. */
  abstained: boolean;
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
    route: RetrievalRoute;
    coverage: RetrievalCoverage;
    /** Windows mined on demand for this query, when the lazy path fired. */
    lazyMined?: { windows: number; entities: number; relations: number };
    /** PageRank diagnostics, when the relational path ranked by PPR. */
    ppr?: { nodes: number; iterations: number; converged: boolean };
    /** True when dense top-K passages filled an empty PPR package. */
    pprFallback?: boolean;
  };
}

/**
 * Words that make a question relational rather than a lookup.
 *
 * "Who is Serena's sister" is not answered by finding the word "sister" in a
 * passage; it is answered by the sibling edge. "What did Serena say at the
 * bridge" is a lookup, and the words that make it one are checked first.
 */
const RELATION_CUES = [
  'sibling', 'brother', 'sister', 'parent', 'mother', 'father', 'son', 'daughter',
  'child', 'aunt', 'uncle', 'cousin', 'nephew', 'niece', 'grandfather', 'grandmother',
  'husband', 'wife', 'spouse', 'married', 'related', 'relation', 'relationship',
  'friend', 'enemy', 'ally', 'mentor', 'teacher', 'student', 'member', 'belongs',
  'leads', 'leader', 'knows', 'know', 'knew', 'works', 'serves', 'owes',
  'met', 'married', 'killed', 'gave', 'took', 'joined', 'fought', 'betrayed',
];

/** Words that ask for a passage, a quotation or a stated fact. */
const LOOKUP_OPENERS = [
  /^what did .+ (?:say|tell|write|answer|reply)\b/,
  /^what (?:is|was) the (?:name|word|date|number|colour|color|title)\b/,
  /^(?:where|when) (?:is|was|did|does|do)\b/,
  /^(?:quote|find the passage|show me the passage|exact words)\b/,
  /^who (?:is|was) [^.]+$/,
];

/**
 * Decide how a query should be answered.
 *
 * Relational wins when it applies, because a lookup would silently answer a
 * different question. A quoted phrase is always a lookup: the author wants the
 * words. Everything else that is not a clear lookup is vague, which keeps the
 * old behaviour of searching text and graph together.
 */
export function routeQuery(query: string, focus: string[] = []): RetrievalRoute {
  const q = (query ?? '').toLowerCase().trim();
  if (!q) return focus.length >= 2 ? 'relational' : 'vague';

  // A quoted phrase is always a lookup: the author pasted the words they
  // want, so the passages answer it. This beats the relational signals below,
  // which would otherwise fire on the relationship words inside the quote.
  if (q.startsWith('"') || q.includes('"') || q.includes('“')) return 'lookup';

  const possessive = /\b[a-z][a-z'-]*['’]s\b/.test(q);
  const hasCue = RELATION_CUES.some((cue) => new RegExp(`\\b${cue}\\b`).test(q));
  if (focus.length >= 2 && (hasCue || possessive)) return 'relational';
  if (hasCue && (focus.length >= 1 || q.split(/\s+/).length >= 3)) return 'relational';
  if (possessive) return 'relational';

  if (LOOKUP_OPENERS.some((re) => re.test(q))) return 'lookup';

  return 'vague';
}

function normaliseName(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameInText(name: string, text: string): boolean {
  const needle = normaliseName(name);
  if (!needle) return false;
  const hay = normaliseName(text);
  if (hay.includes(needle)) return true;
  // "Serena" should count for "Serena Marsh" in a passage that uses the short
  // form; the graph carries the aliases, the passage carries the mention.
  const tokens = needle.split(' ').filter((t) => t.length > 2);
  return tokens.length > 0 && tokens.every((t) => hay.includes(t));
}

function emptyGraphContext(): graph.GraphContext {
  return {
    nodes: [],
    edges: [],
    passages: [],
    text: '',
    truncated: false,
    stats: { nodes: 0, edges: 0, passages: 0, words: 0 },
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
  const route = req.route ?? routeQuery(query, focus);
  const relational = route === 'relational';
  const includeGraph = req.includeGraph ?? route !== 'lookup';
  // A lookup needs no widening, and neither does a relational question: the
  // graph already carries the connection. Only a vague query pays for expansion.
  const skipExpansion = req.skipExpansion ?? route !== 'vague';

  /* ------------------------------------------------- passages (FTS5) */
  const searchTerms = [query, ...focus].filter(Boolean).join(' ');
  let passages: lore.Passage[] = [];
  if (searchTerms) {
    const expand = skipExpansion ? [] : await lore.expandQuery(llm, searchTerms);
    passages = lore.searchCanon(db, projectId, searchTerms, {
      limit: passageLimit,
      expand,
    });
  }

  /* ------------------------------- lazy mining of unmined hits */
  let lazyMined: { windows: number; entities: number; relations: number } | undefined;
  const lazyOn = req.lazyExtract ?? route !== 'lookup';
  if (lazyOn && req.includeGraph !== false && passages.length) {
    const mini = await lorebook.mineUnminedHits(
      db,
      llm,
      projectId,
      passages.map((p) => p.chunkId),
    );
    if (mini) {
      lazyMined = { windows: mini.windows, entities: mini.entities, relations: mini.relations };
    }
  }

  /**
   * Build the graph side, the supporting passages and the budgeted text.
   * Called once, and again with a second hop if the coverage check asks for it.
   */
  // Dense config resolves from project settings (a DB read, no network);
  // the single query embed happens inside, only when vectors are stored.
  const denseEmbed =
    relational && req.dense !== false
      ? embeddings.resolveEmbedConfig(db, projectId, { fallbackBaseUrl: llm.settings.baseUrl })
      : undefined;
  const assemble = async (hops: number): Promise<{
    graphContext: graph.GraphContext;
    keptPassages: lore.Passage[];
    supporting: lore.Passage[];
    text: string;
  }> => {
    const graphContext = includeGraph
      ? relational
        ? await graph.buildPprGraphContext(db, projectId, {
            query,
            focus: focus.length ? focus : graph.terms(query).slice(0, 3),
            hops,
            scope: req.scope,
            atEventId: req.atEventId,
            // A two-hop walk needs room: the answer is often at the far end.
            maxNodes: hops > 1 ? 70 : 45,
            maxWords: Math.round(maxWords * 0.70),
            ...(denseEmbed ? { embed: denseEmbed } : {}),
          })
        : graph.buildGraphContext(db, projectId, {
            query,
            focus: focus.length ? focus : graph.terms(query).slice(0, 3),
            hops,
            scope: req.scope,
            atEventId: req.atEventId,
            // A two-hop walk needs room: the answer is often at the far end.
            maxNodes: hops > 1 ? 70 : 45,
            maxWords: Math.round(maxWords * 0.70),
          })
      : emptyGraphContext();

    const supporting: lore.Passage[] = [];
    const merged = [...passages];
    if (req.includePassages !== false) {
      for (const p of graphContext.passages) {
        const found = merged.find((x) => x.chunkId === p.chunkId);
        if (found) continue;
        const chunk = lore.getChunk(db, p.chunkId);
        if (chunk) {
          supporting.push(chunk);
          merged.push(chunk);
        }
      }
    }

    const seenChunks = new Set<number>();
    const deduped: lore.Passage[] = [];
    for (const p of merged) {
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

    const parts: string[] = [];
    if (keptPassages.length) {
      parts.push(
        'CANON EVIDENCE (use these for facts and wording; do not copy the sentences):\n' +
          lore.formatPassages(keptPassages),
      );
    }
    if (graphContext.text.trim()) {
      parts.push(`CONNECTED CONTEXT (what this scene touches, and how):\n${graphContext.text.trim()}`);
    }

    return { graphContext, keptPassages, supporting, text: parts.join('\n\n') };
  };

  let assembled = await assemble(req.hops ?? 1);

  const coverage = (built: typeof assembled): RetrievalCoverage => {
    const requested = focus;
    const covered: string[] = [];
    const missing: string[] = [];
    for (const name of requested) {
      const inGraph = built.graphContext.nodes.some((node) =>
        [node.name, ...node.aliases].some((n) => {
          const a = normaliseName(n);
          const b = normaliseName(name);
          return !!a && (a === b || a.includes(b) || b.includes(a));
        }),
      );
      const inText = built.keptPassages.some((p) => nameInText(name, p.text));
      (inGraph || inText ? covered : missing).push(name);
    }
    return {
      requested,
      covered,
      missing,
      abstained: missing.length > 0 && !built.keptPassages.length && !built.graphContext.nodes.length,
    };
  };

  let cov = coverage(assembled);
  // The tail check: a name the package does not carry is the symptom of a walk
  // that stopped one hop too early. Walk once more before giving up.
  if (relational && includeGraph && cov.missing.length && (req.hops ?? 1) < 2) {
    assembled = await assemble(2);
    cov = coverage(assembled);
  }

  const { graphContext, keptPassages, supporting, text } = assembled;
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
      route,
      coverage: cov,
      ...(lazyMined ? { lazyMined } : {}),
      ...(graphContext.stats.ppr ? { ppr: graphContext.stats.ppr } : {}),
      ...(graphContext.stats.pprFallback ? { pprFallback: true } : {}),
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
