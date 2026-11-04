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
  {
    version: 19,
    name: 'code-only pair threads',
    // One row per co-occurring character pair: the structural coverage for
    // discovery. Written only by the pair-thread builder, never by the model,
    // and never promoted into the bank. Additive only.
    sql: `
      CREATE TABLE IF NOT EXISTS canon_pair_thread (
        id            INTEGER PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        a_entity      INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
        b_entity      INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
        cooccur_count INTEGER NOT NULL DEFAULT 0,
        shared_chunks TEXT NOT NULL DEFAULT '[]',
        first_seq     INTEGER NOT NULL DEFAULT 0,
        last_seq      INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'empty',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS canon_pair_thread_pair
        ON canon_pair_thread(project_id, a_entity, b_entity);
      CREATE INDEX IF NOT EXISTS canon_pair_thread_project
        ON canon_pair_thread(project_id);
    `,
  },
  {
    version: 20,
    name: 'thread records, immutable notes, open ends',
    // The evidence web's first layer: a persistent investigation per person
    // and per co-occurring pair, immutable clue notes on those threads, and
    // the open ends that keep an investigation alive. Structure only — the
    // model never writes here, and nothing is promoted into the bank.
    // Additive only; no existing table is altered.
    sql: `
      CREATE TABLE IF NOT EXISTS canon_thread (
        id              INTEGER PRIMARY KEY,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL DEFAULT 'pair',  -- person | pair
        a_entity        INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
        b_entity        INTEGER REFERENCES canon_entity(id) ON DELETE CASCADE,
        pair_thread_id  INTEGER REFERENCES canon_pair_thread(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dormant
        parent_a_thread INTEGER REFERENCES canon_thread(id) ON DELETE SET NULL,
        parent_b_thread INTEGER REFERENCES canon_thread(id) ON DELETE SET NULL,
        birth_reason    TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      -- b_entity is null for people, so the identity key coalesces it to 0;
      -- two person threads for one entity are therefore impossible.
      CREATE UNIQUE INDEX IF NOT EXISTS canon_thread_identity
        ON canon_thread(project_id, kind, a_entity, COALESCE(b_entity, 0));
      CREATE INDEX IF NOT EXISTS canon_thread_project
        ON canon_thread(project_id, kind, status);

      -- Ordered passage history: which passages a thread has looked at.
      CREATE TABLE IF NOT EXISTS canon_thread_passage (
        thread_id     INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        chunk_id      INTEGER NOT NULL REFERENCES canon_chunk(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS canon_thread_passage_seq
        ON canon_thread_passage(thread_id, seq);

      -- Immutable clue notes. There is deliberately no update path: a
      -- correction is a new row pointing at the note it supersedes.
      CREATE TABLE IF NOT EXISTS canon_thread_note (
        id                 INTEGER PRIMARY KEY,
        project_id         INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        thread_id          INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        chunk_id           INTEGER REFERENCES canon_chunk(id) ON DELETE SET NULL,
        locator            TEXT NOT NULL DEFAULT '',
        quote              TEXT NOT NULL,
        claim              TEXT NOT NULL DEFAULT '',
        note_kind          TEXT NOT NULL DEFAULT 'observation', -- observation | correction | context
        strength           REAL NOT NULL DEFAULT 0.5,
        why                TEXT NOT NULL DEFAULT '',
        missing            TEXT NOT NULL DEFAULT '',
        is_context         INTEGER NOT NULL DEFAULT 0,
        supersedes_note_id INTEGER REFERENCES canon_thread_note(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canon_thread_note_thread
        ON canon_thread_note(thread_id, id);

      -- What the investigation still needs. Resolution links, never erases.
      CREATE TABLE IF NOT EXISTS canon_open_end (
        id                  INTEGER PRIMARY KEY,
        project_id          INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        thread_id           INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        question            TEXT NOT NULL,
        origin              TEXT NOT NULL DEFAULT '',
        would_resolve       TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'open',  -- open | resolved | abandoned
        resolved_by_note_id INTEGER REFERENCES canon_thread_note(id) ON DELETE SET NULL,
        resolved_at         TEXT,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canon_open_end_thread
        ON canon_open_end(project_id, thread_id, status);
    `,
  },
  {
    version: 21,
    name: 'meetings, scoped sharing, births',
    // Two threads meet at a shared subject, exchange the notes relevant to
    // that subject, resolve wants on the spot and may birth one child thread.
    // Additive apart from one controlled index change, explained below.
    // No model call writes any of these rows.
    sql: `
      -- The M1 identity key allowed exactly one thread per subject, so no
      -- born child could ever exist: a child always shares its subject with
      -- the parent pair or person thread. The key now governs root threads
      -- only; every row written before this migration is a root, so their
      -- protection is unchanged. Born threads get their own lineage key.
      DROP INDEX IF EXISTS canon_thread_identity;
      CREATE UNIQUE INDEX IF NOT EXISTS canon_thread_identity
        ON canon_thread(project_id, kind, a_entity, COALESCE(b_entity, 0))
        WHERE parent_a_thread IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS canon_thread_born_identity
        ON canon_thread(project_id, parent_a_thread, parent_b_thread, kind, a_entity, COALESCE(b_entity, 0))
        WHERE parent_a_thread IS NOT NULL;

      CREATE TABLE IF NOT EXISTS canon_meeting (
        id              INTEGER PRIMARY KEY,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        thread_a        INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        thread_b        INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        match_key       TEXT NOT NULL,
        match_kind      TEXT NOT NULL,          -- shared_person | shared_pair
        revision        INTEGER NOT NULL DEFAULT 0,
        notes_exchanged INTEGER NOT NULL DEFAULT 0,
        wants_resolved  INTEGER NOT NULL DEFAULT 0,
        child_thread    INTEGER REFERENCES canon_thread(id) ON DELETE SET NULL,
        remaining       TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dormant
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS canon_meeting_subject
        ON canon_meeting(project_id, thread_a, thread_b, match_key);
      CREATE INDEX IF NOT EXISTS canon_meeting_project
        ON canon_meeting(project_id, status);

      -- One row per note shared in a meeting. scope is stored, not inferred
      -- later: an identity note must never be read as pair evidence.
      CREATE TABLE IF NOT EXISTS canon_meeting_exchange (
        meeting_id INTEGER NOT NULL REFERENCES canon_meeting(id) ON DELETE CASCADE,
        note_id    INTEGER NOT NULL REFERENCES canon_thread_note(id) ON DELETE CASCADE,
        direction  TEXT NOT NULL,                       -- a_to_b | b_to_a
        scope      TEXT NOT NULL,                       -- identity | pair
        relevance  TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (meeting_id, note_id)
      );

      -- A want answered during the meeting. The earlier row is kept and
      -- marked superseded, never deleted.
      CREATE TABLE IF NOT EXISTS canon_meeting_resolution (
        id                  INTEGER PRIMARY KEY,
        meeting_id          INTEGER NOT NULL REFERENCES canon_meeting(id) ON DELETE CASCADE,
        open_end_id         INTEGER NOT NULL REFERENCES canon_open_end(id) ON DELETE CASCADE,
        resolved_by_note_id INTEGER NOT NULL REFERENCES canon_thread_note(id) ON DELETE CASCADE,
        match_tokens        TEXT NOT NULL DEFAULT '',
        superseded_by       INTEGER REFERENCES canon_meeting_resolution(id) ON DELETE SET NULL,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canon_meeting_resolution_meeting
        ON canon_meeting_resolution(meeting_id);

      CREATE TABLE IF NOT EXISTS canon_birth (
        id              INTEGER PRIMARY KEY,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        meeting_id      INTEGER NOT NULL REFERENCES canon_meeting(id) ON DELETE CASCADE,
        parent_a_thread INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        parent_b_thread INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        child_thread    INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        trigger         TEXT NOT NULL,
        combined_score  REAL NOT NULL DEFAULT 0,
        reason          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      -- One child per meeting, one child per thread, and the same lineage
      -- never births twice for the same reason.
      CREATE UNIQUE INDEX IF NOT EXISTS canon_birth_meeting ON canon_birth(meeting_id);
      CREATE UNIQUE INDEX IF NOT EXISTS canon_birth_child ON canon_birth(child_thread);
      CREATE UNIQUE INDEX IF NOT EXISTS canon_birth_lineage
        ON canon_birth(project_id, parent_a_thread, parent_b_thread, trigger);

      -- The child references pooled notes; it never copies them.
      CREATE TABLE IF NOT EXISTS canon_thread_note_ref (
        thread_id  INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        note_id    INTEGER NOT NULL REFERENCES canon_thread_note(id) ON DELETE CASCADE,
        role       TEXT NOT NULL DEFAULT 'pooled',      -- pooled | carried
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, note_id, role)
      );
    `,
    columns: [
      // A want carried onto a born child remembers where it came from.
      [
        'canon_open_end',
        'carried_from_open_end_id',
        'INTEGER REFERENCES canon_open_end(id) ON DELETE SET NULL',
      ],
    ],
  },
  {
    version: 22,
    name: 'note ingestion dedupe key',
    // Notes gathered from what the bank already holds need a stable identity:
    // re-reading one passage must add nothing, while a genuinely different
    // claim about the same quote must still be allowed. The key is a hash of
    // the normalised quote and claim. Rows written before this milestone (and
    // hand-written notes) keep the empty key, so the unique index is partial —
    // otherwise every earlier row would collide with every other on its thread.
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS canon_thread_note_dedupe
        ON canon_thread_note(thread_id, dedupe_key)
        WHERE dedupe_key <> '';
      CREATE INDEX IF NOT EXISTS canon_thread_note_project_time
        ON canon_thread_note(project_id, thread_id, created_at);
    `,
    columns: [['canon_thread_note', 'dedupe_key', "TEXT NOT NULL DEFAULT ''"]],
  },
  {
    version: 23,
    name: 'time-scoped pair threads',
    // A pair can be apprentice-early and enemy-later; one thread per pair could
    // never represent that, and it also made every pair evidence one-sided.
    // A pair's shared passages now split into periods, and each period is its
    // own investigation. Existing rows all carry period_label = '', so the
    // root identity key still holds them to one thread per subject.
    sql: `
      DROP INDEX IF EXISTS canon_thread_identity;
      CREATE UNIQUE INDEX IF NOT EXISTS canon_thread_root_identity
        ON canon_thread(project_id, kind, a_entity, COALESCE(b_entity, 0), period_label)
        WHERE parent_a_thread IS NULL;
      CREATE INDEX IF NOT EXISTS canon_thread_period
        ON canon_thread(project_id, kind, a_entity, b_entity, period_from_seq);
    `,
    columns: [
      ['canon_thread', 'period_label', "TEXT NOT NULL DEFAULT ''"],
      ['canon_thread', 'period_from_seq', 'INTEGER'],
      ['canon_thread', 'period_to_seq', 'INTEGER'],
      ['canon_thread', 'temporal_status', "TEXT NOT NULL DEFAULT 'unknown'"],
    ],
  },
  {
    version: 24,
    name: 'note strength provenance',
    // A note's strength is either the model's stored assessment or a default
    // carried by the row it came from. Recording which lets a later reader
    // weigh the number honestly instead of treating every 1.0 as measured.
    // Additive only; existing rows read as 'default'.
    columns: [['canon_thread_note', 'strength_source', "TEXT NOT NULL DEFAULT 'default'"]],
  },
  {
    version: 25,
    name: 'claim kinds and visible contradictions',
    // Two additions. A note remembers which concept it asserted, so two notes
    // on one thread can be compared; and opposition between them is recorded
    // as a visible conflict, never as a ruling. Additive only.
    columns: [['canon_thread_note', 'claim_kind', "TEXT NOT NULL DEFAULT ''"]],
    sql: `
      CREATE TABLE IF NOT EXISTS canon_thread_conflict (
        id          INTEGER PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        thread_id   INTEGER NOT NULL REFERENCES canon_thread(id) ON DELETE CASCADE,
        note_low    INTEGER NOT NULL REFERENCES canon_thread_note(id) ON DELETE CASCADE,
        note_high   INTEGER NOT NULL REFERENCES canon_thread_note(id) ON DELETE CASCADE,
        kind_low    TEXT NOT NULL DEFAULT '',
        kind_high   TEXT NOT NULL DEFAULT '',
        basis       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'visible',   -- visible | dismissed
        created_at  TEXT NOT NULL
      );
      -- One row per opposed pair of notes on one thread, whichever way round
      -- they were seen.
      CREATE UNIQUE INDEX IF NOT EXISTS canon_thread_conflict_pair
        ON canon_thread_conflict(project_id, thread_id, note_low, note_high);
      CREATE INDEX IF NOT EXISTS canon_thread_conflict_thread
        ON canon_thread_conflict(thread_id, status);
    `,
  },
  {
    version: 26,
    name: 'court record: rulings and docket',
    // Every status change writes one row here, whoever made it: the bank on
    // insert, the web when it gathers a clue, the chain when it verifies a
    // quote, the assessor when it scores, the guard on appeal, a human when
    // they rule. The relation's status is the current verdict; this table is
    // the record of how it got there. Additive only.
    sql: `
      CREATE TABLE IF NOT EXISTS canon_ruling (
        id          INTEGER PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        relation_id INTEGER REFERENCES canon_relation(id) ON DELETE SET NULL,
        thread_id   INTEGER REFERENCES canon_thread(id) ON DELETE SET NULL,
        subject     TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL,                 -- charge | clue | verdict | appeal | removal
        actor       TEXT NOT NULL,                 -- bank | web | chain | assessor | guard | human | external
        standard    TEXT NOT NULL DEFAULT '',
        from_status TEXT NOT NULL DEFAULT '',
        to_status   TEXT NOT NULL DEFAULT '',
        basis       TEXT NOT NULL DEFAULT '',
        quote_hash  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canon_ruling_relation
        ON canon_ruling(project_id, relation_id, id);
      CREATE INDEX IF NOT EXISTS canon_ruling_subject
        ON canon_ruling(project_id, subject, id);
    `,
  },
  {
    version: 27,
    name: 'relation status: when the tie holds',
    // Current, past, suspected or unknown, read from the winning sentence.
    // Every banked row carries one; `unknown` is the honest value when no
    // sentence proved the row, never a silent default of `current`.
    columns: [
      ['canon_relation', 'relation_status', "TEXT NOT NULL DEFAULT 'unknown'"],
    ],
  },
  {
    version: 29,
    name: 'claim identity and proof history',
    // Stable claim instances plus an append-only proof ledger. Claim UIDs are
    // independent of SQLite rowids, so a deleted and recreated claim cannot
    // inherit an old proof. Existing rows are backfilled before any proof is
    // evaluated. No review status or authorization is changed here.
    columns: [
      ['canon_relation', 'claim_uid', 'TEXT'],
      ['canon_entity', 'claim_uid', 'TEXT'],
      ['canon_fact', 'claim_uid', 'TEXT'],
    ],
    sql: `
      UPDATE canon_relation
         SET claim_uid = 'rel-' || lower(hex(randomblob(16)))
       WHERE claim_uid IS NULL OR claim_uid = '';
      UPDATE canon_entity
         SET claim_uid = 'ent-' || lower(hex(randomblob(16)))
       WHERE claim_uid IS NULL OR claim_uid = '';
      UPDATE canon_fact
         SET claim_uid = 'fact-' || lower(hex(randomblob(16)))
       WHERE claim_uid IS NULL OR claim_uid = '';

      CREATE UNIQUE INDEX IF NOT EXISTS canon_relation_claim_uid
        ON canon_relation(project_id, claim_uid);
      CREATE UNIQUE INDEX IF NOT EXISTS canon_entity_claim_uid
        ON canon_entity(project_id, claim_uid);
      CREATE UNIQUE INDEX IF NOT EXISTS canon_fact_claim_uid
        ON canon_fact(project_id, claim_uid);

      CREATE TABLE IF NOT EXISTS claim_proof (
        id                    INTEGER PRIMARY KEY,
        project_id            INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        claim_type            TEXT NOT NULL,       -- relation | entity | fact
        claim_uid             TEXT NOT NULL,
        claim_id_at_eval      INTEGER,             -- diagnostic snapshot; not identity
        standard              TEXT NOT NULL,       -- sentence | passage | identity | none
        outcome               TEXT NOT NULL,       -- verified | failed | not_evaluated | legacy_unknown
        claim_fingerprint     TEXT NOT NULL,
        evidence_fingerprint  TEXT NOT NULL,
        input_fingerprint     TEXT NOT NULL,
        fingerprint_version   TEXT NOT NULL,
        policy_version        TEXT NOT NULL,
        gate_version          TEXT NOT NULL DEFAULT '',
        attempt_seq           INTEGER NOT NULL,
        checked_at            TEXT,
        proof_run_id          INTEGER REFERENCES extraction_run(id) ON DELETE SET NULL,
        quote_hash            TEXT NOT NULL DEFAULT '',
        detail                TEXT NOT NULL DEFAULT '',
        created_at            TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS claim_proof_attempt
        ON claim_proof(project_id, claim_type, claim_uid, attempt_seq);
      CREATE INDEX IF NOT EXISTS claim_proof_latest
        ON claim_proof(project_id, claim_type, claim_uid, attempt_seq DESC, id DESC);
      CREATE INDEX IF NOT EXISTS claim_proof_outcome
        ON claim_proof(project_id, claim_type, outcome);
    `,
  },
  {
    version: 28,
    name: 'durable extraction-run provenance',
    // What each extraction run and window actually did. Additive only:
    // proof, promotion and lore_mined remain authoritative. A window row is
    // committed as the window finishes, so a crash leaves completed and
    // partial windows visible instead of rolling them back.
    sql: `
      CREATE TABLE IF NOT EXISTS extraction_run (
        id              INTEGER PRIMARY KEY,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        provider        TEXT NOT NULL DEFAULT '',
        model           TEXT NOT NULL DEFAULT '',
        prompt_hash     TEXT NOT NULL DEFAULT '',
        seed            INTEGER,
        window_size     INTEGER NOT NULL DEFAULT 0,
        max_tokens      INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'running',  -- running | completed | partial | failed
        windows_total   INTEGER NOT NULL DEFAULT 0,
        windows_complete INTEGER NOT NULL DEFAULT 0,
        windows_partial INTEGER NOT NULL DEFAULT 0,
        windows_failed  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS extraction_run_project
        ON extraction_run(project_id, id);

      CREATE TABLE IF NOT EXISTS extraction_window_run (
        id              INTEGER PRIMARY KEY,
        run_id          INTEGER NOT NULL REFERENCES extraction_run(id) ON DELETE CASCADE,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        window_index    INTEGER NOT NULL,
        locator         TEXT NOT NULL DEFAULT '',
        state           TEXT NOT NULL,                    -- complete | partial | failed
        sections        TEXT NOT NULL DEFAULT '[]',       -- JSON ExtractionSectionReport[]
        failed_sections TEXT NOT NULL DEFAULT '[]',       -- JSON section names
        wrote_entities  INTEGER NOT NULL DEFAULT 0,
        wrote_facts     INTEGER NOT NULL DEFAULT 0,
        wrote_relations INTEGER NOT NULL DEFAULT 0,
        wrote_timeline  INTEGER NOT NULL DEFAULT 0,
        error           TEXT NOT NULL DEFAULT '',
        chunk_ids       TEXT NOT NULL DEFAULT '[]',       -- JSON chunk ids
        started_at      TEXT NOT NULL,
        finished_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS extraction_window_run_run
        ON extraction_window_run(run_id);
      -- One provenance row per window per run: a retry is a new run, so this
      -- is idempotent within a run without collapsing runs across retries.
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_window_run_window
        ON extraction_window_run(run_id, window_index);
    `,
  },
  {
    version: 31,
    name: 'durable extraction recovery ledger',
    // Additive only. Existing canon rows, lore_mined flags and the old
    // extraction_run/extraction_window_run provenance remain untouched. These
    // tables hold ownership, attempts, staged complete batches, stage
    // coverage and contribution/effect identities for the recovery controller.
    sql: `
      CREATE TABLE IF NOT EXISTS extraction_recovery_parent (
        id                  INTEGER PRIMARY KEY,
        project_id          INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        source_id           INTEGER REFERENCES canon_source(id) ON DELETE SET NULL,
        scope_key           TEXT NOT NULL,
        dependency_version  TEXT NOT NULL,
        fingerprint         TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        readiness           TEXT NOT NULL DEFAULT 'pending',
        optional_status     TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        completed_at        TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_recovery_parent_scope
        ON extraction_recovery_parent(project_id, scope_key, fingerprint);
      CREATE INDEX IF NOT EXISTS extraction_recovery_parent_status
        ON extraction_recovery_parent(project_id, status);

      CREATE TABLE IF NOT EXISTS extraction_recovery_child (
        id                  INTEGER PRIMARY KEY,
        parent_id           INTEGER NOT NULL REFERENCES extraction_recovery_parent(id) ON DELETE CASCADE,
        project_id          INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        work_key            TEXT NOT NULL,
        window_index        INTEGER NOT NULL,
        source_order        INTEGER NOT NULL DEFAULT 0,
        chunk_ids           TEXT NOT NULL DEFAULT '[]',
        required_stages     TEXT NOT NULL DEFAULT '[]',
        stage_fingerprints  TEXT NOT NULL DEFAULT '{}',
        fingerprint         TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        fencing             INTEGER NOT NULL DEFAULT 0,
        retry_epoch         INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        completed_at        TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_recovery_child_window
        ON extraction_recovery_child(parent_id, window_index);
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_recovery_child_work
        ON extraction_recovery_child(project_id, work_key)
        WHERE work_key <> '';
      CREATE INDEX IF NOT EXISTS extraction_recovery_child_status
        ON extraction_recovery_child(project_id, status);

      CREATE TABLE IF NOT EXISTS extraction_recovery_run_child (
        parent_id           INTEGER NOT NULL REFERENCES extraction_recovery_parent(id) ON DELETE CASCADE,
        child_id            INTEGER NOT NULL REFERENCES extraction_recovery_child(id) ON DELETE CASCADE,
        window_index        INTEGER NOT NULL,
        source_order        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (parent_id, window_index)
      );
      CREATE INDEX IF NOT EXISTS extraction_recovery_run_child_child
        ON extraction_recovery_run_child(child_id);
      CREATE INDEX IF NOT EXISTS extraction_recovery_run_child_order
        ON extraction_recovery_run_child(parent_id, source_order);

      CREATE TABLE IF NOT EXISTS extraction_recovery_chunk_work (
        chunk_id            INTEGER NOT NULL REFERENCES canon_chunk(id) ON DELETE CASCADE,
        project_id          INTEGER NOT NULL,
        child_id            INTEGER NOT NULL REFERENCES extraction_recovery_child(id) ON DELETE CASCADE,
        work_key            TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (chunk_id, child_id)
      );
      CREATE INDEX IF NOT EXISTS extraction_recovery_chunk_work_project
        ON extraction_recovery_chunk_work(project_id, chunk_id);
      CREATE INDEX IF NOT EXISTS extraction_recovery_chunk_work_child
        ON extraction_recovery_chunk_work(child_id);

      CREATE TABLE IF NOT EXISTS extraction_attempt (
        id                  INTEGER PRIMARY KEY,
        child_id            INTEGER NOT NULL REFERENCES extraction_recovery_child(id) ON DELETE CASCADE,
        project_id          INTEGER NOT NULL,
        stage               TEXT NOT NULL,
        fingerprint         TEXT NOT NULL,
        retry_epoch         INTEGER NOT NULL DEFAULT 0,
        attempt_number      INTEGER NOT NULL,
        status              TEXT NOT NULL,
        owner               TEXT NOT NULL,
        fencing             INTEGER NOT NULL,
        lease_until         TEXT NOT NULL,
        finish_reason       TEXT NOT NULL DEFAULT '',
        parser_route        TEXT NOT NULL DEFAULT '',
        error_code          TEXT NOT NULL DEFAULT '',
        started_at          TEXT NOT NULL,
        finished_at         TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_attempt_number
        ON extraction_attempt(child_id, stage, fingerprint, retry_epoch, attempt_number);
      CREATE INDEX IF NOT EXISTS extraction_attempt_running
        ON extraction_attempt(status, lease_until);
      CREATE INDEX IF NOT EXISTS extraction_attempt_child
        ON extraction_attempt(child_id, stage, fingerprint, retry_epoch);

      CREATE TABLE IF NOT EXISTS extraction_staged_batch (
        id                  INTEGER PRIMARY KEY,
        attempt_id          INTEGER NOT NULL REFERENCES extraction_attempt(id) ON DELETE CASCADE,
        child_id            INTEGER NOT NULL,
        project_id          INTEGER NOT NULL,
        stage               TEXT NOT NULL,
        fingerprint         TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        payload_sha256      TEXT NOT NULL,
        byte_size           INTEGER NOT NULL,
        complete            INTEGER NOT NULL DEFAULT 0,
        finish_reason       TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_staged_batch_payload
        ON extraction_staged_batch(child_id, stage, fingerprint, payload_sha256);
      CREATE INDEX IF NOT EXISTS extraction_staged_batch_child
        ON extraction_staged_batch(child_id, stage);

      CREATE TABLE IF NOT EXISTS extraction_stage_coverage (
        id                  INTEGER PRIMARY KEY,
        child_id            INTEGER NOT NULL REFERENCES extraction_recovery_child(id) ON DELETE CASCADE,
        project_id          INTEGER NOT NULL,
        stage               TEXT NOT NULL,
        fingerprint         TEXT NOT NULL,
        status              TEXT NOT NULL,
        attempt_id          INTEGER REFERENCES extraction_attempt(id) ON DELETE SET NULL,
        result_json         TEXT NOT NULL DEFAULT '{}',
        finalized_at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_stage_coverage_key
        ON extraction_stage_coverage(child_id, stage, fingerprint);
      CREATE INDEX IF NOT EXISTS extraction_stage_coverage_status
        ON extraction_stage_coverage(project_id, status);

      CREATE TABLE IF NOT EXISTS extraction_contribution (
        id                  INTEGER PRIMARY KEY,
        project_id          INTEGER NOT NULL,
        child_id            INTEGER NOT NULL,
        stage               TEXT NOT NULL,
        contribution_uid    TEXT NOT NULL,
        claim_type          TEXT NOT NULL,
        payload_sha256      TEXT NOT NULL,
        dependency_fingerprint TEXT NOT NULL DEFAULT '',
        evaluation_count    INTEGER NOT NULL DEFAULT 0,
        disposition         TEXT NOT NULL DEFAULT 'applied',
        canon_table         TEXT NOT NULL DEFAULT '',
        canon_id            INTEGER,
        applied_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_contribution_uid
        ON extraction_contribution(project_id, contribution_uid);
      CREATE INDEX IF NOT EXISTS extraction_contribution_child
        ON extraction_contribution(child_id, stage);
      CREATE INDEX IF NOT EXISTS extraction_contribution_canon
        ON extraction_contribution(project_id, canon_table, canon_id);

      CREATE TABLE IF NOT EXISTS extraction_effect (
        id                  INTEGER PRIMARY KEY,
        contribution_id     INTEGER NOT NULL REFERENCES extraction_contribution(id) ON DELETE CASCADE,
        effect_type         TEXT NOT NULL,
        effect_key          TEXT NOT NULL,
        canon_table         TEXT NOT NULL DEFAULT '',
        canon_id            INTEGER,
        created_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_effect_key
        ON extraction_effect(contribution_id, effect_type, effect_key);
      CREATE INDEX IF NOT EXISTS extraction_effect_canon
        ON extraction_effect(canon_table, canon_id);

      CREATE TABLE IF NOT EXISTS extraction_chunk_lease (
        chunk_id            INTEGER PRIMARY KEY REFERENCES canon_chunk(id) ON DELETE CASCADE,
        project_id          INTEGER NOT NULL,
        child_id            INTEGER NOT NULL,
        owner               TEXT NOT NULL,
        fencing             INTEGER NOT NULL,
        lease_until         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extraction_chunk_lease_child
        ON extraction_chunk_lease(child_id);
      CREATE INDEX IF NOT EXISTS extraction_chunk_lease_expiry
        ON extraction_chunk_lease(lease_until);

      CREATE TABLE IF NOT EXISTS extraction_roster_snapshot (
        id                  INTEGER PRIMARY KEY,
        project_id          INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        fingerprint         TEXT NOT NULL,
        roster_json         TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_roster_snapshot_fingerprint
        ON extraction_roster_snapshot(project_id, fingerprint);
    `,
  },
  {
    version: 32,
    name: 'recovery ledger v31 upgrade',
    // Migration 31 was edited in place during the experiment. A database that
    // already recorded user_version 31 therefore skipped the revised shape.
    // This later migration adds the missing columns/tables/indexes. Old
    // experimental rows with an empty work_key are deliberately not reusable:
    // they remain visible but fail closed as legacy-v31 work.
    columns: [
      ['extraction_recovery_parent', 'readiness', "TEXT NOT NULL DEFAULT 'pending'"],
      ['extraction_recovery_parent', 'optional_status', "TEXT NOT NULL DEFAULT '{}'"],
      ['extraction_recovery_child', 'work_key', "TEXT NOT NULL DEFAULT ''"],
      ['extraction_recovery_child', 'retry_epoch', 'INTEGER NOT NULL DEFAULT 0'],
      ['extraction_attempt', 'fingerprint', "TEXT NOT NULL DEFAULT ''"],
      ['extraction_attempt', 'retry_epoch', 'INTEGER NOT NULL DEFAULT 0'],
      ['extraction_contribution', 'dependency_fingerprint', "TEXT NOT NULL DEFAULT ''"],
      ['extraction_contribution', 'evaluation_count', 'INTEGER NOT NULL DEFAULT 0'],
    ],
    sql: `
      DROP INDEX IF EXISTS extraction_attempt_number;
      DROP INDEX IF EXISTS extraction_attempt_child;
      DROP INDEX IF EXISTS extraction_recovery_child_work;

      CREATE UNIQUE INDEX IF NOT EXISTS extraction_attempt_number
        ON extraction_attempt(child_id, stage, fingerprint, retry_epoch, attempt_number);
      CREATE INDEX IF NOT EXISTS extraction_attempt_child
        ON extraction_attempt(child_id, stage, fingerprint, retry_epoch);
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_recovery_child_work
        ON extraction_recovery_child(project_id, work_key)
        WHERE work_key <> '';

      CREATE TABLE IF NOT EXISTS extraction_recovery_run_child (
        parent_id           INTEGER NOT NULL REFERENCES extraction_recovery_parent(id) ON DELETE CASCADE,
        child_id            INTEGER NOT NULL REFERENCES extraction_recovery_child(id) ON DELETE CASCADE,
        window_index        INTEGER NOT NULL,
        source_order        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (parent_id, window_index)
      );
      CREATE INDEX IF NOT EXISTS extraction_recovery_run_child_child
        ON extraction_recovery_run_child(child_id);
      CREATE INDEX IF NOT EXISTS extraction_recovery_run_child_order
        ON extraction_recovery_run_child(parent_id, source_order);

      CREATE TABLE IF NOT EXISTS extraction_recovery_chunk_work (
        chunk_id            INTEGER NOT NULL REFERENCES canon_chunk(id) ON DELETE CASCADE,
        project_id          INTEGER NOT NULL,
        child_id            INTEGER NOT NULL REFERENCES extraction_recovery_child(id) ON DELETE CASCADE,
        work_key            TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (chunk_id, child_id)
      );
      CREATE INDEX IF NOT EXISTS extraction_recovery_chunk_work_project
        ON extraction_recovery_chunk_work(project_id, chunk_id);
      CREATE INDEX IF NOT EXISTS extraction_recovery_chunk_work_child
        ON extraction_recovery_chunk_work(child_id);
    `,
  },
  {
    version: 30,
    name: 'trace ledger',
    // Observability only: a trace records what a pipeline stage decided, not
    // the prompt or the passage. Required events are written in the same
    // transaction as the decision they describe; diagnostic events are
    // best-effort and may be sampled, capped or pruned.
    sql: `
      CREATE TABLE IF NOT EXISTS trace (
        id              TEXT PRIMARY KEY,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        completeness    TEXT NOT NULL DEFAULT 'complete'
                        CHECK (completeness IN ('complete','sampled','truncated','interrupted')),
        sampled_rate    REAL NOT NULL DEFAULT 1.0,
        dropped_events  INTEGER NOT NULL DEFAULT 0,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trace_project_started
        ON trace(project_id, started_at);

      CREATE TABLE IF NOT EXISTS trace_event (
        id              INTEGER PRIMARY KEY,
        trace_id        TEXT NOT NULL REFERENCES trace(id) ON DELETE CASCADE,
        span_id         TEXT NOT NULL,
        parent_span_id  TEXT,
        project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        stage           TEXT NOT NULL,
        event           TEXT NOT NULL,
        event_class     TEXT NOT NULL CHECK (event_class IN ('required','diagnostic')),
        subject         TEXT NOT NULL DEFAULT '',
        decision        TEXT NOT NULL DEFAULT '',
        reason_code     TEXT NOT NULL DEFAULT '',
        refs            TEXT NOT NULL DEFAULT '{}',
        model           TEXT NOT NULL DEFAULT '',
        prompt_hash     TEXT NOT NULL DEFAULT '',
        duration_ms     REAL,
        error           TEXT NOT NULL DEFAULT '',
        committed       INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0,1)),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trace_event_trace_span
        ON trace_event(trace_id, span_id);
      CREATE INDEX IF NOT EXISTS trace_event_project_stage
        ON trace_event(project_id, stage);
      CREATE INDEX IF NOT EXISTS trace_event_subject
        ON trace_event(subject);
      CREATE INDEX IF NOT EXISTS trace_event_class
        ON trace_event(event_class);
      CREATE INDEX IF NOT EXISTS trace_event_created
        ON trace_event(created_at);
    `,
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
  // again is harmless. It is run whenever the database is missing any known
  // table or a later column, even if the version number says otherwise — a
  // database can carry a high version without the objects behind it.
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
  // Every table the current schema owns, not only the original twelve: a
  // version-32 database missing claim_proof, trace, canon_thread or the
  // recovery ledger must be rebuilt too, not silently served.
  const REQUIRED_TABLES = [
    ...BASE_TABLES,
    'schema_meta',
    'au_event_link',
    'au_event_participant',
    'canon_birth',
    'canon_change',
    'canon_event_participant',
    'canon_meeting',
    'canon_meeting_exchange',
    'canon_meeting_resolution',
    'canon_open_end',
    'canon_pair_thread',
    'canon_ruling',
    'canon_thread',
    'canon_thread_conflict',
    'canon_thread_note',
    'canon_thread_note_ref',
    'canon_thread_passage',
    'canon_tie_hint',
    'canon_tie_note',
    'chapter_revision',
    'chapter_summary',
    'character_knowledge',
    'character_state',
    'claim_proof',
    'context_request',
    'continuity_issue',
    'embedding',
    'extraction_attempt',
    'extraction_chunk_lease',
    'extraction_contribution',
    'extraction_effect',
    'extraction_recovery_child',
    'extraction_recovery_chunk_work',
    'extraction_recovery_parent',
    'extraction_recovery_run_child',
    'extraction_roster_snapshot',
    'extraction_run',
    'extraction_stage_coverage',
    'extraction_staged_batch',
    'extraction_window_run',
    'graph_write',
    'message',
    'motivation',
    'outline',
    'plot_thread',
    'quarantine_alias',
    'relationship',
    'secret',
    'state_conflict',
    'thread_event',
    'trace',
    'trace_event',
  ];
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  // Which migration first creates each table. Missing objects introduced after
  // the stored version are simply pending work for the normal loop; missing
  // objects the stored version claims to include mean the high number is a
  // lie, and the schema must be rebuilt from the base.
  const tableVersion = new Map<string, number>();
  let quarantineVersion = 0;
  for (const migration of ordered) {
    for (const match of (migration.sql ?? '').matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)) {
      // Keep the latest creator: an experimental migration edited in place may
      // have re-created a table it originally missed, so a higher version can
      // legitimately add it again.
      tableVersion.set(match[1]!, migration.version);
    }
    if ((migration.columns ?? []).some(([table, column]) => table === 'canon_entity' && column === 'quarantine_reason')) {
      quarantineVersion = migration.version;
    }
  }
  const missingBase = BASE_TABLES.filter((t) => !tableExists(db, t));
  const staleMissing = REQUIRED_TABLES.filter(
    (table) =>
      !BASE_TABLES.includes(table) &&
      !tableExists(db, table) &&
      (tableVersion.get(table) ?? 0) <= version,
  );
  const staleColumn = !hasColumn(db, 'canon_entity', 'quarantine_reason') && quarantineVersion <= version;
  const needsRecovery = missingBase.length > 0 || staleMissing.length > 0 || staleColumn;

  // The effective version starts at the stored one but drops to 1 when the
  // base is rebuilt, so every later idempotent migration runs instead of being
  // suppressed by the stale high number.
  let current = version;
  for (const migration of ordered) {
    const isBase = migration.version === 1;
    if (isBase) {
      if (!needsRecovery) continue;
    } else if (migration.version <= current) {
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
      current = migration.version;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${(err as Error).message}`);
    }
  }
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? current);
}
