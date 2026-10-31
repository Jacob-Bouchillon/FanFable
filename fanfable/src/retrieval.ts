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
import { RELATION_CUES } from './vocab.ts';
import { nameMentioned } from './identity/names.ts';

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
  /**
   * Load the association layer (alias/resemblance/co-occurrence edges) into
   * the graph. Default off: the blind taste test (9 identical, 2
   * reorder-only ties, 1 both-miss over 12 real questions) showed the detour
   * leading nowhere at current index density. Set true to take it.
   */
  web?: boolean;
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
    /** A family tie the web already implies, so no mining was needed. */
    composedPath?: { via: string; label: string };
    /** Two named people with no tie and no composed path: strangers. */
    strangers?: { a: string; b: string };
    /** Windows mined on demand for this query, when the lazy path fired. */
    lazyMined?: { windows: number; entities: number; relations: number };
    /** PageRank diagnostics, when the relational path ranked by PPR. */
    ppr?: { nodes: number; iterations: number; converged: boolean };
    /** True when dense top-K passages filled an empty PPR package. */
    pprFallback?: boolean;
    /** Similarity-web edges in the loaded graph, per kind. */
    web?: { aliasEdges: number; resemblanceEdges: number; cooccurrenceEdges: number };
    /** Recognition-filter counts, when dense-only seeds were checked. */
    recognition?: { checked: number; kept: number; dropped: number };
    corroborated?: { passages: number; maxSeeds: number };
  };
}

/**
 * Words that make a question relational rather than a lookup.
 *
 * "Who is Serena's sister" is not answered by finding the word "sister" in a
 * passage; it is answered by the sibling edge. "What did Serena say at the
 * bridge" is a lookup, and the words that make it one are checked first.
 */
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
  let bankProfile = lorebook.buildBankProfile(db, projectId, searchTerms);
  let passages: lore.Passage[] = [];
  if (searchTerms) {
    const expand = skipExpansion ? [] : await lore.expandQuery(llm, searchTerms);
    passages = lore.searchCanon(db, projectId, searchTerms, {
      limit: passageLimit,
      expand,
      bankProfile,
    });
  }

  /* ------------------------------- lazy mining of unmined hits */
  let lazyMined: { windows: number; entities: number; relations: number } | undefined;
  let composedPath: { via: string; label: string } | undefined;
  let strangers: { a: string; b: string } | undefined;
  const lazyOn = req.lazyExtract ?? route !== 'lookup';
  // A family tie the web already implies needs no fresh reading: two people
  // joined by a composed path through accepted rows skip the mining the
  // query would otherwise pay for. Nothing is banked; the graph answers.
  // No banked stranger rows ever: N squared pairs, none quotable. Strangers
  // are an answer ("no recorded connection"), computed here, never stored.
  // Conditional mining: cheap bank check first, pay for mining only when
  // unmined evidence is in scope. Nothing unmined among the FTS hits keeps
  // the old skip (verdict from bank, no LLM). Unmined hits mine first, then
  // the verdict is recomputed so it never freezes stale.
  const computeVerdict = (): void => {
    composedPath = undefined;
    strangers = undefined;
    if (!(lazyOn && relational && focus.length >= 2)) return;
    const a = lorebook.findEntity(db, projectId, focus[0]!);
    const b = lorebook.findEntity(db, projectId, focus[1]!);
    if (!a || !b) return;
    composedPath = graph.findComposedPath(db, projectId, a.id, b.id) ?? undefined;
    if (!composedPath) {
      const direct = db.get<{ id: number }>(
        `SELECT id FROM canon_relation WHERE project_id = ? AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?)) LIMIT 1`,
        projectId, a.id, b.id, b.id, a.id,
      );
      if (!direct) strangers = { a: a.name, b: b.name };
    }
  };
  computeVerdict();
  if (lazyOn && req.includeGraph !== false && passages.length) {
    const chunkIds = passages.map((p) => p.chunkId);
    const unmined = chunkIds.length
      ? db.all<{ id: number }>(
          `SELECT id FROM canon_chunk WHERE project_id = ? AND lore_mined = 0 AND id IN (${chunkIds.map(() => '?').join(',')})`,
          projectId,
          ...chunkIds,
        )
      : [];
    if (unmined.length) {
      const mini = await lorebook.mineUnminedHits(
        db,
        llm,
        projectId,
        chunkIds,
      );
      if (mini) {
        lazyMined = { windows: mini.windows, entities: mini.entities, relations: mini.relations };
      }
      computeVerdict();
    }
  }
  if (lazyMined) {
    // New rows landed, so the pre-mining profile is stale for the final rank.
    bankProfile = lorebook.buildBankProfile(db, projectId, searchTerms);
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
            recognize: { llm, enabled: req.dense !== false },
            web: req.web ?? false,
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
            web: req.web ?? false,
          })
      : emptyGraphContext();

    const supporting: lore.Passage[] = [];
    const merged = [...passages];
    if (req.includePassages !== false) {
      const known = new Set(merged.map((p) => p.chunkId));
      const missing = graphContext.passages
        .map((p) => p.chunkId)
        .filter((chunkId) => !known.has(chunkId));
      const byId = new Map(lore.getChunks(db, missing).map((p) => [p.chunkId, p]));
      for (const p of graphContext.passages) {
        if (known.has(p.chunkId)) continue;
        const chunk = byId.get(p.chunkId);
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

    // One shared ranker for every path that produced candidates (keyword,
    // graph/PPR, dense fallback, bank-expanded). It only reorders: a query
    // that names nobody in the bank keeps the order it came in with.
    const ordered = lorebook.rankWithBank(db, projectId, searchTerms, deduped, bankProfile);

    const passageBudget = Math.round(maxWords * 0.30);
    const keptPassages: lore.Passage[] = [];
    let used = 0;
    for (const p of ordered) {
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
        [node.name, ...node.aliases].some(
          (n) => nameMentioned(name, n) || nameMentioned(n, name),
        ),
      );
      const inText = built.keptPassages.some((p) => nameMentioned(name, p.text));
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
      ...(composedPath ? { composedPath } : {}),
      ...(strangers ? { strangers } : {}),
      ...(graphContext.stats.ppr ? { ppr: graphContext.stats.ppr } : {}),
      ...(graphContext.stats.pprFallback ? { pprFallback: true } : {}),
      ...(graphContext.stats.recognition ? { recognition: graphContext.stats.recognition } : {}),
      ...(graphContext.stats.corroborated ? { corroborated: graphContext.stats.corroborated } : {}),
      ...(graphContext.stats.web ? { web: graphContext.stats.web } : {}),
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
