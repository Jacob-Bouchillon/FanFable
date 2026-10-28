import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertFreshCorpusTarget } from '../scripts/benchmark/build-fresh-corpus.ts';

test('writing benchmark fixture uses the canonical house name consistently', () => {
  const fixturePath = resolve(import.meta.dirname, '../../testing/benchmarks/fixtures/story.json');
  const fixtureText = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureText) as {
    premise: string;
    chapters: { synopsis: string }[];
  };

  assert.match(fixture.premise, /Gryffindor/);
  assert.match(fixture.chapters[0]?.synopsis ?? '', /Ron to Gryffindor/);
  assert.doesNotMatch(fixtureText, /Gryffindin/);
});

test('fresh corpus builder refuses existing database or manifest paths', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'fanfable-fresh-corpus-'));
  const dbPath = resolve(root, 'corpus.db');
  try {
    const target = assertFreshCorpusTarget(dbPath);
    assert.equal(target.dbPath, dbPath);
    assert.equal(target.manifestPath, `${dbPath}.manifest.json`);

    writeFileSync(dbPath, 'existing database');
    assert.throws(() => assertFreshCorpusTarget(dbPath), /refusing to reuse existing corpus files/);
    rmSync(dbPath);

    writeFileSync(`${dbPath}.manifest.json`, '{}');
    assert.throws(() => assertFreshCorpusTarget(dbPath), /refusing to reuse existing corpus files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
