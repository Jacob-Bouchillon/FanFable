/**
 * Evidence must align to lexical boundaries. Normalization may ignore case,
 * punctuation and whitespace, but it must not turn a fragment inside a larger
 * word into a quote.
 *
 * Direct verifySpan checks plus one extraction persistence check. Temp DBs
 * only; the invented passages are test fixtures, not repository data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { isVerbatimInChunk } from '../../fanfable/src/web/note-ingest.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2024-01-01T00:00:00.000Z';

function chunk(text: string, id = 1) {
  return {
    id,
    seq: 0,
    heading: '',
    locator: 'p. 1',
    text,
    source_title: 'Probe',
    path: '/probe',
    source_id: 1,
  };
}

function accepted(raw: string, text: string): ReturnType<typeof lorebook.verifySpan> {
  const result = lorebook.verifySpan(raw, chunk(text));
  assert.equal(result.status, 'verified');
  assert.ok(result.quote.length > 0);
  assert.ok(isVerbatimInChunk(text, result.quote), `raw-exact canonical span for ${raw}`);
  return result;
}

test('sub-word fragments are dropped', () => {
  assert.equal(lorebook.verifySpan('art', chunk('The party started.')).status, 'dropped');
  assert.equal(lorebook.verifySpan('he', chunk('The party started.')).status, 'dropped');
  assert.equal(lorebook.verifySpan('art', chunk('The party started.')).quote, '');
  assert.equal(lorebook.verifySpan('he', chunk('The party started.')).quote, '');
});

test('full words and multi-word phrases at token boundaries are verified', () => {
  assert.equal(accepted('art', 'The art of war.').quote, 'art');
  assert.equal(accepted('art of war', 'The art of war.').quote, 'art of war.');
  assert.equal(accepted('war', 'The art of war.').quote, 'war.');
});

test('possessives keep the word boundary and apostrophe rules', () => {
  assert.equal(accepted("Mara's", "Mara's coat.").quote, "Mara's");
  assert.equal(lorebook.verifySpan('Mara', chunk("Mara's coat.")).status, 'dropped');
  assert.equal(accepted('Mara', 'Mara waited.').quote, 'Mara');
});

test('punctuation and quoted phrases remain valid and raw-exact', () => {
  assert.equal(accepted('Hello', '"Hello," she said.').quote, '"Hello,"');
  assert.equal(accepted('Hello', "'Hello' she said.").quote, 'Hello');
  assert.equal(accepted('Hello', '"Hello" she said.').quote, '"Hello"');
  assert.equal(accepted('"Hello"', '"Hello" she said.').quote, '"Hello"');
  assert.equal(accepted("'Hello'", "'Hello' she said.").quote, "'Hello'");
});

test('hyphenated compounds are one lexical unit, not a prefix boundary', () => {
  assert.equal(accepted('Force-sensitive', 'A Force-sensitive user.').quote, 'Force-sensitive');
  assert.equal(accepted('Force', 'A Force-sensitive user. Force waited.').quote, 'Force');
  assert.equal(lorebook.verifySpan('Force', chunk('A Force-sensitive user.')).status, 'dropped');
  assert.equal(lorebook.verifySpan('sensitive', chunk('A Force-sensitive user.')).status, 'dropped');
  assert.equal(accepted('well-known', 'A well-known author.').quote, 'well-known');
  assert.equal(accepted('well known', 'A well-known author.').quote, 'well-known');
  assert.equal(lorebook.verifySpan('well', chunk('A well-known author.')).status, 'dropped');
  assert.equal(accepted('well', 'A well - known author.').quote, 'well');
  assert.equal(accepted('well - known', 'A well - known author.').quote, 'well - known');
});

test('sub-word digits are rejected while standalone digits are accepted', () => {
  assert.equal(lorebook.verifySpan('23', chunk('Room 123.')).status, 'dropped');
  assert.equal(lorebook.verifySpan('23', chunk('Room 123.')).quote, '');
  assert.equal(accepted('23', 'At 23 doors.').quote, '23');
});

test('normalized-only boundary variants stay ambiguous; repeated exact text uses the first', () => {
  assert.equal(lorebook.verifySpan('hello', chunk('Hello. HELLO.')).status, 'dropped');
  assert.equal(lorebook.verifySpan('hello', chunk('Hello. HELLO.')).quote, '');
  assert.equal(accepted('hello', 'hello. hello.').quote, 'hello.');
});

test('accepted spans are raw-exact in the source chunk', () => {
  const source = 'The well-known "Hello," said Mara\'s friend at 23 doors.';
  for (const quote of ['well-known', 'Hello', "Mara's", '23', '23 doors']) {
    const result = accepted(quote, source);
    assert.ok(source.includes(result.quote), `${quote} canonical output is a source substring`);
  }
});

test('a sub-word evidence candidate writes no extracted row', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'boundary-extraction');
  const sourceId = Number(
    db.run(
      `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
       VALUES (?, '/boundary', 'Boundary Probe', 'sha-boundary', ?)`,
      project.id,
      AT,
    ).lastInsertRowid,
  );
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, 0, 'p. 1', '', 'The party started.', 3)`,
    sourceId,
    project.id,
  );

  const llm = mockProvider((req) => {
    if (req.system === lorebook.EXTRACT_SYSTEM) {
      return JSON.stringify({
        entities: [
          {
            kind: 'character',
            name: 'Ghost Fragment',
            aliases: [],
            summary: '',
            attributes: {},
            role: '',
            status: '',
            chunk_index: 0,
            evidence: 'art',
          },
        ],
        relations: [],
        facts: [],
        timeline: [],
      });
    }
    return JSON.stringify({ entities: [], relations: [], facts: [], timeline: [] });
  });
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    singlePrompt: true,
  });

  assert.equal(stats.verification.claimed, 1);
  assert.equal(stats.verification.dropped, 1);
  assert.equal(stats.entities, 0);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)!.n,
    0,
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM claim_proof WHERE project_id = ?', project.id)!.n,
    0,
  );
  db.close();
});
