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
