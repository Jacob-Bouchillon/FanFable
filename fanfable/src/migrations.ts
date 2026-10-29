/**
 * Schema migrations.
 *
 * The base schema is applied as migration 1. Later migrations add columns and
 * tables without touching the data that is already there, so a database
 * written by an older version of fanfable keeps working and gains the new
 * capabilities.
 *
 * Version tracking uses SQLite's own `user_version`, so it survives copies of
 * the database and does not need a second source of truth.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.ts';

export interface Migration {
  version: number;
  name: string;
  /** Statements applied to every database. */
  sql?: string;
  /** Columns added when missing, so the migration is safe to re-run. */
  columns?: [table: string, column: string, definition: string][];
}

/** Does a table exist? */
export function tableExists(db: DatabaseSync, table: string): boolean {
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Does a column already exist on a table? */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** Add a column only when it is missing, so a migration can be re-run safely. */
function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'base schema',
    sql: SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'graph semantics',
    columns: [
      // ---- canon: typed edges gain confidence, review status and validity
      //      (a relationship can be true only between two points in time)
      ['canon_entity', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['canon_entity', 'review_status', "TEXT NOT NULL DEFAULT 'accepted'"],
      ['canon_relation', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['canon_relation', 'review_status', "TEXT NOT NULL DEFAULT 'accepted'"],
      ['canon_relation', 'valid_from_event_id', 'INTEGER REFERENCES canon_event(id) ON DELETE SET NULL'],
      ['canon_relation', 'valid_to_event_id', 'INTEGER REFERENCES canon_event(id) ON DELETE SET NULL'],
      ['canon_fact', 'subject_entity_id', 'INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL'],
      ['canon_fact', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['canon_fact', 'review_status', "TEXT NOT NULL DEFAULT 'accepted'"],
      ['canon_fact', 'valid_from_event_id', 'INTEGER REFERENCES canon_event(id) ON DELETE SET NULL'],
      ['canon_fact', 'valid_to_event_id', 'INTEGER REFERENCES canon_event(id) ON DELETE SET NULL'],
      ['canon_event', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['canon_event', 'seq', 'INTEGER NOT NULL DEFAULT 0'],
      ['canon_timeline', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],

      // ---- story: entity resolution and temporal validity
      ['character', 'canon_entity_id', 'INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL'],
      ['character', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['character', 'review_status', "TEXT NOT NULL DEFAULT 'accepted'"],
      ['character_knowledge', 'fact_id', 'INTEGER REFERENCES story_fact(id) ON DELETE SET NULL'],
      ['character_knowledge', 'valid_until_event_id', 'INTEGER REFERENCES au_event(id) ON DELETE SET NULL'],
      ['relationship', 'valid_from_event_id', 'INTEGER REFERENCES au_event(id) ON DELETE SET NULL'],
      ['relationship', 'valid_to_event_id', 'INTEGER REFERENCES au_event(id) ON DELETE SET NULL'],
      ['relationship', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['au_event', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['au_event', 'review_status', "TEXT NOT NULL DEFAULT 'accepted'"],
      ['story_fact', 'subject_entity_id', 'INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL'],
      ['story_fact', 'confidence', 'REAL NOT NULL DEFAULT 1.0'],
      ['story_fact', 'review_status', "TEXT NOT NULL DEFAULT 'accepted'"],
      ['thread_event', 'kind', "TEXT NOT NULL DEFAULT 'developed'"],
    ],
    sql: `
      -- ---- typed edges that had no table of their own
      CREATE TABLE IF NOT EXISTS canon_event_participant (
        canon_event_id INTEGER NOT NULL REFERENCES canon_event(id) ON DELETE CASCADE,
        entity_id      INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
        role           TEXT NOT NULL DEFAULT 'participant',
        PRIMARY KEY (canon_event_id, entity_id, role)
      );
      CREATE INDEX IF NOT EXISTS canon_event_participant_entity ON canon_event_participant(entity_id);

      CREATE TABLE IF NOT EXISTS au_event_participant (
        au_event_id  INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
        character_id INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
        role         TEXT NOT NULL DEFAULT 'participant',
        PRIMARY KEY (au_event_id, character_id, role)
      );
      CREATE INDEX IF NOT EXISTS au_event_participant_char ON au_event_participant(character_id);

      -- Cause and consequence between events in the story.
      CREATE TABLE IF NOT EXISTS au_event_link (
        from_event_id INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
        to_event_id   INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL DEFAULT 'consequence', -- cause | consequence | foreshadow | contradicts
        description   TEXT NOT NULL DEFAULT '',
        confidence    REAL NOT NULL DEFAULT 1.0,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (from_event_id, to_event_id, kind)
      );
      CREATE INDEX IF NOT EXISTS au_event_link_to ON au_event_link(to_event_id);

      -- A story fact that several characters know (or do not know) about.
      CREATE TABLE IF NOT EXISTS secret (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        statement    TEXT NOT NULL DEFAULT '',
        subject_entity_id INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL,
        fact_id      INTEGER REFERENCES story_fact(id) ON DELETE SET NULL,
        status       TEXT NOT NULL DEFAULT 'open',  -- open | revealed | resolved
        revealed_at_event_id INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS secret_project_title ON secret(project_id, lower(title));

      -- Motivations and goals, with the character they belong to.
      CREATE TABLE IF NOT EXISTS motivation (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL DEFAULT 'character', -- character | canon_entity
        subject_id   INTEGER NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'motive',  -- motive | goal | fear | wound | want
        statement    TEXT NOT NULL,
        evidence     TEXT NOT NULL DEFAULT '',
        source       TEXT NOT NULL DEFAULT 'inferred', -- canon | au | inference | user
        confidence   REAL NOT NULL DEFAULT 1.0,
        valid_from_event_id INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
        valid_to_event_id   INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS motivation_subject ON motivation(project_id, subject_type, subject_id);

      -- Log of graph writes, so a re-approval can be audited.
      CREATE TABLE IF NOT EXISTS graph_write (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
        kind       TEXT NOT NULL DEFAULT '',
        detail     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS graph_write_project ON graph_write(project_id, id);
    `,
  },
  {
    version: 7,
    name: 'state conflicts',
    // When an approved chapter contradicts what the story already
    // established, the conflict is recorded with enough provenance for the
    // author to resolve it. Nothing is overwritten silently.
    sql: `
      CREATE TABLE IF NOT EXISTS state_conflict (
        id            INTEGER PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        chapter_id    INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
        kind          TEXT NOT NULL DEFAULT 'fact',
        subject       TEXT NOT NULL DEFAULT '',
        existing_ref  TEXT NOT NULL DEFAULT '',
        incoming_ref  TEXT NOT NULL DEFAULT '',
        message       TEXT NOT NULL DEFAULT '',
        evidence      TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'open',   -- open | accepted | resolved
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS state_conflict_project ON state_conflict(project_id, status);
    `,
  },
  {
    version: 6,
    name: 'several relations per pair',
    // Two people can have more than one relationship ("nephew of" and
    // "lives with"), so a pair needs one row per kind, not one row per pair.
    sql: `
      DROP INDEX IF EXISTS canon_relation_pair;
      CREATE UNIQUE INDEX IF NOT EXISTS canon_relation_pair_kind
        ON canon_relation(project_id, from_entity, to_entity, kind);
    `,
  },
  {
    version: 5,
    name: 'relationship current flag',
    // A relationship row is either the current state of a pair or a historical
    // one. Without the flag, closing a relationship without a known event id
    // left two "current" rows.
    columns: [['relationship', 'closed', 'INTEGER NOT NULL DEFAULT 0']],
  },
  {
    version: 4,
    name: 'relationship history',
    // A relationship can change over time. The unique index made that
    // impossible, because a new kind for the same pair overwrote the old one.
    sql: `
      DROP INDEX IF EXISTS relationship_pair;
      CREATE INDEX IF NOT EXISTS relationship_pair_index ON relationship(project_id, character_a, character_b);
    `,
  },
  {
    version: 8,
    name: 'embedding store',
    // Dense seeds for PPR: one row per passage, entity and triple per model.
    // ref is a chunk id for passages and a stable node id (canon:entity:12,
    // canon:relation:34) for the rest. Rows are keyed by exact model string,
    // so a model change backfills fresh rows instead of mixing dimensions.
    sql: `
      CREATE TABLE IF NOT EXISTS embedding (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        chunk_id   INTEGER REFERENCES canon_chunk(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL DEFAULT 'passage',
        ref        TEXT NOT NULL DEFAULT '',
        model      TEXT NOT NULL DEFAULT '',
        dims       INTEGER NOT NULL DEFAULT 0,
        vec        TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS embedding_kind_ref_model
        ON embedding(project_id, kind, ref, model);
      CREATE INDEX IF NOT EXISTS embedding_chunk ON embedding(chunk_id);
    `,
  },
  {
    version: 9,
    name: 'claim modality and conflict status',
    // Denials and doubts are claims too: modality records how the passage
    // framed it (asserted|denied|possible|suspected), and conflict_status
    // marks rival claims neither side resolves (none|contested|superseded).
    // Existing rows read as asserted/none — no backfill.
    columns: [
      ['canon_fact', 'modality', "TEXT NOT NULL DEFAULT 'asserted'"],
      ['canon_fact', 'conflict_status', "TEXT NOT NULL DEFAULT 'none'"],
      ['canon_relation', 'modality', "TEXT NOT NULL DEFAULT 'asserted'"],
      ['canon_relation', 'conflict_status', "TEXT NOT NULL DEFAULT 'none'"],
    ],
  },
  {
    version: 10,
    name: 'quarantine alias rulings',
    // Nickname pairs the merge rules would not decide on their own wait
    // here for a batched model ruling. Old databases migrate empty.
    sql: `
      CREATE TABLE IF NOT EXISTS quarantine_alias (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        name       TEXT NOT NULL DEFAULT '',
        candidate  TEXT NOT NULL DEFAULT '',
        reason     TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'pending',
        ruling     TEXT NOT NULL DEFAULT '',
        ruled_at   TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS quarantine_alias_pair
        ON quarantine_alias(project_id, name, candidate);
    `,
  },
  {
    version: 11,
    name: 'parked tie notes for relabeling',
    // Moment labels and quote-silent nouns drop out of the bank but wait
    // here — pair, attempted label, reason, proving quote — for one batched
    // closed-vocabulary relabeling pass. Old databases migrate empty.
    sql: `
      CREATE TABLE IF NOT EXISTS canon_tie_note (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        from_entity INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
        to_entity   INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
        attempted_kind TEXT NOT NULL DEFAULT '',
        reason     TEXT NOT NULL DEFAULT '',
        evidence   TEXT NOT NULL DEFAULT '',
        source_refs TEXT NOT NULL DEFAULT '[]',
        status     TEXT NOT NULL DEFAULT 'pending',
        ruling     TEXT NOT NULL DEFAULT '',
        ruled_at   TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS canon_tie_note_pair
        ON canon_tie_note(project_id, from_entity, to_entity, attempted_kind);
    `,
  },
  {
    version: 12,
    name: 'ledger states for courtroom v0',
    // Rival scopes coexist: same pair+kind may recur under different scope.
    // Existing rows read as verified with empty scope. Additive only.
    columns: [
      ['canon_relation', 'ledger_state', "TEXT NOT NULL DEFAULT 'verified'"],
      ['canon_relation', 'scope', "TEXT NOT NULL DEFAULT ''"],
      ['canon_relation', 'superseding_chapter', 'INTEGER REFERENCES chapter(id) ON DELETE SET NULL'],
    ],
    sql: `
      DROP INDEX IF EXISTS canon_relation_pair_kind;
      CREATE UNIQUE INDEX IF NOT EXISTS canon_relation_pair_kind_scope
        ON canon_relation(project_id, from_entity, to_entity, kind, scope);
    `,
  },
  {
    version: 13,
    name: 'unresolved-endpoint tie hints',
    // Relations whose endpoints the bank does not know are kept as hints
    // instead of being dropped. Additive only; nothing here creates an entity
    // or promotes a tie.
    sql: `
      CREATE TABLE IF NOT EXISTS canon_tie_hint (
        id          INTEGER PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        from_name   TEXT NOT NULL,
        to_name     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        evidence    TEXT NOT NULL DEFAULT '',
        source_refs TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'pending',
        note        TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS canon_tie_hint_pair
        ON canon_tie_hint(project_id, from_name, to_name, kind);
      CREATE INDEX IF NOT EXISTS canon_tie_hint_status
        ON canon_tie_hint(project_id, status);
    `,
  },
  {
    version: 15,
    name: 'confirmed_by_user provenance',
    // The status becomes the effective retrieval tier; the flag remembers the
    // human decision even when the row is later quarantined.
    columns: [
      ['canon_relation', 'confirmed_by_user', 'INTEGER NOT NULL DEFAULT 0'],
    ],
    sql: `UPDATE canon_relation SET confirmed_by_user = 1 WHERE review_status = 'user_confirmed';`,
  },
  {
    version: 18,
    name: 'anchor evidence for relations',
    // The sentence that asserts the relationship, when the quote only supplies
    // context (a pronoun, a neighbouring name). Verbatim by construction; the
    // guard runs the assertion test on this span, never on the union.
    columns: [
      ['canon_relation', 'anchor_evidence', "TEXT NOT NULL DEFAULT ''"],
    ],
  },
  {
    version: 17,
    name: 'quarantine reason for suspect entities',
    // A character admitted from a single mention whose name is also an ordinary
    // word ("bill" on an invoice) is held back from tie generation, not
    // deleted. The reason is kept so review can see why and what would release
    // it: a second independent mention, or a recognised alias.
    columns: [
      ['canon_entity', 'quarantine_reason', "TEXT NOT NULL DEFAULT ''"],
    ],
  },
  {
    version: 16,
    name: 'kind source words for relations',
    // The words in the quote that express the kind, when the label's own word
    // is absent ("sided with" for ally of). Verbatim by construction: the
    // guard checks it against the quote before it counts.
    columns: [
      ['canon_relation', 'kind_source', "TEXT NOT NULL DEFAULT ''"],
    ],
  },
  {
    version: 14,
    name: 'supporting evidence for relations',
    // One cited proving quote per relation; superseded quotes move here as
    // display-only context. Additive only; existing rows default to [].
    columns: [
      ['canon_relation', 'supporting_evidence', "TEXT NOT NULL DEFAULT '[]'"],
    ],
  },
  {
    version: 3,
    name: 'chapter references for story graph records',
    // Knowledge, motives, secrets and relationships have to be removable when
    // a chapter is re-approved, or a re-approval would leave stale duplicates.
    columns: [
      ['au_event_link', 'project_id', 'INTEGER REFERENCES project(id) ON DELETE CASCADE'],
      ['character_knowledge', 'chapter_id', 'INTEGER REFERENCES chapter(id) ON DELETE SET NULL'],
      ['motivation', 'chapter_id', 'INTEGER REFERENCES chapter(id) ON DELETE SET NULL'],
      ['secret', 'chapter_id', 'INTEGER REFERENCES chapter(id) ON DELETE SET NULL'],
      ['relationship', 'chapter_id', 'INTEGER REFERENCES chapter(id) ON DELETE SET NULL'],
    ],
  },
];

/**
 * Bring a database up to the latest schema.
 *
 * Databases created before versioning existed carry `schema_meta.version = 1`
 * and `user_version = 0`; they are treated as version 1 and moved forward.
 */
export function runMigrations(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);

  // The base schema is written with IF NOT EXISTS throughout, so running it
  // again is harmless. It is run whenever the database is missing any of its
  // tables, even if the version number says otherwise — a database written by
  // an older version can carry a version number without the tables behind it.
  const BASE_TABLES = [
    'project',
    'canon_source',
    'canon_chunk',
    'canon_event',
    'canon_entity',
    'canon_relation',
    'canon_fact',
    'canon_timeline',
    'chapter',
    'au_event',
    'character',
    'story_fact',
  ];
  const missing = BASE_TABLES.filter((t) => !tableExists(db, t));

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    const isBase = migration.version === 1;
    if (isBase) {
      if (missing.length === 0) continue;
    } else if (migration.version <= version) {
      continue;
    }
    db.exec('BEGIN');
    try {
      // Columns first: later migrations may create indexes or run statements
      // that depend on the columns this migration adds.
      for (const [table, column, definition] of migration.columns ?? []) {
        addColumn(db, table, column, definition);
      }
      if (migration.sql) db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${(err as Error).message}`);
    }
  }
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}
