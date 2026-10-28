/**
 * Local embeddings, one small model, no new dependencies.
 *
 * Dense seeds for PPR come from here: passages and triples are embedded once
 * (offline backfill), the query is embedded once per retrieval, and cosine
 * similarity picks the seeds. The writer model and the embedder never run in
 * the same call — backfill is a separate job, and query-time embedding is a
 * single tiny request — so peak RAM stays one model plus a few kilobytes.
 *
 * Every fallible function returns undefined on error (model missing, server
 * down, bad shape) instead of throwing: retrieval must degrade to lexical
 * behavior, never fail because an embedder is unreachable.
 */
import { Db, nowIso } from './db.ts';
import { loadGlobalConfig } from './llm.ts';

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
export const EMBED_BATCH_SIZE = 32;

export interface EmbedConfig {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  batchSize?: number;
}

/** Embeds texts to vectors, or undefined when unavailable. Tests inject a fake. */
export type EmbedFn = (texts: string[]) => Promise<number[][] | undefined>;

/** Cosine similarity. Length mismatch or empty input scores 0. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function cleanVecs(raw: unknown): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || !row.length) continue;
    const vec: number[] = [];
    for (const v of row) {
      const n = Number(v);
      if (!Number.isFinite(n)) break;
      vec.push(n);
    }
    if (vec.length === row.length) out.push(vec);
  }
  return out;
}

/**
 * Embed texts with a local Ollama-compatible server.
 *
 * Batches at EMBED_BATCH_SIZE per call. Returns undefined on any failure —
 * the caller treats that as "no dense vectors" and carries on lexically.
 */
export async function embedTexts(texts: string[], opts: EmbedConfig): Promise<number[][] | undefined> {
  const batch = Math.max(1, opts.batchSize ?? EMBED_BATCH_SIZE);
  const base = opts.baseUrl.replace(/\/$/, '');
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  const out: number[][] = [];
  try {
    for (let start = 0; start < texts.length; start += batch) {
      const chunk = texts.slice(start, start + batch).map((t) => (t ?? '').slice(0, 4000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await fetch(`${base}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: chunk }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return undefined;
      const data = (await res.json().catch(() => undefined)) as { embeddings?: unknown } | undefined;
      const vecs = cleanVecs(data?.embeddings);
      if (!vecs || vecs.length !== chunk.length) return undefined;
      out.push(...vecs);
    }
  } catch {
    return undefined;
  }
  return out;
}

/** Embed one query. Undefined when the embedder is unreachable. */
export async function embedQuery(text: string, opts: EmbedConfig): Promise<number[] | undefined> {
  if (!text.trim()) return undefined;
  const vecs = await embedTexts([text], opts);
  return vecs?.[0];
}

/* ------------------------------------------------------------ storage */

export type EmbeddingKind = 'passage' | 'triple' | 'entity';

export interface StoredVector {
  kind: EmbeddingKind;
  ref: string;
  vec: number[];
}

/**
 * Resolve model + server from project settings, with CLI overrides.
 *
 * `embeddingBaseUrl` comes before `baseUrl` because the chat backend may be a
 * cloud gateway (OpenRouter and the like) that serves no /api/embed; the
 * embedder has to keep pointing at the local Ollama.
 */
export function resolveEmbedConfig(
  db: Db,
  projectId: number,
  opts: { model?: string; baseUrl?: string; fallbackBaseUrl?: string } = {},
): { baseUrl: string; model: string } {
  let settings: Record<string, unknown> = {};
  try {
    const row = db.get<{ settings: string }>('SELECT settings FROM project WHERE id = ?', projectId);
    if (row?.settings) settings = JSON.parse(row.settings) as Record<string, unknown>;
  } catch {
    /* a broken settings blob still embeds with defaults */
  }
  const global = loadGlobalConfig() as Record<string, unknown>;
  const str = (o: Record<string, unknown>, k: string): string | undefined =>
    typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined;
  const baseUrl =
    opts.baseUrl ??
    str(settings, 'embeddingBaseUrl') ??
    str(global, 'embeddingBaseUrl') ??
    str(settings, 'baseUrl') ??
    opts.fallbackBaseUrl ??
    'http://127.0.0.1:11434';
  const model = opts.model ?? str(settings, 'embeddingModel') ?? DEFAULT_EMBED_MODEL;
  return { baseUrl, model };
}

/** All stored vectors for one exact model string. Old-model rows never mix. */
export function readVectors(db: Db, projectId: number, model: string): StoredVector[] {
  try {
    return db
      .all<{ kind: string; ref: string; vec: string }>(
        'SELECT kind, ref, vec FROM embedding WHERE project_id = ? AND model = ?',
        projectId,
        model,
      )
      .map((r) => {
        let vec: number[] = [];
        try {
          const parsed: unknown = JSON.parse(r.vec);
          if (Array.isArray(parsed)) vec = parsed.filter((v) => typeof v === 'number') as number[];
        } catch {
          /* a malformed row embeds as nothing */
        }
        return { kind: r.kind as EmbeddingKind, ref: r.ref, vec };
      })
      .filter((r) => r.vec.length > 0);
  } catch {
    // A database from before migration 8 has no embedding table: no vectors.
    return [];
  }
}

function writeVector(
  db: Db,
  projectId: number,
  model: string,
  kind: EmbeddingKind,
  ref: string,
  chunkId: number | null,
  vec: number[],
): void {
  db.run(
    `INSERT OR REPLACE INTO embedding (project_id, chunk_id, kind, ref, model, dims, vec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    chunkId,
    kind,
    ref,
    model,
    vec.length,
    JSON.stringify(vec),
    nowIso(),
  );
}

export interface BackfillCounts {
  embedded: number;
  skipped: number;
  model: string;
  dims: number;
}

function tripleText(fromName: string, kind: string, toName: string, description: string): string {
  return `${fromName} ${kind} ${toName}${description ? `: ${description}` : ''}`;
}

function entityText(name: string, aliases: string[], summary: string, role: string, status: string): string {
  const aka = aliases.length ? ` (also called ${aliases.join(', ')})` : '';
  return `${name}${aka}${summary ? `: ${summary}` : ''}${role ? ` Role: ${role}.` : ''}${status ? ` Status: ${status}.` : ''}`;
}

/**
 * Embed everything missing for one model: every passage, entity and triple.
 *
 * Rows already stored for the exact model string are skipped, so re-running
 * is cheap; rows from other models are ignored, never mixed. Returns counts,
 * never throws on embedder failure (nothing embedded, everything "skipped").
 */
export async function embedMissing(
  db: Db,
  projectId: number,
  cfg: { baseUrl: string; model?: string; embedFn?: EmbedFn; batchSize?: number; timeoutMs?: number },
  onProgress?: (message: string) => void,
): Promise<BackfillCounts> {
  const model = cfg.model ?? DEFAULT_EMBED_MODEL;
  const have = new Set(
    db
      .all<{ kind: string; ref: string }>(
        'SELECT kind, ref FROM embedding WHERE project_id = ? AND model = ?',
        projectId,
        model,
      )
      .map((r) => `${r.kind}:${r.ref}`),
  );
  const embed = cfg.embedFn ?? ((texts: string[]) => embedTexts(texts, cfg));

  const jobs: { kind: EmbeddingKind; ref: string; chunkId: number | null; text: string }[] = [];
  for (const c of db.all<{ id: number; text: string }>(
    'SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  )) {
    if (!have.has(`passage:${c.id}`) && c.text.trim()) {
      jobs.push({ kind: 'passage', ref: String(c.id), chunkId: c.id, text: c.text });
    }
  }
  for (const e of db.all<{ id: number; name: string; aliases: string; summary: string; role: string; status: string }>(
    'SELECT id, name, aliases, summary, role, status FROM canon_entity WHERE project_id = ? ORDER BY id',
    projectId,
  )) {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(e.aliases || '[]') as string[];
    } catch {
      /* an odd aliases blob still embeds under its name */
    }
    if (!have.has(`entity:canon:entity:${e.id}`)) {
      jobs.push({
        kind: 'entity',
        ref: `canon:entity:${e.id}`,
        chunkId: null,
        text: entityText(e.name, aliases, e.summary, e.role, e.status),
      });
    }
  }
  const names = new Map<number, string>();
  for (const e of db.all<{ id: number; name: string }>(
    'SELECT id, name FROM canon_entity WHERE project_id = ?',
    projectId,
  )) {
    names.set(e.id, e.name);
  }
  for (const r of db.all<{ id: number; from_entity: number; to_entity: number; kind: string; description: string }>(
    'SELECT id, from_entity, to_entity, kind, description FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  )) {
    if (!have.has(`triple:canon:relation:${r.id}`)) {
      jobs.push({
        kind: 'triple',
        ref: `canon:relation:${r.id}`,
        chunkId: null,
        text: tripleText(names.get(r.from_entity) ?? '?', r.kind || 'related to', names.get(r.to_entity) ?? '?', r.description),
      });
    }
  }

  // Wrap the whole write in one transaction: a half-written backfill would
  // silently starve the queries that expect those vectors.
  const counts: BackfillCounts = { embedded: 0, skipped: 0, model, dims: 0 };
  const batch = Math.max(1, cfg.batchSize ?? EMBED_BATCH_SIZE);
  for (let start = 0; start < jobs.length; start += batch) {
    const group = jobs.slice(start, start + batch);
    const vecs = await embed(group.map((j) => j.text));
    if (!vecs || vecs.length !== group.length) {
      // The embedder went away mid-backfill: everything left stays NULL for
      // the next run. Reported as skipped, not as failure.
      counts.skipped += jobs.length - start;
      break;
    }
    db.transaction(() => {
      for (let i = 0; i < group.length; i++) {
        const job = group[i]!;
        const vec = vecs[i]!;
        writeVector(db, projectId, model, job.kind, job.ref, job.chunkId, vec);
        if (!counts.dims) counts.dims = vec.length;
        counts.embedded++;
      }
    });
    onProgress?.(`embedded ${Math.min(start + batch, jobs.length)}/${jobs.length} (${model})`);
  }
  // Rows that were already stored never reached the embedder.
  const total =
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding WHERE project_id = ? AND model = ?', projectId, model)?.n ?? 0;
  counts.skipped += Math.max(0, total - counts.embedded);
  if (!counts.dims) {
    counts.dims = db.get<{ dims: number }>('SELECT dims FROM embedding WHERE project_id = ? AND model = ? LIMIT 1', projectId, model)?.dims ?? 0;
  }
  return counts;
}

/** Backfill entry point for the CLI and the server job. Same helper, same counts. */
export async function embedBackfill(
  db: Db,
  projectId: number,
  cfg: { baseUrl: string; model?: string; embedFn?: EmbedFn; batchSize?: number; timeoutMs?: number },
  onProgress?: (message: string) => void,
): Promise<BackfillCounts> {
  return embedMissing(db, projectId, cfg, onProgress);
}
