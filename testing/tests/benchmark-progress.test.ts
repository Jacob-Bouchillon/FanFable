import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../scripts/benchmark/harness.ts';
import {
  countRatingCells,
  estimateEta,
  parseOllamaPs,
  ProgressStore,
  progressPath,
  readProgress,
} from '../scripts/benchmark/progress.ts';
import { OllamaPsSampler, renderWatch } from '../scripts/benchmark/watch.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `fanfable-progress-${name}-`));
}

function ratingHeader(): string {
  return 'passage,prose,voice,dialogue,pacing,emotion,originality,outline,canon,knowledge,repetition';
}

test('stage updates keep counts and append events without overwriting history', () => {
  const root = tempDir('stages');
  try {
    const store = ProgressStore.open('trial-progress', { root });
    store.startStage('corpus-source', { total: 2, unit: 'projects', detail: 'importing source' });
    store.advance('corpus-source');
    store.completeStage('corpus-source', 'source imported');

    store.startStage('extract-qwen', { unit: 'windows' });
    store.setCounts('extract-qwen', {
      completed: 86,
      total: 212,
      detail: 'lore 86/149 windows; canon events 0/63 windows',
    });

    const state = readProgress('trial-progress', root)!;
    const source = state.stages.find((stage) => stage.key === 'corpus-source')!;
    const extraction = state.stages.find((stage) => stage.key === 'extract-qwen')!;
    assert.equal(source.status, 'done');
    assert.equal(source.completed, source.total);
    assert.equal(extraction.status, 'running');
    assert.equal(extraction.completed, 86);
    assert.equal(extraction.total, 212);
    assert.equal(state.currentStage, 'extract-qwen');

    const eventsPath = join(root, 'trial-progress', 'progress.jsonl');
    const before = readFileSync(eventsPath, 'utf8').trim().split('\n');
    for (const line of before) {
      const event = JSON.parse(line) as Record<string, unknown>;
      assert.ok(event.at);
      assert.ok(event.type);
      assert.equal('prompt' in event, false);
      assert.equal('artefact' in event, false);
      assert.equal('prose' in event, false);
    }

    ProgressStore.open('trial-progress', { root }).advance('extract-qwen');
    const after = readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(readProgress('trial-progress', root)!.stages.find((s) => s.key === 'extract-qwen')!.completed, 87);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ETA appears only after enough measured progress', () => {
  const root = tempDir('eta');
  try {
    const base = Date.parse('2026-01-02T03:04:05.000Z');
    const clock = { at: base };
    const store = ProgressStore.open('trial-eta', { root, now: () => new Date(clock.at) });
    store.startStage('extract-qwen', { total: 10, unit: 'windows' });

    clock.at = base + 5_000;
    store.setCounts('extract-qwen', { completed: 5, total: 10 });
    assert.equal(estimateEta(store.current, clock.at), null, 'too little elapsed time');

    clock.at = base + 20_000;
    store.setCounts('extract-qwen', { completed: 5, total: 10 });
    const eta = estimateEta(store.current, clock.at);
    assert.ok(eta);
    assert.equal(eta.completed, 5);
    assert.equal(eta.total, 10);
    assert.ok(Math.abs(eta.seconds - 20) < 0.01);

    store.setCounts('extract-qwen', { completed: 1, total: 10 });
    assert.equal(estimateEta(store.current, clock.at), null, 'too few completed items');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing and failed progress states are reported instead of crashing', () => {
  const root = tempDir('missing');
  try {
    const missing = readProgress('not-started', root);
    assert.equal(missing, null);
    const missingView = renderWatch({
      runId: 'not-started',
      state: null,
      statePath: progressPath('not-started', root),
    });
    assert.match(missingView, /No progress state yet/);
    assert.match(missingView, /Waiting for the experiment to start/);

    const store = ProgressStore.open('trial-failed', { root });
    store.startStage('extract-qwen', { total: 149, unit: 'windows' });
    store.failStage('extract-qwen', 'model unavailable: connection refused');
    const state = readProgress('trial-failed', root)!;
    assert.equal(state.status, 'failed');
    assert.equal(state.errors.length, 1);

    const failedView = renderWatch({ runId: 'trial-failed', state, statePath: progressPath('trial-failed', root) });
    assert.match(failedView, /failed/);
    assert.match(failedView, /model unavailable/);
    assert.match(failedView, /Errors:/);

    const unreadableView = renderWatch({
      runId: 'trial-failed',
      state: null,
      statePath: progressPath('trial-failed', root),
      error: 'cannot parse progress state',
    });
    assert.match(unreadableView, /progress unreadable/);
    assert.match(unreadableView, /cannot parse progress state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rating progress counts nonblank cells and never reads the answer key', () => {
  const blind = tempDir('ratings');
  const stateRoot = tempDir('ratings-state');
  try {
    writeFileSync(
      join(blind, 'packet.md'),
      ['## Passage A', '', 'body a', '', '---', '', '## Passage B', '', 'body b'].join('\n'),
    );
    writeFileSync(
      join(blind, 'ratings.csv'),
      [
        ratingHeader(),
        'A,4,,5,,3,,,2,,',
        'B,,,,,,,4,,,5',
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(blind, 'ai-ratings.csv'),
      [
        ratingHeader(),
        'A,4,4,5,3,3,4,4,2,4,5',
        'B,3,4,4,4,3,3,4,4,4,5',
      ].join('\n') + '\n',
    );
    // A directory where a key file would be: any attempt to read it throws.
    mkdirSync(join(blind, 'key.json'));

    const counts = countRatingCells(blind);
    assert.equal(counts.human.completed, 6);
    assert.equal(counts.human.total, 20);
    assert.equal(counts.human.status, 'waiting');
    assert.equal(counts.ai.completed, 20);
    assert.equal(counts.ai.total, 20);
    assert.equal(counts.ai.status, 'done');

    const view = renderWatch({
      runId: 'ratings-trial',
      state: ProgressStore.open('ratings-trial', { root: stateRoot }).current,
      statePath: 'unused',
      ratings: counts,
    });
    assert.match(view, /6\/20 cells/);
    assert.match(view, /20\/20 cells/);
  } finally {
    rmSync(blind, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('ollama ps is parsed as processor placement and sampled at an interval', () => {
  const output = [
    'NAME                    ID              SIZE      PROCESSOR        UNTIL',
    'qwen2.5:7b              845dbda0ea48    4.7 GB    100% GPU         4 minutes from now',
    'gemma4:12b-it-q4_K_M    6114515d63c1    8.0 GB    48%/52% CPU/GPU  2 minutes from now',
  ].join('\n');
  assert.deepEqual(parseOllamaPs(output), [
    { name: 'qwen2.5:7b', processor: '100% GPU' },
    { name: 'gemma4:12b-it-q4_K_M', processor: '48%/52% CPU/GPU' },
  ]);

  let now = 0;
  let calls = 0;
  const sampler = new OllamaPsSampler(
    15_000,
    () => now,
    () => {
      calls++;
      return output;
    },
  );
  const first = sampler.maybeSample();
  assert.equal(first.sampled, true);
  assert.equal(first.processes[0]?.processor, '100% GPU');

  now = 1_000;
  assert.equal(sampler.maybeSample().sampled, false);
  assert.equal(calls, 1, 'cached between samples');

  now = 16_000;
  assert.equal(sampler.maybeSample().sampled, true);
  assert.equal(calls, 2);
});

test('a progress-only run directory can be adopted without weakening run protection', () => {
  const root = tempDir('adopt');
  try {
    ProgressStore.open('future-run', { root });
    const store = new RunStore(
      'future-run',
      { models: ['gemma4:12b-it-q4_K_M'], roles: ['writing'], corpus: 'corpus.db' },
      root,
    );
    store.finish();
    assert.equal(readProgress('future-run', root)!.runId, 'future-run');
    assert.ok(readFileSync(join(root, 'future-run', 'run.json'), 'utf8').includes('future-run'));

    mkdirSync(join(root, 'occupied'));
    writeFileSync(join(root, 'occupied', 'notes.txt'), 'not a progress file');
    assert.throws(
      () => new RunStore('occupied', { models: [], roles: [], corpus: 'c.db' }, root),
      /already exists/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
