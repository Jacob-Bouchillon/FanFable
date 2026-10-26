/**
 * Database schema.
 *
 * Two sources of truth live side by side and never overwrite each other:
 *
 *   CANON  (canon_source, canon_chunk, canon_chunk_fts, canon_event)
 *     The imported original material. Written once at import time and never
 *     modified by story generation. Provides evidence for lore questions and
 *     for canon/AU comparisons.
 *
 *   STORY  (outline, chapter, au_event, character*, relationship, plot_thread,
 *           story_fact, chapter_summary, canon_change)
 *     The alternate-universe story being written. It evolves, gets revised and
 *     gets approved. It links back to canon through canon_event, but canon is
 *     never mutated by it.
 *
 * Everything is scoped by project_id so several books can live in one database.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- projects
CREATE TABLE IF NOT EXISTS project (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settings   TEXT NOT NULL DEFAULT '{}'
);

-- ============================================================ CANON (immutable)
CREATE TABLE IF NOT EXISTS canon_source (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  format      TEXT NOT NULL DEFAULT 'txt',
  sha256      TEXT NOT NULL,
  byte_size   INTEGER NOT NULL DEFAULT 0,
  page_count  INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS canon_source_project_path ON canon_source(project_id, path);

CREATE TABLE IF NOT EXISTS canon_chunk (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES canon_source(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  locator    TEXT NOT NULL DEFAULT '',
  heading    TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end   INTEGER NOT NULL DEFAULT 0,
  words      INTEGER NOT NULL DEFAULT 0,
  page_start INTEGER NOT NULL DEFAULT 0,
  page_end   INTEGER NOT NULL DEFAULT 0,
  lore_mined INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS canon_chunk_source ON canon_chunk(source_id, seq);
CREATE INDEX IF NOT EXISTS canon_chunk_project ON canon_chunk(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS canon_chunk_fts USING fts5(
  text, heading, locator,
  content='canon_chunk', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS canon_chunk_ai AFTER INSERT ON canon_chunk BEGIN
  INSERT INTO canon_chunk_fts(rowid, text, heading, locator)
  VALUES (new.id, new.text, new.heading, new.locator);
END;
CREATE TRIGGER IF NOT EXISTS canon_chunk_ad AFTER DELETE ON canon_chunk BEGIN
  INSERT INTO canon_chunk_fts(canon_chunk_fts, rowid, text, heading, locator)
  VALUES ('delete', old.id, old.text, old.heading, old.locator);
END;
CREATE TRIGGER IF NOT EXISTS canon_chunk_au AFTER UPDATE ON canon_chunk BEGIN
  INSERT INTO canon_chunk_fts(canon_chunk_fts, rowid, text, heading, locator)
  VALUES ('delete', old.id, old.text, old.heading, old.locator);
  INSERT INTO canon_chunk_fts(rowid, text, heading, locator)
  VALUES (new.id, new.text, new.heading, new.locator);
END;

-- Events extracted from the original material. Written once, never edited by the
-- story engine; the AU links to these rows, it does not change them.
CREATE TABLE IF NOT EXISTS canon_event (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_id    INTEGER REFERENCES canon_source(id) ON DELETE SET NULL,
  chunk_id     INTEGER REFERENCES canon_chunk(id) ON DELETE SET NULL,
  locator      TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',
  location     TEXT NOT NULL DEFAULT '',
  time_label   TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'event',
  quote        TEXT NOT NULL DEFAULT '',
  confidence   REAL NOT NULL DEFAULT 1.0,
  seq          INTEGER NOT NULL DEFAULT 0,      -- order within the book
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_event_project ON canon_event(project_id);

-- ------------------------------------------------- extracted book lore
-- What the source material actually contains, pulled out into structured form:
-- people, places, things, rules, and the relationships and facts between them.
-- Every row keeps the passages it came from, so a claim can always be checked.
CREATE TABLE IF NOT EXISTS canon_entity (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'character',  -- character | location | item | rule | faction | creature
  name         TEXT NOT NULL,
  aliases      TEXT NOT NULL DEFAULT '[]',
  summary      TEXT NOT NULL DEFAULT '',
  attributes   TEXT NOT NULL DEFAULT '{}',        -- json: kind-specific detail
  role         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',          -- e.g. "alive", "dead", "missing"
  first_chunk  INTEGER REFERENCES canon_chunk(id) ON DELETE SET NULL,
  evidence     TEXT NOT NULL DEFAULT '',          -- quote from the source
  source_refs  TEXT NOT NULL DEFAULT '[]',        -- json array of {source, locator, chunk}
  mentions     INTEGER NOT NULL DEFAULT 0,
  confidence   REAL NOT NULL DEFAULT 1.0,          -- how sure the extraction was
  review_status TEXT NOT NULL DEFAULT 'accepted', -- accepted | needs_review | rejected
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_entity_project ON canon_entity(project_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS canon_entity_unique ON canon_entity(project_id, kind, lower(name));

CREATE TABLE IF NOT EXISTS canon_relation (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_entity   INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
  to_entity     INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  evidence      TEXT NOT NULL DEFAULT '',
  source_refs   TEXT NOT NULL DEFAULT '[]',
  confidence    REAL NOT NULL DEFAULT 1.0,
  review_status TEXT NOT NULL DEFAULT 'accepted',
  valid_from_event_id INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  valid_to_event_id   INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  ledger_state  TEXT NOT NULL DEFAULT 'verified',
  scope         TEXT NOT NULL DEFAULT '',
  superseding_chapter INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS canon_relation_pair_kind_scope ON canon_relation(project_id, from_entity, to_entity, kind, scope);

-- Statements the source supports: world rules, definitions, background facts.
CREATE TABLE IF NOT EXISTS canon_fact (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  topic        TEXT NOT NULL DEFAULT '',
  statement    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'fact',  -- rule | fact | background | motive | secret
  certainty    TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | inferred
  subject      TEXT NOT NULL DEFAULT '',    -- related entity name
  evidence     TEXT NOT NULL DEFAULT '',
  source_refs  TEXT NOT NULL DEFAULT '[]',
  subject_entity_id INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL,
  confidence   REAL NOT NULL DEFAULT 1.0,
  review_status TEXT NOT NULL DEFAULT 'accepted',
  valid_from_event_id INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  valid_to_event_id   INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_fact_project ON canon_fact(project_id, topic);

-- The book's own timeline, ordered, so the AU can be placed against it.
CREATE TABLE IF NOT EXISTS canon_timeline (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  canon_event  INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  time_label   TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',
  location     TEXT NOT NULL DEFAULT '',
  evidence     TEXT NOT NULL DEFAULT '',
  source_refs  TEXT NOT NULL DEFAULT '[]',
  confidence   REAL NOT NULL DEFAULT 1.0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_timeline_project ON canon_timeline(project_id, seq);

-- ==================================================================== STORY
CREATE TABLE IF NOT EXISTS outline (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft | approved | superseded
  premise         TEXT NOT NULL DEFAULT '',
  divergence      TEXT NOT NULL DEFAULT '',
  divergence_ref  TEXT NOT NULL DEFAULT '',          -- canon_event id or free text
  canon_refs      TEXT NOT NULL DEFAULT '[]',        -- json array of canon_event ids
  structure       TEXT NOT NULL DEFAULT '[]',        -- json array of acts
  chapters        TEXT NOT NULL DEFAULT '[]',        -- json array of chapter outlines
  preferences     TEXT NOT NULL DEFAULT '{}',        -- json: tone, pov, tense, chapter length, ...
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  approved_at     TEXT
);
CREATE INDEX IF NOT EXISTS outline_project ON outline(project_id, version);

CREATE TABLE IF NOT EXISTS chapter (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft',        -- draft | approved
  outline_id   INTEGER REFERENCES outline(id) ON DELETE SET NULL,
  body         TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  word_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  approved_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chapter_project_number ON chapter(project_id, number);

CREATE TABLE IF NOT EXISTS chapter_revision (
  id         INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- The AU timeline: events that actually happen in the new story.
CREATE TABLE IF NOT EXISTS au_event (
  id                    INTEGER PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id            INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  seq                   INTEGER NOT NULL DEFAULT 0,
  title                 TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  story_time            TEXT NOT NULL DEFAULT '',
  story_order           REAL NOT NULL DEFAULT 0,
  participants          TEXT NOT NULL DEFAULT '[]',
  location              TEXT NOT NULL DEFAULT '',
  kind                  TEXT NOT NULL DEFAULT 'event',  -- event | scene | flashback | adaptation
  adapts_canon_event_id INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  divergence_note       TEXT NOT NULL DEFAULT '',
  confidence            REAL NOT NULL DEFAULT 1.0,
  review_status         TEXT NOT NULL DEFAULT 'accepted',
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS au_event_project ON au_event(project_id, story_order);
CREATE INDEX IF NOT EXISTS au_event_chapter ON au_event(chapter_id);

-- How the AU differs from canon, kept as a first-class record.
CREATE TABLE IF NOT EXISTS canon_change (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  au_event_id      INTEGER REFERENCES au_event(id) ON DELETE CASCADE,
  canon_event_id   INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  change_type      TEXT NOT NULL DEFAULT 'altered', -- altered | omitted | added | reversed | preserved
  description      TEXT NOT NULL DEFAULT '',
  confirmed        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_change_project ON canon_change(project_id);

CREATE TABLE IF NOT EXISTS character (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  aliases    TEXT NOT NULL DEFAULT '[]',
  profile    TEXT NOT NULL DEFAULT '',
  traits     TEXT NOT NULL DEFAULT '[]',
  canon_ref  TEXT NOT NULL DEFAULT '',
  canon_entity_id INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL, -- entity resolution
  confidence REAL NOT NULL DEFAULT 1.0,
  review_status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS character_project_name ON character(project_id, name);

CREATE TABLE IF NOT EXISTS character_state (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id   INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  as_of_event_id INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
  chapter_id     INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  location       TEXT NOT NULL DEFAULT '',
  condition      TEXT NOT NULL DEFAULT '',
  emotional      TEXT NOT NULL DEFAULT '',
  situation      TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'inferred',  -- canon | au | inferred | user
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS character_state_char ON character_state(character_id, id);

-- What a character knows / believes / misunderstands at a point in the story.
CREATE TABLE IF NOT EXISTS character_knowledge (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id   INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  fact           TEXT NOT NULL,
  topic          TEXT NOT NULL DEFAULT '',
  certainty      TEXT NOT NULL DEFAULT 'knows',  -- knows | believes | suspects | misunderstands | unknown
  source         TEXT NOT NULL DEFAULT 'inferred', -- canon | au | inference | user
  canon_event_id INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  au_event_id    INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
  fact_id        INTEGER REFERENCES story_fact(id) ON DELETE SET NULL,
  valid_until_event_id INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
  chapter_id     INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  evidence       TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS character_knowledge_char ON character_knowledge(character_id);

CREATE TABLE IF NOT EXISTS relationship (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_a  INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  character_b  INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  sentiment    TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'inferred',
  valid_from_event_id INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
  valid_to_event_id   INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
  confidence   REAL NOT NULL DEFAULT 1.0,
  chapter_id   INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  closed       INTEGER NOT NULL DEFAULT 0,   -- 0 = the current state of the pair
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relationship_pair_index ON relationship(project_id, character_a, character_b);

CREATE TABLE IF NOT EXISTS plot_thread (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',   -- open | resolved | dropped
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE TABLE IF NOT EXISTS thread_event (
  thread_id INTEGER NOT NULL REFERENCES plot_thread(id) ON DELETE CASCADE,
  event_id  INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'developed', -- introduced | developed | resolved
  PRIMARY KEY (thread_id, event_id)
);

-- Established decisions, promises, mysteries. The certainty column separates what the
-- user approved from drafts and suggestions.
CREATE TABLE IF NOT EXISTS story_fact (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'fact',  -- decision | promise | conflict | mystery | fact
  subject        TEXT NOT NULL DEFAULT '',
  content        TEXT NOT NULL,
  certainty      TEXT NOT NULL DEFAULT 'established', -- established | draft | suggestion
  chapter_id     INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  canon_event_id INTEGER REFERENCES canon_event(id) ON DELETE SET NULL,
  subject_entity_id INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL,
  confidence     REAL NOT NULL DEFAULT 1.0,
  review_status  TEXT NOT NULL DEFAULT 'accepted',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS story_fact_project ON story_fact(project_id);

CREATE TABLE IF NOT EXISTS chapter_summary (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL DEFAULT '',
  entities   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chapter_summary_chapter ON chapter_summary(chapter_id);

-- ---------------------------------------------- typed graph edges
-- These had no table of their own before the graph layer; they are the edges
-- that connect the canon and the story into one traversable structure.

-- Who took part in a canon event.
CREATE TABLE IF NOT EXISTS canon_event_participant (
  canon_event_id INTEGER NOT NULL REFERENCES canon_event(id) ON DELETE CASCADE,
  entity_id      INTEGER NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'participant',
  PRIMARY KEY (canon_event_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS canon_event_participant_entity ON canon_event_participant(entity_id);

-- Who took part in a story event.
CREATE TABLE IF NOT EXISTS au_event_participant (
  au_event_id  INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'participant',
  PRIMARY KEY (au_event_id, character_id, role)
);
CREATE INDEX IF NOT EXISTS au_event_participant_char ON au_event_participant(character_id);

-- Cause and consequence between events in the story.
CREATE TABLE IF NOT EXISTS au_event_link (
  project_id    INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_event_id INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
  to_event_id   INTEGER NOT NULL REFERENCES au_event(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'consequence', -- cause | consequence | foreshadow | contradicts
  description   TEXT NOT NULL DEFAULT '',
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (from_event_id, to_event_id, kind)
);
CREATE INDEX IF NOT EXISTS au_event_link_to ON au_event_link(to_event_id);

-- A fact that not everyone knows. Separate from character_knowledge so a
-- secret can exist before anyone learns it.
CREATE TABLE IF NOT EXISTS secret (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  statement    TEXT NOT NULL DEFAULT '',
  subject_entity_id INTEGER REFERENCES canon_entity(id) ON DELETE SET NULL,
  fact_id      INTEGER REFERENCES story_fact(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'open',  -- open | revealed | resolved
  revealed_at_event_id INTEGER REFERENCES au_event(id) ON DELETE SET NULL,
  chapter_id   INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS secret_project_title ON secret(project_id, lower(title));

-- Why a character does what they do.
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
  chapter_id   INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
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

-- A chapter that contradicts what the story already established. The
-- conflict is kept with its provenance so the author can resolve it; the
-- established record is not quietly overwritten.
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
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS state_conflict_project ON state_conflict(project_id, status);

-- ================================================ collaboration & bookkeeping
CREATE TABLE IF NOT EXISTS message (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,   -- user | assistant | system
  kind       TEXT NOT NULL DEFAULT 'chat', -- chat | plan | review
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_project ON message(project_id, id);

-- Log of dynamic context requests. Used to cap loops and to show the user what
-- the writer asked for.
CREATE TABLE IF NOT EXISTS context_request (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id   INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  requester    TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- lore | memory | canon | au | character
  query        TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'resolved', -- resolved | denied | duplicate
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_request_chapter ON context_request(chapter_id, id);

CREATE TABLE IF NOT EXISTS continuity_issue (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id   INTEGER REFERENCES chapter(id) ON DELETE CASCADE,
  severity     TEXT NOT NULL DEFAULT 'warning',  -- error | warning | note
  category     TEXT NOT NULL DEFAULT 'other',     -- chronology | knowledge | relationship | location | injury | motivation | canon-mix | repetition | thread | unexplained-change
  message      TEXT NOT NULL,
  evidence     TEXT NOT NULL DEFAULT '',
  suggestion   TEXT NOT NULL DEFAULT '',
  resolution   TEXT NOT NULL DEFAULT 'open',      -- open | accepted | fixed
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS continuity_issue_project ON continuity_issue(project_id, id);
`;
