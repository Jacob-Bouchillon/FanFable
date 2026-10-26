/**
 * The knowledge graph.
 *
 * This is shared infrastructure, not a search command. Every subsystem that
 * needs to understand *connected* information — the planner, the writer, the
 * continuity checker, the memory manager — goes through this module.
 *
 * Design notes
 * ------------
 * The graph is a *view* over the tables that already exist rather than a
 * parallel copy of them. Canon lives in canon_entity / canon_relation /
 * canon_fact / canon_event / canon_timeline; the story lives in character /
 * au_event / relationship / plot_thread / story_fact / character_knowledge.
 * The edge tables added by migration 2 (canon_event_participant,
 * au_event_participant, au_event_link, secret, motivation) fill the gaps that
 * the original schema left.
 *
 * Nodes have stable string ids of the form "canon:entity:12" or
 * "story:character:5", so an edge never has to guess what it points at and the
 * canon side and the story side stay in separate id spaces.
 *
 * A relation is never simply "true": every edge carries the evidence it came
 * from, a confidence, a review status, and — where it matters — the range of
 * story time it holds for.
 */
import { Db, fromJson, strList } from './db.ts';
import { DEFAULT_EMBED_MODEL, cosine, embedTexts, readVectors, resolveEmbedConfig, type EmbedFn } from './embeddings.ts';
import type { LlmClient } from './llm.ts';
import { filterDenseSeeds } from './recognition.ts';
import { looksAlike, nameRelation, sharedSpeakerScene, speakerChunksByEntity } from './lorebook.ts';
import { truncate } from './text.ts';

/* --------------------------------------------- similarity-web weights
 *
 * One block so the bake-off can tune them later. Alias edges join what the
 * merge rules call one thing; resemblance joins what vectors agree on;
 * co-occurrence joins what the book keeps putting in one window. All three
 * are ranker infrastructure: PPR spreads along them, the text never shows
 * them, and every one is weaker than a real relation (weight 1) except a
 * confirmed alias.
 */
export const ALIAS_WEIGHT = 1.0;
export const QUARANTINE_WEIGHT = 0.5;
export const RESEMBLANCE_THRESHOLD = 0.75;
export const RESEMBLANCE_TOPK = 3;
export const COOCCURRENCE_MIN_WINDOWS = 2;
export const COOCCURRENCE_WEIGHT_PER_WINDOW = 0.15;
export const COOCCURRENCE_WEIGHT_CAP = 0.5;
export const HUB_DF_FRACTION = 0.5;

export interface CooccurrenceLink {
  a: number;
  b: number;
  /** Windows mentioning both. */
  windows: number;
  weight: number;
}

/**
 * Which entity pairs earn a co-occurrence edge, from window sets alone.
 *
 * Pairs sharing fewer than COOCCURRENCE_MIN_WINDOWS windows are noise;
 * anything in more than HUB_DF_FRACTION of all windows is a score sink and
 * disqualifies every pair it touches. Pairs come out in id order, so the
 * same input always yields the same links.
 */
/**
 * Per-kind counts of the similarity web in a loaded graph, for stats and
 * diagnostics. The web is ranker infrastructure; these counts say how much
 * of it a query had to spread along.
 */
export function countWebEdges(graph: Graph): {
  aliasEdges: number;
  resemblanceEdges: number;
  cooccurrenceEdges: number;
} {
  let aliasEdges = 0;
  let resemblanceEdges = 0;
  let cooccurrenceEdges = 0;
  for (const edge of graph.edges) {
    if (edge.type === 'alias_of') aliasEdges++;
    else if (edge.type === 'resembles') resemblanceEdges++;
    else if (edge.type === 'appears_with') cooccurrenceEdges++;
  }
  return { aliasEdges, resemblanceEdges, cooccurrenceEdges };
}

export function cooccurrenceLinks(
  entityWindows: Map<number, Set<number>>,
  totalWindows: number,
): CooccurrenceLink[] {
  const out: CooccurrenceLink[] = [];
  if (totalWindows <= 0) return out;
  const ids = [...entityWindows.keys()]
    .filter((id) => (entityWindows.get(id)?.size ?? 0) / totalWindows <= HUB_DF_FRACTION)
    .sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      const sa = entityWindows.get(a)!;
      const sb = entityWindows.get(b)!;
      const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      let shared = 0;
      for (const w of small) if (large.has(w)) shared++;
      if (shared < COOCCURRENCE_MIN_WINDOWS) continue;
      out.push({
        a,
        b,
        windows: shared,
        weight: Math.min(COOCCURRENCE_WEIGHT_CAP, COOCCURRENCE_WEIGHT_PER_WINDOW * shared),
      });
    }
  }
  return out;
}

export type GraphScope = 'canon' | 'story' | 'both';

export type NodeKind =
  | 'canon-entity'
  | 'canon-event'
  | 'canon-fact'
  | 'canon-timeline'
  | 'canon-passage'
  | 'character'
  | 'au-event'
  | 'story-fact'
  | 'plot-thread'
  | 'assertion'
  | 'secret'
  | 'motivation';

export interface SourceRef {
  source: string;
  locator: string;
  chunk?: number;
}

export interface GraphNode {
  id: string;
  numericId: number;
  kind: NodeKind;
  scope: 'canon' | 'story';
  name: string;
  summary: string;
  aliases: string[];
  confidence: number;
  reviewStatus: string;
  evidence: string;
  sourceRefs: SourceRef[];
  /** Position on the timeline (canon sequence, or story order). */
  order: number;
  extra: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Typed: 'related_to', 'participates_in', 'knows', 'causes', 'adapts', ... */
  type: string;
  scope: 'canon' | 'story' | 'both';
  description: string;
  evidence: string;
  confidence: number;
  reviewStatus: string;
  /** Inclusive start and end on the timeline, when the edge is time-bound. */
  validFrom?: number;
  validTo?: number;
  sourceRefs?: SourceRef[];
  extra?: Record<string, unknown>;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** node id -> edge ids */
  adjacency: Map<string, string[]>;
  byNumeric: Map<string, GraphNode>;
}

/* ------------------------------------------------------------------ ids */

export const canonEntityId = (id: number) => `canon:entity:${id}`;
export const canonEventId = (id: number) => `canon:event:${id}`;
export const canonFactId = (id: number) => `canon:fact:${id}`;
export const canonTimelineId = (id: number) => `canon:timeline:${id}`;
export const canonPassageId = (id: number) => `canon:passage:${id}`;
export const characterId = (id: number) => `story:character:${id}`;
export const auEventId = (id: number) => `story:event:${id}`;
export const storyFactId = (id: number) => `story:fact:${id}`;
export const threadId = (id: number) => `story:thread:${id}`;
export const assertionId = (id: number) => `story:assertion:${id}`;
export const secretId = (id: number) => `story:secret:${id}`;
export const motivationId = (id: number) => `story:motivation:${id}`;

/* --------------------------------------------------------------- loading */

interface GraphLoadOptions {
  /** Restrict the graph to one side. */
  scope?: GraphScope;
  /** Skip the fact and assertion nodes (they dominate the graph otherwise). */
  includeFacts?: boolean;
  /** Cap on nodes loaded, so a huge book cannot exhaust memory. */
  maxNodes?: number;
  /** Load the association layer (alias/resemblance/co-occurrence edges). Default on. */
  web?: boolean;
}

function addNode(graph: Graph, node: GraphNode): void {
  if (graph.nodes.has(node.id)) return;
  graph.nodes.set(node.id, node);
  graph.byNumeric.set(node.id, node);
}

function addEdge(graph: Graph, edge: GraphEdge): void {
  edge.extra ??= {};
  // Every edge must point at nodes that exist: a dangling edge is a bug.
  if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) return;
  graph.edges.push(edge);
  const from = graph.adjacency.get(edge.from);
  const to = graph.adjacency.get(edge.to);
  if (from) from.push(edge.id);
  else graph.adjacency.set(edge.from, [edge.id]);
  if (to) to.push(edge.id);
  else graph.adjacency.set(edge.to, [edge.id]);
}

function refs(raw: string): SourceRef[] {
  return fromJson<SourceRef[]>(raw, []);
}

/**
 * Load the graph for a project.
 *
 * Everything is read once into memory: a 250-page book yields a few hundred
 * nodes, which is small enough to traverse freely and fast enough to do on
 * every chapter. `maxNodes` protects the pathological case.
 */
export function loadGraph(db: Db, projectId: number, opts: GraphLoadOptions = {}): Graph {
  const scope = opts.scope ?? 'both';
  const includeFacts = opts.includeFacts ?? true;
  const maxNodes = opts.maxNodes ?? 20_000;
  const graph: Graph = { nodes: new Map(), edges: [], adjacency: new Map(), byNumeric: new Map() };

  /* ------------------------------------------------------------- canon */
  if (scope === 'canon' || scope === 'both') {
    const entities = db.all<{
      id: number;
      kind: string;
      name: string;
      aliases: string;
      summary: string;
      role: string;
      status: string;
      evidence: string;
      source_refs: string;
      confidence: number;
      review_status: string;
      first_chunk: number | null;
    }>('SELECT * FROM canon_entity WHERE project_id = ? ORDER BY id', projectId);
    for (const e of entities) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: canonEntityId(e.id),
        numericId: e.id,
        kind: 'canon-entity',
        scope: 'canon',
        name: e.name,
        summary: e.summary,
        aliases: strList(e.aliases),
        confidence: e.confidence ?? 1,
        reviewStatus: e.review_status ?? 'accepted',
        evidence: e.evidence,
        sourceRefs: refs(e.source_refs),
        order: 0,
        extra: { kind: e.kind, role: e.role, status: e.status, firstChunk: e.first_chunk },
      });
    }

    const relations = db.all<{
      id: number;
      from_entity: number;
      to_entity: number;
      kind: string;
      description: string;
      evidence: string;
      source_refs: string;
      confidence: number;
      review_status: string;
      valid_from_event_id: number | null;
      valid_to_event_id: number | null;
    }>('SELECT * FROM canon_relation WHERE project_id = ? ORDER BY id', projectId);
    for (const r of relations) {
      const rs = r.review_status ?? 'accepted';
      if (rs !== 'accepted' && rs !== 'user_confirmed') continue;
      addEdge(graph, {
        id: `canon:relation:${r.id}`,
        from: canonEntityId(r.from_entity),
        to: canonEntityId(r.to_entity),
        type: r.kind || 'related_to',
        scope: 'canon',
        description: r.description,
        evidence: r.evidence,
        confidence: r.confidence ?? 1,
        reviewStatus: rs,
        sourceRefs: refs(r.source_refs),
        extra: {},
      });
    }

    const events = db.all<{
      id: number;
      title: string;
      summary: string;
      location: string;
      time_label: string;
      kind: string;
      quote: string;
      chunk_id: number | null;
      confidence: number;
      seq: number;
    }>('SELECT * FROM canon_event WHERE project_id = ? ORDER BY seq, id', projectId);
    for (const e of events) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: canonEventId(e.id),
        numericId: e.id,
        kind: 'canon-event',
        scope: 'canon',
        name: e.title,
        summary: e.summary,
        aliases: [],
        confidence: e.confidence ?? 1,
        reviewStatus: 'accepted',
        evidence: e.quote,
        sourceRefs: [],
        order: e.seq ?? 0,
        extra: { location: e.location, timeLabel: e.time_label, kind: e.kind, chunkId: e.chunk_id },
      });
    }

    if (includeFacts) {
      const facts = db.all<{
        id: number;
        topic: string;
        statement: string;
        kind: string;
        certainty: string;
        subject: string;
        subject_entity_id: number | null;
        evidence: string;
        source_refs: string;
        confidence: number;
        review_status: string;
      }>('SELECT * FROM canon_fact WHERE project_id = ? ORDER BY id', projectId);
      for (const f of facts) {
        if (graph.nodes.size >= maxNodes) break;
        addNode(graph, {
          id: canonFactId(f.id),
          numericId: f.id,
          kind: 'canon-fact',
          scope: 'canon',
          name: f.topic || f.statement.slice(0, 60),
          summary: f.statement,
          aliases: [],
          confidence: f.confidence ?? 1,
          reviewStatus: f.review_status ?? 'accepted',
          evidence: f.evidence,
          sourceRefs: refs(f.source_refs),
          order: 0,
          extra: { factKind: f.kind, certainty: f.certainty, subject: f.subject },
        });
        if (f.subject_entity_id) {
          addEdge(graph, {
            id: `canon:fact-about:${f.id}`,
            from: canonFactId(f.id),
            to: canonEntityId(f.subject_entity_id),
            type: 'about',
            scope: 'canon',
            description: f.statement,
            evidence: f.evidence,
            confidence: f.confidence ?? 1,
            reviewStatus: f.review_status ?? 'accepted',
          });
        }
      }
    }

    // The book's timeline, in order.
    const timeline = db.all<{
      id: number;
      canon_event: number | null;
      seq: number;
      title: string;
      summary: string;
      time_label: string;
      participants: string;
      location: string;
      evidence: string;
      source_refs: string;
    }>('SELECT * FROM canon_timeline WHERE project_id = ? ORDER BY seq, id', projectId);
    for (const t of timeline) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: canonTimelineId(t.id),
        numericId: t.id,
        kind: 'canon-timeline',
        scope: 'canon',
        name: t.title,
        summary: t.summary,
        aliases: [],
        confidence: 1,
        reviewStatus: 'accepted',
        evidence: t.evidence,
        sourceRefs: refs(t.source_refs),
        order: t.seq,
        extra: { timeLabel: t.time_label, location: t.location, participants: strList(t.participants) },
      });
      if (t.canon_event) {
        addEdge(graph, {
          id: `canon:timeline-describes:${t.id}`,
          from: canonTimelineId(t.id),
          to: canonEventId(t.canon_event),
          type: 'describes',
          scope: 'canon',
          description: t.summary,
          evidence: t.evidence,
          confidence: 1,
          reviewStatus: 'accepted',
        });
      }
    }

    // Who took part in a canon event.
    const canonParts = db.all<{
      canon_event_id: number;
      entity_id: number;
      role: string;
    }>(
      `SELECT p.canon_event_id, p.entity_id, p.role FROM canon_event_participant p
       JOIN canon_event e ON e.id = p.canon_event_id WHERE e.project_id = ?`,
      projectId,
    );
    for (const p of canonParts) {
      addEdge(graph, {
        id: `canon:participates:${p.canon_event_id}:${p.entity_id}`,
        from: canonEntityId(p.entity_id),
        to: canonEventId(p.canon_event_id),
        type: p.role === 'participant' ? 'participates_in' : p.role,
        scope: 'canon',
        description: '',
        evidence: '',
        confidence: 1,
        reviewStatus: 'accepted',
      });
    }

    // Canon events name their participants; resolve those names to entities so
    // the edge has a real endpoint. Cached, because names repeat a lot.
    const nameIndex = new Map<string, number>();
    const entityByName = db.all<{ id: number; name: string; aliases: string }>(
      'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
      projectId,
    );
    for (const e of entityByName) {
      nameIndex.set(e.name.toLowerCase(), e.id);
      for (const a of strList(e.aliases)) nameIndex.set(a.toLowerCase(), e.id);
    }
    const lookupEntity = (name: string): number | undefined => {
      const key = (name ?? '').trim().toLowerCase();
      if (!key) return undefined;
      const direct = nameIndex.get(key);
      if (direct) return direct;
      for (const [candidate, id] of nameIndex) {
        if (candidate.includes(key) || key.includes(candidate)) return id;
      }
      return undefined;
    };

    const canonEventRows = db.all<{ id: number; participants: string; chunk_id: number | null }>(
      'SELECT id, participants, chunk_id FROM canon_event WHERE project_id = ?',
      projectId,
    );
    for (const ev of canonEventRows) {
      for (const name of strList(ev.participants)) {
        const entityId = lookupEntity(name);
        if (!entityId) continue;
        addEdge(graph, {
          id: `canon:event-participates:${ev.id}:${entityId}`,
          from: canonEntityId(entityId),
          to: canonEventId(ev.id),
          type: 'participates_in',
          scope: 'canon',
          description: '',
          evidence: '',
          confidence: 1,
          reviewStatus: 'accepted',
        });
      }
    }

    for (const t of timeline) {
      for (const name of strList(t.participants)) {
        const entityId = lookupEntity(name);
        if (!entityId) continue;
        addEdge(graph, {
          id: `canon:appears-in:${entityId}:${t.id}`,
          from: canonEntityId(entityId),
          to: canonTimelineId(t.id),
          type: 'appears_in',
          scope: 'canon',
          description: '',
          evidence: '',
          confidence: 1,
          reviewStatus: 'accepted',
        });
      }
    }

    // Passages as first-class nodes: every canon chunk becomes a node, and
    // every entity, event and timeline entry points at the passages behind
    // it. The ranker spreads seed weight along these mention edges, so a
    // passage two hops out (entity -> relation -> entity -> passage) can
    // still surface. Derived entirely from canon_chunk plus the existing
    // source_refs/chunk_id columns: no migration.
    const chunks = db.all<{
      id: number;
      locator: string;
      heading: string;
      text: string;
    }>('SELECT id, locator, heading, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id', projectId);
    for (const c of chunks) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: canonPassageId(c.id),
        numericId: c.id,
        kind: 'canon-passage',
        scope: 'canon',
        name: c.locator || `passage ${c.id}`,
        summary: '',
        aliases: [],
        confidence: 1,
        reviewStatus: 'accepted',
        evidence: '',
        sourceRefs: [],
        order: 0,
        extra: { heading: c.heading, locator: c.locator, chunkId: c.id, text: truncate(c.text, 400) },
      });
    }

    // Entity -> passage for every chunk the entity's references point at.
    for (const node of graph.nodes.values()) {
      if (node.kind !== 'canon-entity' || node.scope !== 'canon') continue;
      const mentioned = new Set<number>();
      for (const ref of node.sourceRefs) if (typeof ref.chunk === 'number') mentioned.add(ref.chunk);
      const first = node.extra?.firstChunk;
      if (typeof first === 'number') mentioned.add(first);
      for (const chunkId of mentioned) {
        addEdge(graph, {
          id: `canon:mentions:${node.numericId}:${chunkId}`,
          from: node.id,
          to: canonPassageId(chunkId),
          type: 'mentions_in',
          scope: 'canon',
          description: '',
          evidence: '',
          confidence: 1,
          reviewStatus: 'accepted',
          extra: { weight: 1 },
        });
      }
    }

    // Event/timeline -> passage for the chunk each came from.
    for (const node of graph.nodes.values()) {
      if (node.scope !== 'canon') continue;
      if (node.kind !== 'canon-event' && node.kind !== 'canon-timeline') continue;
      const linked = new Set<number>();
      const chunkId = node.extra?.chunkId;
      if (typeof chunkId === 'number') linked.add(chunkId);
      if (node.kind === 'canon-timeline') {
        for (const ref of node.sourceRefs) if (typeof ref.chunk === 'number') linked.add(ref.chunk);
      }
      for (const id of linked) {
        addEdge(graph, {
          id: `canon:scene-in:${node.numericId}:${id}`,
          from: node.id,
          to: canonPassageId(id),
          type: 'mentions_in',
          scope: 'canon',
          description: '',
          evidence: '',
          confidence: 1,
          reviewStatus: 'accepted',
          extra: { weight: 1 },
        });
      }
    }

    if (opts.web !== false) {
      // Alias web: pairs the merge rules would join stay linked, recomputed
      // read-only — merge behavior itself is untouched. A same-name pair is
      // certain (1.0); a containment the co-speaker veto blocked, or a mere
      // lookalike, is probable (0.5). One edge per pair: PPR already spreads
      // every edge both ways.
      const aliasSpeakers = speakerChunksByEntity(db, projectId);
      const aliasEntities = db.all<{ id: number; kind: string; name: string }>(
        'SELECT id, kind, name FROM canon_entity WHERE project_id = ? ORDER BY id',
        projectId,
      );
      for (let i = 0; i < aliasEntities.length; i++) {
        for (let j = i + 1; j < aliasEntities.length; j++) {
          const a = aliasEntities[i]!;
          const b = aliasEntities[j]!;
          // A person and a place can share a name; they are not the same thing.
          if (a.kind !== b.kind) continue;
          const relation = nameRelation(a.name, b.name);
          let weight: number | null = null;
          if (relation === 'same') weight = ALIAS_WEIGHT;
          else if (relation === 'containment') {
            weight = sharedSpeakerScene(aliasSpeakers, a.id, b.id) ? QUARANTINE_WEIGHT : ALIAS_WEIGHT;
          } else if (looksAlike(a.name, b.name).alike) weight = QUARANTINE_WEIGHT;
          if (weight === null) continue;
          const [x, y] = a.id < b.id ? [a, b] : [b, a];
          addEdge(graph, {
            id: `canon:alias:${x.id}:${y.id}`,
            from: canonEntityId(x.id),
            to: canonEntityId(y.id),
            type: 'alias_of',
            scope: 'canon',
            description: '',
            evidence: '',
            confidence: 1,
            reviewStatus: 'accepted',
            extra: { weight },
          });
        }
      }

      // Resemblance web: entities whose stored vectors agree get linked at
      // their similarity. No vectors, no edges — a purely lexical graph loads
      // exactly as before. At most RESEMBLANCE_TOPK edges per node, greedy in
      // id order so the same input always yields the same edges.
      const activeModel = resolveEmbedConfig(db, projectId, {}).model;
      const entityVecs = new Map(
        readVectors(db, projectId, activeModel)
          .filter((v) => v.kind === 'entity' && v.vec.length > 0)
          .map((v) => [v.ref, v.vec] as [string, number[]]),
      );
      for (const id of [...entityVecs.keys()]) {
        if (!graph.nodes.has(id)) entityVecs.delete(id);
      }
      const resembleDegree = new Map<string, number>();
      const resembledPairs = new Set<string>();
      for (const id of [...entityVecs.keys()].sort()) {
        const scored: { other: string; sim: number }[] = [];
        for (const other of entityVecs.keys()) {
          if (other === id) continue;
          const sim = cosine(entityVecs.get(id)!, entityVecs.get(other)!);
          if (sim >= RESEMBLANCE_THRESHOLD) scored.push({ other, sim });
        }
        scored.sort((a, b) => b.sim - a.sim || (a.other < b.other ? -1 : 1));
        for (const { other, sim } of scored.slice(0, RESEMBLANCE_TOPK)) {
          const key = id < other ? `${id}|${other}` : `${other}|${id}`;
          if (resembledPairs.has(key)) continue;
          if ((resembleDegree.get(id) ?? 0) >= RESEMBLANCE_TOPK) continue;
          if ((resembleDegree.get(other) ?? 0) >= RESEMBLANCE_TOPK) continue;
          resembledPairs.add(key);
          resembleDegree.set(id, (resembleDegree.get(id) ?? 0) + 1);
          resembleDegree.set(other, (resembleDegree.get(other) ?? 0) + 1);
          const [x, y] = id < other ? [id, other] : [other, id];
          const xn = graph.nodes.get(x)!.numericId;
          const yn = graph.nodes.get(y)!.numericId;
          const [nx, ny] = xn < yn ? [xn, yn] : [yn, xn];
          addEdge(graph, {
            id: `canon:resembles:${nx}:${ny}`,
            from: x,
            to: y,
            type: 'resembles',
            scope: 'canon',
            description: '',
            evidence: '',
            confidence: 1,
            reviewStatus: 'accepted',
            extra: { weight: sim },
          });
        }
      }

      // Co-occurrence web: pairs mentioned together in at least
      // COOCCURRENCE_MIN_WINDOWS windows of 8 consecutive passages. One
      // shared window is noise; a ubiquitous entity is a score sink, so pairs
      // involving anything above HUB_DF_FRACTION of windows get nothing.
      const winRows = db.all<{ id: number; source_id: number; seq: number }>(
        'SELECT id, source_id, seq FROM canon_chunk WHERE project_id = ? ORDER BY source_id, seq',
        projectId,
      );
      const chunkWindow = new Map<number, number>();
      {
        let window = -1;
        let count = 0;
        let lastSource = -1;
        for (const row of winRows) {
          if (row.source_id !== lastSource || count >= 8) {
            window++;
            count = 0;
            lastSource = row.source_id;
          }
          chunkWindow.set(row.id, window);
          count++;
        }
      }
      const totalWindows = chunkWindow.size ? Math.max(...chunkWindow.values()) + 1 : 0;
      const entityWindows = new Map<number, Set<number>>();
      for (const node of graph.nodes.values()) {
        if (node.kind !== 'canon-entity' || node.scope !== 'canon') continue;
        const windows = new Set<number>();
        for (const ref of node.sourceRefs) {
          if (typeof ref.chunk !== 'number') continue;
          const w = chunkWindow.get(ref.chunk);
          if (w !== undefined) windows.add(w);
        }
        const first = node.extra?.firstChunk;
        if (typeof first === 'number') {
          const w = chunkWindow.get(first);
          if (w !== undefined) windows.add(w);
        }
        if (windows.size) entityWindows.set(node.numericId, windows);
      }
      for (const { a, b, weight } of cooccurrenceLinks(entityWindows, totalWindows)) {
        const [x, y] = a < b ? [a, b] : [b, a];
        addEdge(graph, {
          id: `canon:appears-with:${x}:${y}`,
          from: canonEntityId(x),
          to: canonEntityId(y),
          type: 'appears_with',
          scope: 'canon',
          description: '',
          evidence: '',
          confidence: 1,
          reviewStatus: 'accepted',
          extra: { weight },
        });
      }
    }
    }

  /* ------------------------------------------------------------- story */
  if (scope === 'story' || scope === 'both') {
    const characters = db.all<{
      id: number;
      name: string;
      aliases: string;
      profile: string;
      traits: string;
      canon_entity_id: number | null;
      confidence: number;
      review_status: string;
    }>('SELECT * FROM character WHERE project_id = ? ORDER BY id', projectId);
    for (const c of characters) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: characterId(c.id),
        numericId: c.id,
        kind: 'character',
        scope: 'story',
        name: c.name,
        summary: c.profile,
        aliases: strList(c.aliases),
        confidence: c.confidence ?? 1,
        reviewStatus: c.review_status ?? 'accepted',
        evidence: '',
        sourceRefs: [],
        order: 0,
        extra: { traits: strList(c.traits), canonEntityId: c.canon_entity_id },
      });
      if (c.canon_entity_id) {
        addEdge(graph, {
          id: `story:based-on:${c.id}`,
          from: characterId(c.id),
          to: canonEntityId(c.canon_entity_id),
          type: 'based_on',
          scope: 'both',
          description: 'this character is the story version of this canon character',
          evidence: '',
          confidence: 1,
          reviewStatus: 'accepted',
        });
      }
    }

    const auEvents = db.all<{
      id: number;
      title: string;
      summary: string;
      story_time: string;
      story_order: number;
      location: string;
      kind: string;
      adapts_canon_event_id: number | null;
      divergence_note: string;
      confidence: number;
      review_status: string;
    }>('SELECT * FROM au_event WHERE project_id = ? ORDER BY story_order, seq', projectId);
    for (const e of auEvents) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: auEventId(e.id),
        numericId: e.id,
        kind: 'au-event',
        scope: 'story',
        name: e.title,
        summary: e.summary,
        aliases: [],
        confidence: e.confidence ?? 1,
        reviewStatus: e.review_status ?? 'accepted',
        evidence: '',
        sourceRefs: [],
        order: e.story_order,
        extra: {
          storyTime: e.story_time,
          location: e.location,
          kind: e.kind,
          adaptsCanonEventId: e.adapts_canon_event_id,
          divergenceNote: e.divergence_note,
        },
      });
    }

    // AU event <-> canon event, with the kind of change recorded.
    for (const e of auEvents) {
      if (!e.adapts_canon_event_id) continue;
      const change = db.get<{ change_type: string; description: string }>(
        `SELECT change_type, description FROM canon_change
         WHERE project_id = ? AND au_event_id = ? AND canon_event_id = ? LIMIT 1`,
        projectId,
        e.id,
        e.adapts_canon_event_id,
      );
      addEdge(graph, {
        id: `story:adapts:${e.id}:${e.adapts_canon_event_id}`,
        from: auEventId(e.id),
        to: canonEventId(e.adapts_canon_event_id),
        type: change?.change_type ? `adapts_${change.change_type}` : 'adapts',
        scope: 'both',
        description: change?.description ?? e.divergence_note,
        evidence: '',
        confidence: e.confidence ?? 1,
        reviewStatus: e.review_status ?? 'accepted',
      });
    }

    // Who took part in a story event.
    const auParts = db.all<{ au_event_id: number; character_id: number; role: string }>(
      `SELECT p.au_event_id, p.character_id, p.role FROM au_event_participant p
       JOIN au_event e ON e.id = p.au_event_id WHERE e.project_id = ?`,
      projectId,
    );
    for (const p of auParts) {
      addEdge(graph, {
        id: `story:participates:${p.au_event_id}:${p.character_id}`,
        from: characterId(p.character_id),
        to: auEventId(p.au_event_id),
        type: p.role === 'participant' ? 'participates_in' : p.role,
        scope: 'story',
        description: '',
        evidence: '',
        confidence: 1,
        reviewStatus: 'accepted',
      });
    }

    // Cause and consequence between story events.
    const links = db.all<{
      from_event_id: number;
      to_event_id: number;
      kind: string;
      description: string;
      confidence: number;
    }>('SELECT * FROM au_event_link WHERE project_id = ? ORDER BY from_event_id', projectId);
    for (const l of links) {
      addEdge(graph, {
        id: `story:link:${l.from_event_id}:${l.to_event_id}:${l.kind}`,
        from: auEventId(l.from_event_id),
        to: auEventId(l.to_event_id),
        type: l.kind,
        scope: 'story',
        description: l.description,
        evidence: '',
        confidence: l.confidence ?? 1,
        reviewStatus: 'accepted',
      });
    }

    // Relationships between characters, with their validity window.
    const relationships = db.all<{
      id: number;
      character_a: number;
      character_b: number;
      kind: string;
      description: string;
      sentiment: string;
      valid_from_event_id: number | null;
      valid_to_event_id: number | null;
      confidence: number;
    }>('SELECT * FROM relationship WHERE project_id = ? ORDER BY id', projectId);
    for (const r of relationships) {
      addEdge(graph, {
        id: `story:relationship:${r.id}`,
        from: characterId(r.character_a),
        to: characterId(r.character_b),
        type: r.kind || 'related_to',
        scope: 'story',
        description: r.description,
        evidence: '',
        confidence: r.confidence ?? 1,
        reviewStatus: 'accepted',
        validFrom: r.valid_from_event_id ?? undefined,
        validTo: r.valid_to_event_id ?? undefined,
        extra: { sentiment: r.sentiment, relationshipId: r.id },
      });
    }

    // Plot threads and the events that develop them.
    const threads = db.all<{ id: number; title: string; description: string; status: string }>(
      'SELECT id, title, description, status FROM plot_thread WHERE project_id = ? ORDER BY id',
      projectId,
    );
    for (const t of threads) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: threadId(t.id),
        numericId: t.id,
        kind: 'plot-thread',
        scope: 'story',
        name: t.title,
        summary: t.description,
        aliases: [],
        confidence: 1,
        reviewStatus: 'accepted',
        evidence: '',
        sourceRefs: [],
        order: 0,
        extra: { status: t.status },
      });
    }
    const threadEvents = db.all<{ thread_id: number; event_id: number; kind: string }>(
      `SELECT te.thread_id, te.event_id, te.kind FROM thread_event te
       JOIN plot_thread t ON t.id = te.thread_id WHERE t.project_id = ?`,
      projectId,
    );
    for (const te of threadEvents) {
      addEdge(graph, {
        id: `story:thread:${te.thread_id}:${te.event_id}`,
        from: threadId(te.thread_id),
        to: auEventId(te.event_id),
        type: te.kind === 'introduced' ? 'introduced_by' : te.kind === 'resolved' ? 'resolved_by' : 'developed_by',
        scope: 'story',
        description: '',
        evidence: '',
        confidence: 1,
        reviewStatus: 'accepted',
      });
    }

    // Established story facts.
    const storyFacts = db.all<{
      id: number;
      kind: string;
      subject: string;
      content: string;
      certainty: string;
      subject_entity_id: number | null;
      confidence: number;
      review_status: string;
    }>('SELECT * FROM story_fact WHERE project_id = ? ORDER BY id', projectId);
    for (const f of storyFacts) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: storyFactId(f.id),
        numericId: f.id,
        kind: 'story-fact',
        scope: 'story',
        name: f.subject || f.content.slice(0, 60),
        summary: f.content,
        aliases: [],
        confidence: f.confidence ?? 1,
        reviewStatus: f.review_status ?? 'accepted',
        evidence: '',
        sourceRefs: [],
        order: 0,
        extra: { factKind: f.kind, certainty: f.certainty, subjectEntityId: f.subject_entity_id },
      });
    }

    // What each character knows: an edge to a fact, or to a standalone claim.
    const knowledge = db.all<{
      id: number;
      character_id: number;
      fact: string;
      topic: string;
      certainty: string;
      fact_id: number | null;
      source: string;
      evidence: string;
      au_event_id: number | null;
      chapter_id: number | null;
    }>(
      `SELECT * FROM character_knowledge WHERE project_id = ? ORDER BY id`,
      projectId,
    );
    for (const k of knowledge) {
      const target = k.fact_id ? storyFactId(k.fact_id) : assertionId(k.id);
      if (!k.fact_id) {
        if (graph.nodes.size >= maxNodes) break;
        addNode(graph, {
          id: target,
          numericId: k.id,
          kind: 'assertion',
          scope: 'story',
          name: k.topic || k.fact.slice(0, 60),
          summary: k.fact,
          aliases: [],
          confidence: 1,
          reviewStatus: 'accepted',
          evidence: k.evidence,
          sourceRefs: [],
          order: 0,
          extra: {
            certainty: k.certainty,
            source: k.source,
            auEventId: k.au_event_id,
            chapterId: k.chapter_id,
          },
        });
      }
      addEdge(graph, {
        id: `story:knows:${k.id}`,
        from: characterId(k.character_id),
        to: target,
        type: k.certainty || 'knows',
        scope: 'story',
        description: k.fact,
        evidence: k.evidence,
        confidence: 1,
        reviewStatus: 'accepted',
      });
    }

    // Secrets, and the motives behind what people do.
    const secrets = db.all<{
      id: number;
      title: string;
      statement: string;
      status: string;
      subject_entity_id: number | null;
    }>('SELECT * FROM secret WHERE project_id = ? ORDER BY id', projectId);
    for (const s of secrets) {
      if (graph.nodes.size >= maxNodes) break;
      addNode(graph, {
        id: secretId(s.id),
        numericId: s.id,
        kind: 'secret',
        scope: 'story',
        name: s.title,
        summary: s.statement,
        aliases: [],
        confidence: 1,
        reviewStatus: 'accepted',
        evidence: '',
        sourceRefs: [],
        order: 0,
        extra: { status: s.status, subjectEntityId: s.subject_entity_id },
      });
    }

    const motivations = db.all<{
      id: number;
      subject_type: string;
      subject_id: number;
      kind: string;
      statement: string;
      evidence: string;
      confidence: number;
      valid_from_event_id: number | null;
      valid_to_event_id: number | null;
      chapter_id: number | null;
    }>('SELECT * FROM motivation WHERE project_id = ? ORDER BY id', projectId);
    for (const m of motivations) {
      if (graph.nodes.size >= maxNodes) break;
      const nodeId = motivationId(m.id);
      addNode(graph, {
        id: nodeId,
        numericId: m.id,
        kind: 'motivation',
        scope: 'story',
        name: m.statement.slice(0, 60),
        summary: m.statement,
        aliases: [],
        confidence: m.confidence ?? 1,
        reviewStatus: 'accepted',
        evidence: m.evidence,
        sourceRefs: [],
        order: 0,
        extra: { motiveKind: m.kind, chapterId: m.chapter_id },
      });
      const subjectNode =
        m.subject_type === 'canon_entity' ? canonEntityId(m.subject_id) : characterId(m.subject_id);
      addEdge(graph, {
        id: `story:motivated-by:${m.id}`,
        from: subjectNode,
        to: nodeId,
        type: m.kind || 'motive',
        scope: 'story',
        description: m.statement,
        evidence: m.evidence,
        confidence: m.confidence ?? 1,
        reviewStatus: 'accepted',
        validFrom: m.valid_from_event_id ?? undefined,
        validTo: m.valid_to_event_id ?? undefined,
      });
    }
  }

  return graph;
}

/* ------------------------------------------------------------ traversal */

export interface TraverseOptions {
  /** Node ids to start from. */
  roots: string[];
  /** How many edges away to walk. One or two is the useful range. */
  hops?: number;
  /** Restrict to these edge types. */
  edgeTypes?: string[];
  scope?: GraphScope;
  /** Stop at nodes whose order is above this (story time). */
  beforeOrder?: number;
  /** Skip nodes whose order is below this. */
  afterOrder?: number;
  maxNodes?: number;
  maxEdges?: number;
  /** Only walk edges of this direction. */
  direction?: 'both' | 'out' | 'in';
  /** Drop edges whose endpoints fall outside the temporal window. */
  temporal?: boolean;
}

export interface TraversalResult {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** node id -> the path of edge ids from a root */
  paths: Map<string, string[]>;
  depth: Map<string, number>;
  truncated: boolean;
}

/**
 * Walk the graph outwards from a set of roots.
 *
 * Cycle protection is the visited set: a node is expanded once, so a cycle in
 * the data (which is common — people know each other in circles) cannot make
 * the walk run forever.
 */
export function traverse(graph: Graph, opts: TraverseOptions): TraversalResult {
  const hops = Math.max(0, Math.min(opts.hops ?? 1, 4));
  const maxNodes = opts.maxNodes ?? 120;
  const maxEdges = opts.maxEdges ?? 400;
  const direction = opts.direction ?? 'both';
  const edgeTypes = opts.edgeTypes?.length ? new Set(opts.edgeTypes) : null;

  const result: TraversalResult = {
    nodes: new Map(),
    edges: [],
    paths: new Map(),
    depth: new Map(),
    truncated: false,
  };

  const inScope = (edge: GraphEdge): boolean => {
    if (opts.scope && opts.scope !== 'both' && edge.scope !== 'both' && edge.scope !== opts.scope) return false;
    if (edgeTypes && !edgeTypes.has(edge.type)) return false;
    return true;
  };

  const nodeAllowed = (node: GraphNode): boolean => {
    if (opts.scope && opts.scope !== 'both' && node.scope !== opts.scope) return false;
    if (opts.temporal) {
      if (opts.beforeOrder !== undefined && node.order > opts.beforeOrder) return false;
      if (opts.afterOrder !== undefined && node.order < opts.afterOrder) return false;
    }
    return true;
  };

  const edgeAllowed = (edge: GraphEdge): boolean => {
    if (opts.temporal) {
      if (opts.beforeOrder !== undefined && edge.validFrom !== undefined && edge.validFrom > opts.beforeOrder) {
        return false;
      }
      if (opts.afterOrder !== undefined && edge.validTo !== undefined && edge.validTo < opts.afterOrder) {
        return false;
      }
    }
    return true;
  };

  let frontier: string[] = [];
  const seen = new Set<string>();

  for (const root of opts.roots) {
    const node = graph.nodes.get(root);
    if (!node) continue;
    if (!nodeAllowed(node)) continue;
    if (result.nodes.size >= maxNodes) {
      result.truncated = true;
      break;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    result.nodes.set(root, node);
    result.depth.set(root, 0);
    result.paths.set(root, []);
    frontier.push(root);
  }

  const usedEdges = new Set<string>();

  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edgeId of graph.adjacency.get(id) ?? []) {
        const edge = graph.edges.find((e) => e.id === edgeId);
        if (!edge || usedEdges.has(edge.id)) continue;
        if (!inScope(edge) || !edgeAllowed(edge)) continue;
        if (direction === 'out' && edge.from !== id) continue;
        if (direction === 'in' && edge.to !== id) continue;

        const otherId = edge.from === id ? edge.to : edge.from;
        const other = graph.nodes.get(otherId);
        if (!other) continue;
        if (!nodeAllowed(other)) continue;

        if (!usedEdges.has(edge.id)) {
          if (result.edges.length >= maxEdges) {
            result.truncated = true;
            break;
          }
          usedEdges.add(edge.id);
          result.edges.push(edge);
        }
        if (!seen.has(otherId)) {
          if (result.nodes.size >= maxNodes) {
            result.truncated = true;
            break;
          }
          seen.add(otherId);
          result.nodes.set(otherId, other);
          result.depth.set(otherId, hop);
          result.paths.set(otherId, [...(result.paths.get(id) ?? []), edge.id]);
          next.push(otherId);
        }
      }
      if (result.truncated) break;
    }
    frontier = next;
    if (result.truncated) break;
  }

  return result;
}

/* -------------------------------------------------------------- ranking */

const STOP = new Set(
  'a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those he she they them his her their we you i not no so such than too very can will just don should now do does did have has had into over under again more most other some what which who whom when where why how all any both each few own same s t d ll m o re ve y'.split(
    ' ',
  ),
);

export function terms(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** How strongly a node matches the query terms. */
export function matchScore(node: GraphNode, queryTerms: string[]): number {
  if (!queryTerms.length) return 0;
  const hay = `${node.name} ${node.aliases.join(' ')} ${node.summary}`.toLowerCase();
  let hits = 0;
  for (const t of queryTerms) {
    if (hay.includes(t)) hits++;
  }
  return hits / queryTerms.length;
}

/** Rank a traversal result: closer to the root and more confident comes first. */
export function rankNodes(result: TraversalResult, queryTerms: string[]): GraphNode[] {
  const score = (n: GraphNode): number => {
    const depth = result.depth.get(n.id) ?? 99;
    return (
      matchScore(n, queryTerms) * 3 -
      depth * 0.5 +
      (n.confidence ?? 1) * 0.25 +
      (n.reviewStatus === 'accepted' ? 0.1 : 0)
    );
  };
  return [...result.nodes.values()].sort((a, b) => score(b) - score(a));
}

/* ------------------------------------------ personalised PageRank */

export interface PprOptions {
  /** Chance of following an edge rather than jumping back to a seed. Default 0.85. */
  damping?: number;
  /** Hard cap on power-iteration rounds. Default 100. */
  maxIterations?: number;
  /** Stop when no score moves more than this. Default 1e-6. */
  tolerance?: number;
  /** Only these node kinds appear in `ranked`. Default ['canon-passage']. */
  targetKinds?: NodeKind[];
}

export interface PprScoredNode {
  id: string;
  score: number;
}

export interface PprResult {
  /** Final score per node id. Scores sum to ~1. */
  scores: Map<string, number>;
  /** Target-kind nodes, best first. */
  ranked: PprScoredNode[];
  iterations: number;
  converged: boolean;
}

function edgeWeight(edge: GraphEdge): number {
  const w = edge.extra?.weight;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * Personalised PageRank over the loaded graph: seed scores spread along
 * edges with damping until they settle, then nodes are ranked by final score.
 *
 * Spread is undirected — each edge carries weight both ways — so a passage
 * two hops out (entity -> relation -> entity -> passage) accumulates score
 * from every path that reaches it, and a passage mentioned by two seeded
 * entities outranks one mentioned by one. Nodes with no out-edges spread
 * their score uniformly instead of leaking it. The graph is a few hundred
 * nodes, so plain power iteration is plenty.
 */
export function personalizedPageRank(
  graph: Graph,
  seeds: Map<string, number> | Record<string, number>,
  opts: PprOptions = {},
): PprResult {
  const damping = opts.damping ?? 0.85;
  const maxIterations = opts.maxIterations ?? 100;
  const tolerance = opts.tolerance ?? 1e-6;
  const targetKinds = opts.targetKinds ?? (['canon-passage'] as NodeKind[]);

  const ids = [...graph.nodes.keys()];
  const n = ids.length;
  const empty: PprResult = { scores: new Map(), ranked: [], iterations: 0, converged: true };
  if (!n) return empty;

  const index = new Map(ids.map((id, i) => [id, i]));
  const out: { to: number; w: number }[][] = ids.map(() => []);
  for (const edge of graph.edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const w = edgeWeight(edge);
    out[a].push({ to: b, w });
    if (b !== a) out[b].push({ to: a, w });
  }
  const outWeight = out.map((list) => list.reduce((sum, e) => sum + e.w, 0));

  const entries = seeds instanceof Map ? [...seeds] : Object.entries(seeds);
  const personal: number[] = new Array(n).fill(0);
  let total = 0;
  for (const [id, w] of entries) {
    const i = index.get(id);
    if (i === undefined || !(w > 0)) continue;
    personal[i] += w;
    total += w;
  }
  if (total <= 0) return empty;
  for (let i = 0; i < n; i++) personal[i] /= total;

  let rank = [...personal];
  let iterations = 0;
  let converged = false;
  const jump = 1 - damping;
  while (iterations < maxIterations) {
    const next: number[] = new Array(n);
    for (let i = 0; i < n; i++) next[i] = jump * personal[i];
    let dangling = 0;
    for (let j = 0; j < n; j++) {
      const rj = rank[j];
      if (rj === 0) continue;
      const ow = outWeight[j];
      if (ow <= 0) {
        dangling += rj;
        continue;
      }
      const spread = (damping * rj) / ow;
      for (const { to, w } of out[j]) next[to] += spread * w;
    }
    if (dangling > 0) {
      const share = (damping * dangling) / n;
      for (let i = 0; i < n; i++) next[i] += share;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(next[i] - rank[i]);
      if (d > delta) delta = d;
    }
    rank = next;
    iterations++;
    if (delta < tolerance) {
      converged = true;
      break;
    }
  }

  const scores = new Map(ids.map((id, i) => [id, rank[i]] as [string, number]));
  const targets = new Set<NodeKind>(targetKinds);
  const ranked = ids
    .filter((id) => targets.has(graph.nodes.get(id)!.kind))
    .map((id) => ({ id, score: scores.get(id)! }))
    .sort((a, b) => b.score - a.score);
  return { scores, ranked, iterations, converged };
}

/* -------------------------------------------------------- root resolution */

export interface RootMatch {
  node: GraphNode;
  /** How the name matched: exact, alias, or contained. */
  via: 'exact' | 'alias' | 'contains';
}

/**
 * Find the nodes a set of names refers to.
 *
 * Names are matched against node names and aliases, exactly first, then by
 * containment, so "Serena" finds "Serena Marsh" and its canon counterpart.
 */
export function resolveRoots(graph: Graph, names: string[]): RootMatch[] {
  const out: RootMatch[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? '').trim().toLowerCase();
    if (!name) continue;
    // Every match counts, not just the first: a name can be both a canon
    // entity and a story character, and both are places to start walking.
    const exact: GraphNode[] = [];
    const alias: GraphNode[] = [];
    const contains: GraphNode[] = [];

    for (const node of graph.nodes.values()) {
      // Facts and claims are reached through their edges, not used as roots:
      // a fact called "Harry Potter's status" is not a place to start walking.
      if (node.kind === 'assertion' || node.kind === 'motivation') continue;
      if (node.kind === 'canon-fact' || node.kind === 'story-fact') continue;
      const nodeName = node.name.toLowerCase();
      if (nodeName === name) {
        exact.push(node);
        continue;
      }
      if (node.aliases.some((a) => a.toLowerCase() === name)) {
        alias.push(node);
        continue;
      }
      if (nodeName.includes(name) || name.includes(nodeName)) contains.push(node);
    }
    const chosen: RootMatch[] = [];
    for (const n of exact) chosen.push({ node: n, via: 'exact' });
    for (const n of alias) {
      if (chosen.some((x) => x.node.id === n.id)) continue;
      chosen.push({ node: n, via: 'alias' });
    }
    for (const c of contains.slice(0, 4)) {
      if (chosen.some((x) => x.node.id === c.id)) continue;
      chosen.push({ node: c, via: 'contains' });
    }
    for (const c of chosen) {
      if (seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      out.push(c);
    }
  }
  return out;
}

/* ------------------------------------------------------------- rendering */

export interface GraphContextOptions {
  query?: string;
  /** Names the scene is about. */
  focus?: string[];
  /** Anchor for the story-relative timeline (an AU event id). */
  atEventId?: number;
  hops?: number;
  maxNodes?: number;
  /** Stop the story-relative timeline here (AU events after this are not yet true). */
  beforeOrder?: number;
  scope?: GraphScope;
  edgeTypes?: string[];
  /** Maximum words of graph context. */
  maxWords?: number;
  /**
   * How to choose the roots of the walk.
   *
   * 'entity' (the default) starts from the names in the query. 'triple' first
   * looks for the relations and events the query describes, so "Serena's
   * sibling" starts from the sibling relation itself rather than from whatever
   * word happens to match a summary.
   */
  seedMode?: 'entity' | 'triple';
  /**
   * Load the association layer (alias/resemblance/co-occurrence edges).
   * Default on; set false for the layer-off arm of a comparison.
   */
  web?: boolean;
  /**
   * Dense PPR seeds (relational path only). When present and vectors are
   * stored for the model, the query is embedded once and cosine top-K
   * triples/entities/passages join the lexical seeds. Absent means purely
   * lexical seeding, exactly as before.
   */
  embed?: { embedFn?: EmbedFn; model?: string; baseUrl?: string };
  /**
   * Recognition filter for dense-only seeds (relational path only). When
   * enabled, seeds with no lexical backing are checked against their passage
   * text in one model call before PPR runs; lexical seeds are never filtered.
   * Absent or disabled means no extra call, exactly as before.
   */
  recognize?: { llm: LlmClient; enabled?: boolean; maxSeeds?: number };
}

export interface TrailStep {
  /** Display name of the node. */
  node: string;
  /** Graph kind: canon-entity, canon-event, canon-passage, ... */
  kind: string;
  /** Edge type traversed to reach this node; null on the seed step. */
  via: string | null;
}

export interface PassageTrail {
  chunkId: number;
  locator: string;
  /** PPR weight behind the passage (0 when found by words alone). */
  score: number;
  /** Root-first chain from a seed to the passage; [] means found by words. */
  steps: TrailStep[];
}

export interface GraphContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The passages that substantiate the graph claims. */
  passages: { chunkId: number; locator: string; text: string }[];
  text: string;
  truncated: boolean;
  /** Per-passage receipts, top 4 passages. Absent off the PPR path. */
  trails?: PassageTrail[];
  stats: {
    nodes: number;
    edges: number;
    passages: number;
    words: number;
    /** How the traversal was seeded: a relation, an event, or a name. */
    seedVia?: 'triple' | 'event' | 'entity';
    /** PageRank diagnostics, when the context was ranked by PPR. */
    ppr?: { nodes: number; iterations: number; converged: boolean };
    /** True when PPR found nothing and dense top-K passages filled in. */
    pprFallback?: boolean;
    /** Similarity-web edges in the loaded graph, per kind. */
    web?: { aliasEdges: number; resemblanceEdges: number; cooccurrenceEdges: number };
    /** Recognition-filter counts, when dense-only seeds were checked. */
    recognition?: { checked: number; kept: number; dropped: number };
    /** Convergence audit: corroborated passages and the deepest agreement. */
    corroborated?: { passages: number; maxSeeds: number };
  };
}

export type RelationBucket = 'family' | 'role' | 'spatial' | 'action' | 'other';

const FAMILY_WORDS = new Set(
  'sibling brother sister parent mother father son daughter child children spouse husband wife married marry cousin aunt uncle nephew niece grandfather grandmother grandson granddaughter family kin twin widow widower betrothed'.split(
    ' ',
  ),
);
const ROLE_WORDS = new Set(
  'lord lady master servant member leader king queen prince princess captain commander teacher student mentor heir knight guard soldier apprentice minister mayor chief boss owner founder head officer leads serves works'.split(
    ' ',
  ),
);
const SPATIAL_WORDS = new Set(
  'near pointing at in on inside outside above below behind beside across through into under over location lives'.split(
    ' ',
  ),
);
const ACTION_WORDS = new Set(
  'cause causes caused hunt hunts hunted break breaks broke broken breaking kill kills killed give gave takes took knows knew met meet'.split(
    ' ',
  ),
);

/**
 * The coarse bucket a relation kind belongs to, by keyword. Whole words
 * only: 'at' must not fire inside 'great'.
 */
export function relationBucket(kind: string): RelationBucket {
  const words = (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => FAMILY_WORDS.has(w))) return 'family';
  if (words.some((w) => ROLE_WORDS.has(w))) return 'role';
  if (words.some((w) => SPATIAL_WORDS.has(w))) return 'spatial';
  if (words.some((w) => ACTION_WORDS.has(w))) return 'action';
  return 'other';
}

const BUCKET_RANK: Record<RelationBucket, number> = { family: 0, role: 1, spatial: 2, action: 3, other: 4 };

/**
 * Stored edge types mapped onto the controlled vocabulary. Relation kinds
 * map to their coarse bucket; the web and mention kinds map 1:1. Nothing is
 * renamed in storage — this is a lens for ranking, not a migration.
 */
export function markerFor(edgeType: string): string {
  switch (edgeType) {
    case 'alias_of':
      return 'ALIAS';
    case 'mentions_in':
      return 'MENTIONED_IN';
    case 'resembles':
      return 'SEMANTICALLY_SIMILAR';
    case 'appears_with':
      return 'REPEATED_CO_OCCURRENCE';
    default:
      return relationBucket(edgeType).toUpperCase();
  }
}

/**
 * Family composition: answer from the web instead of mining.
 *
 * Two banked ties imply a third through one middle person — Dudley son of
 * Mrs Dursley plus Mrs Dursley aunt of Harry means Dudley cousin of Harry —
 * with no new reading. Only the closed family table below composes; friend
 * of a friend proves nothing. One hop only: composed answers never feed
 * another composition, so a wrong row cannot cascade. Nothing is banked.
 */
type FamilyBase = 'child' | 'parent' | 'sibling' | 'spouse' | 'aunt-or-uncle' | 'cousin' | 'grandparent' | 'nephew-or-niece';

const FAMILY_BASES: ReadonlyMap<string, FamilyBase> = new Map([
  ['child of', 'child'], ['son of', 'child'], ['daughter of', 'child'],
  ['parent of', 'parent'], ['mother of', 'parent'], ['father of', 'parent'],
  ['sibling of', 'sibling'], ['brother of', 'sibling'], ['sister of', 'sibling'],
  ['spouse of', 'spouse'], ['wife of', 'spouse'], ['husband of', 'spouse'], ['married to', 'spouse'], ['married', 'spouse'],
  ['aunt of', 'aunt-or-uncle'], ['uncle of', 'aunt-or-uncle'],
  ['nephew of', 'nephew-or-niece'], ['niece of', 'nephew-or-niece'],
  ['cousin of', 'cousin'],
  ['grandparent of', 'grandparent'], ['grandmother of', 'grandparent'], ['grandfather of', 'grandparent'],
]);

const INVERSE_BASE: Record<FamilyBase, FamilyBase> = {
  child: 'parent', parent: 'child', sibling: 'sibling', spouse: 'spouse',
  'aunt-or-uncle': 'nephew-or-niece', 'nephew-or-niece': 'aunt-or-uncle', cousin: 'cousin', grandparent: 'grandparent',
};

/** X-R1-Y plus Y-R2-Z implies X-RESULT-Z. Ungendered outputs only: the web
 * never knows which gendered word the source would use. */
const COMPOSE: ReadonlyMap<string, string> = new Map([
  ['child+aunt-or-uncle', 'cousin of'],
  ['child+parent', 'sibling of'],
  ['child+spouse', 'parent of'],
  ['child+sibling', 'relative of'],
  ['parent+parent', 'grandparent of'],
  ['parent+sibling', 'parent of'],
  ['sibling+parent', 'relative of'],
  ['sibling+child', 'child of'],
  ['spouse+child', 'parent of'],
  ['aunt-or-uncle+parent', 'relative of'],
]);

const INVERT_LABEL: ReadonlyMap<string, string> = new Map([
  ['child of', 'parent of'], ['son of', 'parent of'], ['daughter of', 'parent of'],
  ['parent of', 'child of'], ['mother of', 'child of'], ['father of', 'child of'],
]);

export interface ComposedPath {
  /** The middle person the answer walks through. */
  via: string;
  /** The implied tie, X to Y. */
  label: string;
}

/**
 * A composed family path between two entities, if accepted rows imply one.
 * Only rows nobody disputes count: accepted review, uncontested. Read-only.
 */
export function findComposedPath(db: Db, projectId: number, aId: number, bId: number): ComposedPath | null {
  if (aId === bId) return null;
  const rows = db.all<{ f: number; t: number; kind: string; fn: string; tn: string }>(
    `SELECT r.from_entity AS f, r.to_entity AS t, r.kind AS kind, fe.name AS fn, te.name AS tn
       FROM canon_relation r
       JOIN canon_entity fe ON fe.id = r.from_entity
       JOIN canon_entity te ON te.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'accepted'
        AND (r.from_entity = ? OR r.to_entity = ? OR r.from_entity = ? OR r.to_entity = ?)
      ORDER BY r.id`,
    projectId, aId, aId, bId, bId,
  );
  // Oriented edges out of each endpoint: base label as seen from X toward Y.
  const oriented = (x: number, r: { f: number; t: number; kind: string }): { base: FamilyBase; mid: number; name: string } | null => {
    const base = FAMILY_BASES.get(r.kind.trim().toLowerCase());
    if (!base) return null;
    if (r.f === x) return { base, mid: r.t, name: '' };
    if (r.t === x) return { base: INVERSE_BASE[base], mid: r.f, name: '' };
    return null;
  };
  const names = new Map<number, string>();
  for (const r of rows) { names.set(r.f, r.fn); names.set(r.t, r.tn); }
  // Edges out of X toward the middle, in X-to-middle reading.
  const towardMid = (z: number, r: { f: number; t: number; kind: string }): { base: FamilyBase; mid: number } | null => {
    const base = FAMILY_BASES.get(r.kind.trim().toLowerCase());
    if (!base) return null;
    if (r.t === z) return { base, mid: r.f }; // edge runs mid -> Z with base label
    if (r.f === z) return { base: INVERSE_BASE[base], mid: r.t }; // edge runs Z -> mid; read backwards
    return null;
  };
  const aOut = rows.map((r) => ({ r, o: oriented(aId, r) })).filter((x) => x.o && x.o.mid !== bId);
  const zIn = rows.map((r) => ({ r, o: towardMid(bId, r) })).filter((x) => x.o && x.o.mid !== aId);
  const hits: { via: string; label: string }[] = [];
  for (const a of aOut) {
    for (const z of zIn) {
      if (a.o!.mid !== z.o!.mid) continue;
      const label = COMPOSE.get(`${a.o!.base}+${z.o!.base}`);
      if (!label) continue;
      hits.push({ via: names.get(a.o!.mid) ?? '?', label });
    }
  }
  // Same search with the endpoints swapped, inverting the answer.
  const bOut = rows.map((r) => ({ r, o: oriented(bId, r) })).filter((x) => x.o && x.o.mid !== aId);
  const aIn = rows.map((r) => ({ r, o: towardMid(aId, r) })).filter((x) => x.o && x.o.mid !== bId);
  for (const b of bOut) {
    for (const a of aIn) {
      if (b.o!.mid !== a.o!.mid) continue;
      const label = COMPOSE.get(`${b.o!.base}+${a.o!.base}`);
      if (!label) continue;
      hits.push({ via: names.get(b.o!.mid) ?? '?', label: INVERT_LABEL.get(label) ?? label });
    }
  }
  if (!hits.length) return null;
  hits.sort((x, y) => (x.via < y.via ? -1 : x.via > y.via ? 1 : x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
  return hits[0]!;
}
/**
 *
 * A multi-hop question names a relationship, not an entity: "who is Serena's
 * sister" is answered by the sibling edge, and starting from the word "sister"
 * finds nothing. So the relation triples and events that match the query are
 * tried before falling back to names.
 */
export function resolveQuerySeeds(
  graph: Graph,
  query: string,
  focus: string[] = [],
): { roots: string[]; via: 'triple' | 'event' | 'entity' } {
  const queryTerms = terms((query ?? '').replace(/['’]s\b/g, ''));
  const focusNames = focus.map((f) => f.trim().toLowerCase()).filter(Boolean);
  const roots = new Set<string>();

  const namesInText = (node: GraphNode): boolean =>
    [node.name, ...node.aliases].some((n) => {
      const ln = n.toLowerCase();
      return (
        focusNames.some((f) => ln.includes(f) || f.includes(ln)) ||
        queryTerms.some((t) => ln.includes(t))
      );
    });

  // 1. A relation triple the query describes, with at least one endpoint named.
  //    Web edges (alias/resemblance/co-occurrence) carry no claim and never
  //    seed, even if a query word brushes their type name.
  //    Family and role ties outrank spatial and action ones: when a query
  //    matches both "X's sister near Y" and "X walks near Y", the kinship is
  //    the answer and the whereabouts are trivia. Stable sort, so ties keep
  //    database order exactly as before.
  const tripleHits: { edge: (typeof graph.edges)[number]; rank: number; at: number }[] = [];
  for (const edge of graph.edges) {
    if (edge.type === 'alias_of' || edge.type === 'resembles' || edge.type === 'appears_with') continue;
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (!from || !to) continue;
    if (from.kind !== 'canon-entity' && from.kind !== 'character') continue;
    if (to.kind !== 'canon-entity' && to.kind !== 'character') continue;
    const label = `${edge.type} ${edge.description}`.toLowerCase();
    if (!queryTerms.some((t) => label.includes(t))) continue;
    if (!namesInText(from) && !namesInText(to)) continue;
    tripleHits.push({ edge, rank: BUCKET_RANK[relationBucket(edge.type)], at: tripleHits.length });
  }
  tripleHits.sort((a, b) => a.rank - b.rank || a.at - b.at);
  for (const { edge } of tripleHits) {
    roots.add(edge.from);
    roots.add(edge.to);
  }
  if (roots.size) return { roots: [...roots].slice(0, 10), via: 'triple' };

  // 2. An event the query names.
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'canon-event' && node.kind !== 'au-event') continue;
    const hay = `${node.name} ${node.summary} ${node.aliases.join(' ')}`.toLowerCase();
    const hits = queryTerms.filter((t) => hay.includes(t)).length;
    const focusHit = focusNames.some((f) => hay.includes(f));
    if (hits >= 2 || (hits >= 1 && focusHit)) roots.add(node.id);
  }
  if (roots.size) return { roots: [...roots].slice(0, 10), via: 'event' };

  // 3. The old path: the names in the query.
  return {
    roots: resolveRoots(graph, focus.length ? focus : queryTerms.slice(0, 3)).map((r) => r.node.id),
    via: 'entity',
  };
}

/**
 * Build a compact, ranked graph context for a scene.
 *
 * The graph tells you what is connected; the passages underneath it tell you
 * whether to believe it. Both are returned: the claims with their provenance,
 * and the source text that supports them.
 */
export function buildGraphContext(
  db: Db,
  projectId: number,
  opts: GraphContextOptions = {},
): GraphContext {
  const graph = loadGraph(db, projectId, { scope: opts.scope, web: opts.web });
  const queryTerms = terms(opts.query ?? '');
  const focusNames = opts.focus ?? [];

  let beforeOrder = opts.beforeOrder;
  if (opts.atEventId !== undefined) {
    const anchor = db.get<{ story_order: number }>('SELECT story_order FROM au_event WHERE id = ?', opts.atEventId);
    if (anchor) beforeOrder = anchor.story_order;
  }

  const seed =
    opts.seedMode === 'triple'
      ? resolveQuerySeeds(graph, opts.query ?? '', focusNames)
      : {
          roots: resolveRoots(graph, focusNames.length ? focusNames : queryTerms.slice(0, 3)).map((r) => r.node.id),
          via: 'entity' as const,
        };
  const result = traverse(graph, {
    roots: seed.roots,
    hops: opts.hops ?? 1,
    scope: opts.scope,
    edgeTypes: opts.edgeTypes,
    beforeOrder,
    temporal: true,
    maxNodes: opts.maxNodes ?? 40,
  });

  const ranked = rankNodes(result, queryTerms);
  const nodeIds = new Set(ranked.map((n) => n.id));
  const edges = result.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  // The passages that substantiate the claims.
  const chunkIds = new Set<number>();
  for (const node of ranked) {
    for (const ref of node.sourceRefs) if (typeof ref.chunk === 'number') chunkIds.add(ref.chunk);
    const first = node.extra?.firstChunk;
    if (typeof first === 'number') chunkIds.add(first);
    const chunkId = node.extra?.chunkId;
    if (typeof chunkId === 'number') chunkIds.add(chunkId);
  }
  const passages: GraphContext['passages'] = [];
  for (const chunkId of chunkIds) {
    const row = db.get<{ id: number; locator: string; text: string }>(
      'SELECT id, locator, text FROM canon_chunk WHERE id = ? AND project_id = ?',
      chunkId,
      projectId,
    );
    if (row) passages.push({ chunkId: row.id, locator: row.locator, text: row.text });
  }

  const maxWords = opts.maxWords ?? 900;
  const { text: finalText, truncated: textTruncated } = renderGraphContext(
    ranked,
    edges,
    passages,
    queryTerms,
    maxWords,
  );
  const truncated = result.truncated || textTruncated;

  return {
    nodes: ranked,
    edges,
    passages,
    text: finalText,
    truncated,
    stats: {
      nodes: ranked.length,
      edges: edges.length,
      passages: passages.length,
      words: finalText.split(/\s+/).length,
      seedVia: seed.via,
      web: countWebEdges(graph),
    },
  };
}

export interface DenseSeed {
  id: string;
  w: number;
}

export interface DensePassage {
  chunkId: number;
  score: number;
}

/**
 * Merge dense seeds into lexical ones. Lexical weight always wins a tie:
 * what the query names outranks what it merely resembles.
 */
export function mergeSeedWeights(
  lexical: Map<string, number>,
  dense: DenseSeed[],
): { merged: Map<string, number>; added: number } {
  const merged = new Map(lexical);
  let added = 0;
  for (const { id, w } of dense) {
    if (!merged.has(id)) {
      merged.set(id, w);
      added++;
    }
  }
  return { merged, added };
}

/**
 * Cosine top-K seeds from stored vectors: triples/entities at 0.8, passages
 * at 0.3. A triple seeds both its endpoints, the way triple-seeding does.
 * Returns nothing when no vectors are stored for the model or the query
 * cannot be embedded — the caller then behaves exactly as lexical-only.
 */
export async function resolveDenseSeeds(
  db: Db,
  projectId: number,
  graph: Graph,
  query: string,
  cfg: { embedFn?: EmbedFn; model?: string; baseUrl?: string },
): Promise<{ seeds: DenseSeed[]; passages: DensePassage[] }> {
  const none = { seeds: [] as DenseSeed[], passages: [] as DensePassage[] };
  const model = cfg.model ?? DEFAULT_EMBED_MODEL;
  const stored = readVectors(db, projectId, model);
  if (!stored.length || !query.trim()) return none;
  const embed = cfg.embedFn ?? ((texts: string[]) => embedTexts(texts, { baseUrl: cfg.baseUrl ?? 'http://127.0.0.1:11434', model }));
  const qvec = (await embed([query]))?.[0];
  if (!qvec) return none;

  const scored = stored
    .map((s) => ({ ...s, score: cosine(qvec, s.vec) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const seeds: DenseSeed[] = [];
  for (const hit of scored.filter((s) => s.kind !== 'passage').slice(0, 8)) {
    if (hit.kind === 'entity') {
      if (graph.nodes.has(hit.ref)) seeds.push({ id: hit.ref, w: 0.8 });
      continue;
    }
    const edge = graph.edges.find((e) => e.id === hit.ref);
    if (!edge) continue;
    seeds.push({ id: edge.from, w: 0.8 }, { id: edge.to, w: 0.8 });
  }
  const passages: DensePassage[] = [];
  for (const hit of scored.filter((s) => s.kind === 'passage').slice(0, 4)) {
    const chunkId = Number(hit.ref);
    if (Number.isFinite(chunkId)) passages.push({ chunkId, score: hit.score });
  }
  return { seeds, passages };
}

/**
 * Graph context ranked by personalised PageRank instead of the hop walk.
 *
 * Seeds are the same triple/event matches the triple-seeded walk uses, plus
 * the passages those seeds mention at low weight; PPR then spreads along
 * every edge — including mention edges — and the top passages fill the
 * passage budget. The candidate set is the same graph the walk uses; only
 * the ranking changes. Returns the same shape as buildGraphContext, plus
 * `stats.ppr`. When PPR finds nothing, the passages fall back to exactly
 * today's reference-backed list (today's FTS5 top-K covers the rest).
 */
/** Longest chain a trail records; the passage end is always kept. */
const TRAIL_MAX_STEPS = 6;
/** BFS horizon for passages PPR surfaced past the walk. */
const TRAIL_BFS_DEPTH = 8;

/**
 * Per-passage receipts: the labeled chain from a seed to each passage.
 *
 * Each passage resolves to a source node — the PPR passage node by chunk
 * first, else the ranked node whose references produced the chunk. The chain
 * is the recorded walk backward from that node; when PPR surfaced a passage
 * past the walk horizon, the shortest path over the full graph stands in
 * (PPR did spread along those edges — the walk just didn't record it).
 * Passages with no path from any seed get empty steps: found by words.
 */
export function buildPassageTrails(
  graph: Graph,
  result: TraversalResult,
  ranked: GraphNode[],
  ppr: PprResult,
  passages: GraphContext['passages'],
): PassageTrail[] {
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  const nameOf = (id: string): { name: string; kind: string } => {
    const n = graph.nodes.get(id);
    return { name: n?.name ?? id, kind: n?.kind ?? 'unknown' };
  };
  const linkType = (a: string, b: string): string | null => {
    for (const edgeId of graph.adjacency.get(a) ?? []) {
      const edge = edgeById.get(edgeId);
      if (edge && (edge.from === b || edge.to === b)) return edge.type;
    }
    return null;
  };
  const toSteps = (nodePath: string[]): TrailStep[] => {
    const truncated = nodePath.length > TRAIL_MAX_STEPS;
    const kept = truncated ? nodePath.slice(-TRAIL_MAX_STEPS) : nodePath;
    return kept.map((id, i) => {
      const { name, kind } = nameOf(id);
      if (i === 0 && !truncated) return { node: name, kind, via: null };
      const prevId = truncated && i === 0 ? nodePath[nodePath.length - kept.length - 1]! : kept[i - 1]!;
      return { node: name, kind, via: linkType(prevId, id) };
    });
  };
  // Shortest node path from any effective seed root to the target.
  const bfsPath = (roots: string[], target: string): string[] | undefined => {
    if (roots.includes(target)) return [target];
    const prev = new Map<string, string>();
    const seen = new Set<string>(roots);
    let frontier = [...roots];
    for (let depth = 0; depth < TRAIL_BFS_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edgeId of graph.adjacency.get(id) ?? []) {
          const edge = edgeById.get(edgeId);
          if (!edge) continue;
          const other = edge.from === id ? edge.to : edge.from;
          if (seen.has(other)) continue;
          seen.add(other);
          prev.set(other, id);
          if (other === target) {
            const path: string[] = [target];
            let cur: string | undefined = target;
            let guard = graph.nodes.size + 1;
            while (guard-- > 0) {
              const step: string | undefined = cur === undefined ? undefined : prev.get(cur);
              if (step === undefined) break;
              path.unshift(step);
              cur = step;
            }
            return path;
          }
          next.push(other);
        }
      }
      frontier = next;
    }
    return undefined;
  };

  const roots = [...result.paths.keys()].filter((id) => (result.paths.get(id)?.length ?? 0) === 0);
  const out: PassageTrail[] = [];
  for (const p of passages.slice(0, 4)) {
    let source = graph.nodes.get(canonPassageId(p.chunkId));
    if (source && source.kind !== 'canon-passage') source = undefined;
    let score = source ? (ppr.scores.get(source.id) ?? 0) : 0;
    if (!source) {
      const owner = ranked.find(
        (n) =>
          n.sourceRefs.some((r) => r.chunk === p.chunkId) ||
          n.extra?.firstChunk === p.chunkId ||
          n.extra?.chunkId === p.chunkId,
      );
      if (owner) {
        source = owner;
        score = ppr.scores.get(owner.id) ?? 0;
      }
    }
    if (!source) {
      out.push({ chunkId: p.chunkId, locator: p.locator, score: 0, steps: [] });
      continue;
    }
    let nodePath: string[] | undefined;
    const recorded = result.paths.get(source.id);
    if (recorded) {
      const path = [source.id];
      let cur = source.id;
      let ok = true;
      for (const eid of [...recorded].reverse()) {
        const edge = edgeById.get(eid);
        if (!edge || (edge.from !== cur && edge.to !== cur)) {
          ok = false;
          break;
        }
        cur = edge.from === cur ? edge.to : edge.from;
        path.unshift(cur);
      }
      if (ok) nodePath = path;
    }
    nodePath ??= bfsPath(roots, source.id);
    if (!nodePath) {
      out.push({ chunkId: p.chunkId, locator: p.locator, score, steps: [] });
      continue;
    }
    out.push({ chunkId: p.chunkId, locator: p.locator, score, steps: toSteps(nodePath) });
  }
  return out;
}

export interface CorroborationCandidate {
  chunkId: number;
  score: number;
  /** Distinct seed roots reaching this passage. */
  seeds: number;
}

/**
 * Order PPR passage candidates: score first, chunk id to break ties, then
 * one adjacent float pass where a corroborated (>=2 seeds) passage rises
 * above a single-seed neighbor. Each passage moves at most one slot, so PPR
 * order stays primary and the pass is fully deterministic.
 */
export function orderCorroborated(candidates: CorroborationCandidate[]): CorroborationCandidate[] {
  const ordered = [...candidates].sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (curr.seeds >= 2 && prev.seeds < 2) {
      ordered[i - 1] = curr;
      ordered[i] = prev;
    }
  }
  return ordered;
}

export async function buildPprGraphContext(
  db: Db,
  projectId: number,
  opts: GraphContextOptions = {},
): Promise<GraphContext> {
  const graph = loadGraph(db, projectId, { scope: opts.scope, web: opts.web });
  const queryTerms = terms(opts.query ?? '');
  const focusNames = opts.focus ?? [];

  let beforeOrder = opts.beforeOrder;
  if (opts.atEventId !== undefined) {
    const anchor = db.get<{ story_order: number }>('SELECT story_order FROM au_event WHERE id = ?', opts.atEventId);
    if (anchor) beforeOrder = anchor.story_order;
  }

  // Same triple/event seeding the hop walk uses.
  const seed = resolveQuerySeeds(graph, opts.query ?? '', focusNames);
  let weights = new Map<string, number>();
  for (const root of seed.roots) weights.set(root, 1);
  // The passages the seeds mention start with a little weight of their own,
  // so evidence near a seed outranks evidence several hops out.
  for (const root of seed.roots) {
    for (const edgeId of graph.adjacency.get(root) ?? []) {
      const edge = graph.edges.find((e) => e.id === edgeId);
      if (!edge) continue;
      const other = edge.from === root ? edge.to : edge.from;
      const node = graph.nodes.get(other);
      if (!node || node.kind !== 'canon-passage') continue;
      if (!weights.has(other)) weights.set(other, 0.2);
    }
  }
  // Dense seeds: the query embedded once, cosine top-K over stored vectors.
  // Lexical weight wins ties; the PPR call itself is untouched.
  let densePassages: DensePassage[] = [];
  let recognition: { checked: number; kept: number; dropped: number } | undefined;
  const lexicalIds = new Set(weights.keys());
  if (opts.embed) {
    const dense = await resolveDenseSeeds(db, projectId, graph, opts.query ?? '', opts.embed);
    weights = mergeSeedWeights(weights, dense.seeds).merged;
    densePassages = dense.passages;
  }
  // Recognition filter: dense-only seeds (resemblance without lexical
  // backing) are checked against their passage text before PPR spreads
  // their scores. Lexical seeds are never filtered.
  const rec = opts.recognize;
  if (rec?.enabled) {
    const denseOnly = [...weights.keys()]
      .filter((id) => !lexicalIds.has(id))
      .map((id) => ({ id, w: weights.get(id)! }));
    if (denseOnly.length) {
      const verdicts = await filterDenseSeeds(rec.llm, denseOnly, graph, db, projectId, {
        query: opts.query ?? '',
        maxSeeds: rec.maxSeeds,
        lexicalIds,
      });
      for (const d of verdicts.dropped) weights.delete(d.id);
      recognition = { checked: verdicts.checked, kept: verdicts.kept.length, dropped: verdicts.dropped.length };
    }
  }
  const ppr = personalizedPageRank(graph, weights);

  const result = traverse(graph, {
    roots: seed.roots,
    hops: opts.hops ?? 1,
    scope: opts.scope,
    edgeTypes: opts.edgeTypes,
    beforeOrder,
    temporal: true,
    maxNodes: opts.maxNodes ?? 40,
  });

  const ranked = rankNodes(result, queryTerms);
  const nodeIds = new Set(ranked.map((n) => n.id));
  const edges = result.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  // Convergence audit: one walk per seed root (skipped when there is
  // nothing to converge), counting the distinct seeds reaching each
  // passage. No model calls — small in-memory graphs, microseconds each.
  const reach = new Map<string, number>();
  if (seed.roots.length > 1) {
    for (const root of seed.roots) {
      const one = traverse(graph, {
        roots: [root],
        hops: opts.hops ?? 1,
        scope: opts.scope,
        edgeTypes: opts.edgeTypes,
        beforeOrder,
        temporal: true,
        maxNodes: opts.maxNodes ?? 40,
      });
      for (const [id, node] of one.nodes) {
        if (node.kind === 'canon-passage') reach.set(id, (reach.get(id) ?? 0) + 1);
      }
    }
  }
  // Passages in PPR order first; the reference-backed ones from the walked
  // nodes after. When PPR finds nothing, this is exactly today's list.
  // Corroborated passages (2+ seeds) float one slot above single-seed
  // neighbors of adjacent PPR rank; everything else keeps PPR order.
  const seenChunks = new Set<number>();
  const orderedChunkIds: number[] = [];
  const pprCandidates: CorroborationCandidate[] = [];
  for (const { id, score } of ppr.ranked.slice(0, 12)) {
    if (score <= 0) continue;
    const chunkId = graph.nodes.get(id)?.numericId;
    if (typeof chunkId !== 'number' || pprCandidates.some((c) => c.chunkId === chunkId)) continue;
    pprCandidates.push({ chunkId, score, seeds: reach.get(id) ?? 0 });
  }
  let corroborated: { passages: number; maxSeeds: number } | undefined;
  if (seed.roots.length > 1) {
    let maxSeeds = 0;
    for (const c of pprCandidates) maxSeeds = Math.max(maxSeeds, c.seeds);
    const floated = orderCorroborated(pprCandidates);
    let met = 0;
    for (const c of floated) {
      if (seenChunks.has(c.chunkId)) continue;
      seenChunks.add(c.chunkId);
      orderedChunkIds.push(c.chunkId);
      if (c.seeds >= 2) met++;
    }
    corroborated = { passages: met, maxSeeds };
  } else {
    for (const c of pprCandidates) {
      if (seenChunks.has(c.chunkId)) continue;
      seenChunks.add(c.chunkId);
      orderedChunkIds.push(c.chunkId);
    }
  }
  for (const node of ranked) {
    for (const ref of node.sourceRefs) {
      if (typeof ref.chunk === 'number' && !seenChunks.has(ref.chunk)) {
        seenChunks.add(ref.chunk);
        orderedChunkIds.push(ref.chunk);
      }
    }
    const first = node.extra?.firstChunk;
    if (typeof first === 'number' && !seenChunks.has(first)) {
      seenChunks.add(first);
      orderedChunkIds.push(first);
    }
    const chunkId = node.extra?.chunkId;
    if (typeof chunkId === 'number' && !seenChunks.has(chunkId)) {
      seenChunks.add(chunkId);
      orderedChunkIds.push(chunkId);
    }
  }
  // DPR-style fallback without embeddings-in-the-loop: when PPR and the
  // walked references both come up empty but dense passages exist, the dense
  // top-K fills the passage budget instead of an empty package.
  let pprFallback = false;
  if (orderedChunkIds.length === 0 && densePassages.length > 0) {
    for (const { chunkId } of densePassages) {
      if (!orderedChunkIds.includes(chunkId)) orderedChunkIds.push(chunkId);
    }
    pprFallback = true;
  }
  const passages: GraphContext['passages'] = [];
  for (const chunkId of orderedChunkIds) {
    const row = db.get<{ id: number; locator: string; text: string }>(
      'SELECT id, locator, text FROM canon_chunk WHERE id = ? AND project_id = ?',
      chunkId,
      projectId,
    );
    if (row) passages.push({ chunkId: row.id, locator: row.locator, text: row.text });
  }

  // Receipts: the labeled chain behind each top passage. Recording only:
  // ranking, order, budgets and text are untouched.
  const trails = buildPassageTrails(graph, result, ranked, ppr, passages);

  const maxWords = opts.maxWords ?? 900;
  const { text: pprText, truncated: textTruncated } = renderGraphContext(
    ranked,
    edges,
    passages,
    queryTerms,
    maxWords,
  );
  const truncated = result.truncated || textTruncated;

  return {
    nodes: ranked,
    edges,
    passages,
    text: pprText,
    truncated,
    trails,
    stats: {
      nodes: ranked.length,
      edges: edges.length,
      passages: passages.length,
      words: pprText.split(/\s+/).length,
      seedVia: seed.via,
      ppr: { nodes: graph.nodes.size, iterations: ppr.iterations, converged: ppr.converged },
      ...(pprFallback ? { pprFallback: true } : {}),
      ...(recognition ? { recognition } : {}),
      ...(corroborated ? { corroborated } : {}),
      web: countWebEdges(graph),
    },
  };
}

/**
 * Render a graph context as the text the model sees.
 *
 * The sections are ordered by how much they help a scene: the connections
 * first, then the facts, then the people, then the events. The word budget
 * is spent in that order, so the most useful part never gets cut.
 */
export function renderGraphContext(
  nodes: GraphNode[],
  edges: GraphEdge[],
  passages: GraphContext['passages'],
  queryTerms: string[] = [],
  maxWords = Infinity,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  const nameOf = (id: string): string => nodes.find((n) => n.id === id)?.name ?? id;

  /**
   * Add a section, trimming it to the remaining budget rather than dropping
   * it: a long list of connections is still useful when it is cut short.
   */
  /** Where a claim came from, when there is no quote to show. */
  const citation = (refs?: SourceRef[]): string => {
    if (!refs?.length) return '';
    const first = refs[0];
    return first.locator ? ` (${first.locator})` : '';
  };

  /**
   * Render a quotation, keeping the closing mark even when the text is cut.
   *
   * A quotation that is not closed cannot be told apart from a description,
   * and the model has to be able to tell them apart.
   */
  const quoted = (text: string, max = 100): string => {
    const clean = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (clean.length <= max) return `“${clean}”`;
    return `“${clean.slice(0, max).trimEnd()}…”`;
  };

  /**
   * Where a node's claim came from: a quotation, a passage location, a
   * chapter — or, when there is nothing, a note that the claim is unbacked.
   *
   * The distinction matters: a claim with a passage pointer is a claim you
   * can check, and a claim with neither is a guess, and the model should be
   * able to tell them apart.
   */
  const nodeCitation = (node: GraphNode): string => {
    if (node.evidence) return ` ${quoted(node.evidence, 100)}`;
    const chapter = node.extra?.chapterId;
    if (typeof chapter === 'number') return ` (chapter ${chapter})`;
    const where = citation(node.sourceRefs);
    if (where) return `${where} [no quotation]`;
    if (node.reviewStatus && node.reviewStatus !== 'accepted') return ` [${node.reviewStatus}]`;
    return ' [unbacked claim]';
  };

  /** Where a relation came from, when it has no quotation of its own. */
  const edgeCitation = (edge: GraphEdge): string => {
    const where = citation(edge.sourceRefs);
    if (where) return `${where} [no quotation]`;
    if (edge.reviewStatus && edge.reviewStatus !== 'accepted') return ` [${edge.reviewStatus}]`;
    return ' [unbacked claim]';
  };

  const add = (section: string) => {
    const lines = section.split('\n');
    const header = lines[0];
    const body = lines.slice(1);
    const headerWords = header.split(/\s+/).filter(Boolean).length;
    let remaining = maxWords - used - headerWords;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const kept: string[] = [];
    for (const line of body) {
      const w = line.split(/\s+/).filter(Boolean).length;
      if (w > remaining) {
        truncated = true;
        break;
      }
      kept.push(line);
      remaining -= w;
    }
    if (kept.length < body.length) truncated = true;
    used += headerWords + body.slice(0, kept.length).join(' ').split(/\s+/).filter(Boolean).length;
    parts.push(kept.length ? [header, ...kept].join('\n') : header);
  };

  // Participation edges are numerous and repetitive: one per person per
  // event. Listing them floods the context and pushes the relationships that
  // matter out of it, so they are summarised instead.
  const NAVIGATIONAL = new Set([
    'participates_in',
    'appears_in',
    'describes',
    'introduced_by',
    'developed_by',
    'resolved_by',
  ]);
  // Mention edges are ranker infrastructure, not claims: they say where an
  // entity was seen, which the passages underneath already show.
  const shown = edges.filter(
    (e) => e.type !== 'mentions_in' && e.type !== 'alias_of' && e.type !== 'resembles' && e.type !== 'appears_with',
  );
  const relationEdges = shown.filter((e) => !NAVIGATIONAL.has(e.type));
  const navigational = shown.filter((e) => NAVIGATIONAL.has(e.type));

  if (relationEdges.length) {
    const lines = relationEdges
      .slice(0, 40)
      .map((e) => {
        const marker = e.confidence < 0.6 ? ' [uncertain]' : '';
        const note = e.description ? ` — ${e.description}` : '';
        const target = nodes.find((n) => n.id === e.to);
        const evidence = e.evidence
          ? ` ${quoted(e.evidence, 80)}`
          : (target && nodeCitation(target)) || edgeCitation(e);
        const window =
          e.validFrom !== undefined || e.validTo !== undefined
            ? ` (valid ${e.validFrom ?? 'start'}..${e.validTo ?? 'now'})`
            : '';
        return `- ${nameOf(e.from)} --${e.type}--> ${nameOf(e.to)}${note}${window}${marker}${evidence}`;
      });
    add(`CONNECTIONS:\n${lines.join('\n')}`);
  }

  if (navigational.length) {
    // One line per person: how many events they are in, and which.
    const byPerson = new Map<string, string[]>();
    for (const e of navigational) {
      const who = nameOf(e.from);
      const what = nameOf(e.to);
      byPerson.set(who, [...(byPerson.get(who) ?? []), what]);
    }
    const lines = [...byPerson].map(([who, what]) => {
      const shown = what.slice(0, 4).join('; ');
      const rest = what.length > 4 ? ` (+${what.length - 4} more)` : '';
      return `- ${who} is in ${what.length} scene${what.length === 1 ? '' : 's'}: ${shown}${rest}`;
    });
    add(`WHERE PEOPLE ARE:\n${lines.join('\n')}`);
  }

  const people = nodes.filter((n) => n.kind === 'canon-entity' || n.kind === 'character');
  if (people.length) {
    add(
      'CONNECTED PEOPLE AND PLACES:\n' +
        people
          .slice(0, 20)
          .map((n) => {
            const bits = [n.summary, n.extra?.role ? `role: ${n.extra.role}` : '', n.extra?.status ? `status: ${n.extra.status}` : '']
              .filter(Boolean)
              .join('. ');
            const unsure = n.confidence < 0.6 ? ' [uncertain]' : '';
            // Every description carries where it came from, so a claim with no
            // quotation is still traceable to a passage.
            return `- ${n.name}${n.aliases.length ? ` (${n.aliases.slice(0, 3).join(', ')})` : ''}${bits ? `: ${bits}` : ''}${unsure}${nodeCitation(n)}`;
          })
          .join('\n'),
    );
  }

  const facts = nodes.filter((n) => n.kind === 'canon-fact' || n.kind === 'story-fact' || n.kind === 'assertion' || n.kind === 'secret');
  if (facts.length) {
    add(
      'CONNECTED FACTS:\n' +
        facts
          .slice(0, 25)
          .map((n) => {
            const label = n.kind === 'assertion' ? n.extra?.certainty : n.kind;
            const unsure = n.confidence < 0.6 || n.extra?.certainty === 'inferred' ? ' [inferred]' : '';
            const evidence = nodeCitation(n);
            return `- ${n.summary} (${label}${unsure})${evidence}`;
          })
          .join('\n'),
    );
  }

  const events = nodes.filter((n) => n.kind === 'au-event' || n.kind === 'canon-event');
  if (events.length) {
    add(
      'CONNECTED EVENTS:\n' +
        events
          .slice(0, 20)
          .map((n) => {
            const when = n.extra?.storyTime || n.extra?.timeLabel || '';
            const change = n.extra?.divergenceNote ? ` — changed from canon: ${n.extra.divergenceNote}` : '';
            const kind = n.extra?.kind && n.extra.kind !== 'event' ? ` [${n.extra.kind}]` : '';
            return `- ${when ? `${when}: ` : ''}${n.name}${kind}: ${n.summary}${change}${nodeCitation(n)}`;
          })
          .join('\n'),
    );
  }

  const motives = nodes.filter((n) => n.kind === 'motivation');
  if (motives.length) {
    add(
      'MOTIVES:\n' +
        motives.slice(0, 10).map((n) => `- ${n.summary}${nodeCitation(n)}`).join('\n'),
    );
  }

  if (passages.length) {
    add(
      'SOURCE PASSAGES FOR THE ABOVE (use these to check the canon):\n' +
        passages
          .slice(0, 4)
          .map((p) => `--- ${p.locator}\n${truncate(p.text, 900)}`)
          .join('\n\n'),
    );
  }

  if (queryTerms.length) {
    add(
      `RETRIEVED FOR: ${queryTerms.slice(0, 8).join(', ')}. If this is not what the scene needs, request more context.`,
    );
  }

  return { text: parts.join('\n\n'), truncated };
}
