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
import { truncate } from './text.ts';

export type GraphScope = 'canon' | 'story' | 'both';

export type NodeKind =
  | 'canon-entity'
  | 'canon-event'
  | 'canon-fact'
  | 'canon-timeline'
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
      addEdge(graph, {
        id: `canon:relation:${r.id}`,
        from: canonEntityId(r.from_entity),
        to: canonEntityId(r.to_entity),
        type: r.kind || 'related_to',
        scope: 'canon',
        description: r.description,
        evidence: r.evidence,
        confidence: r.confidence ?? 1,
        reviewStatus: r.review_status ?? 'accepted',
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
}

export interface GraphContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The passages that substantiate the graph claims. */
  passages: { chunkId: number; locator: string; text: string }[];
  text: string;
  truncated: boolean;
  stats: { nodes: number; edges: number; passages: number; words: number };
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
  const graph = loadGraph(db, projectId, { scope: opts.scope });
  const queryTerms = terms(opts.query ?? '');
  const focusNames = opts.focus ?? [];

  let beforeOrder = opts.beforeOrder;
  if (opts.atEventId !== undefined) {
    const anchor = db.get<{ story_order: number }>('SELECT story_order FROM au_event WHERE id = ?', opts.atEventId);
    if (anchor) beforeOrder = anchor.story_order;
  }

  const roots = resolveRoots(graph, focusNames.length ? focusNames : queryTerms.slice(0, 3));
  const result = traverse(graph, {
    roots: roots.map((r) => r.node.id),
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
  const relationEdges = edges.filter((e) => !NAVIGATIONAL.has(e.type));
  const navigational = edges.filter((e) => NAVIGATIONAL.has(e.type));

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
