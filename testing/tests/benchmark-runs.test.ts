import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repetitionSeed, runId, uniqueRunId, RunStore, type ScenarioResult } from '../scripts/benchmark/harness.ts';
import { buildPacket, buildPairedPacket, analyzeRatings } from '../scripts/evaluate-blind.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `fanfable-${name}-`));
}

function result(model: string, artefact: string): ScenarioResult {
  return {
    role: 'writing',
    scenario: 'chapter-1',
    model,
    modelLabel: model,
    seed: 42,
    repetition: 0,
    ok: true,
    metrics: { words: artefact.split(/\s+/).length, target: 100, repetition: 0, inventedNames: 0 },
    artefact,
    calls: [],
    durationMs: 1,
    promptTokens: 1,
    completionTokens: 1,
  };
}

function pairedResult(model: string, seed: number, prompt: string, artefact: string): ScenarioResult {
  const out = result(model, artefact);
  out.seed = seed;
  out.repetition = seed - 42;
  out.calls = [{ system: 'shared system', prompt, output: 'draft', durationMs: 1 }];
  return out;
}

test('run ids differ even for the same timestamp and keep their prefix', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5, 678);
  const a = runId('trial', at);
  const b = runId('trial', at);
  assert.notEqual(a, b);
  assert.match(a, /^trial-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}$/);
  assert.match(b, /^trial-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}$/);
});

test('repetitions use a reproducible seed schedule without reusing the seed', () => {
  assert.equal(repetitionSeed(42, 0), 42);
  assert.equal(repetitionSeed(42, 1), 43);
  assert.equal(repetitionSeed(42, 2), 44);
  assert.equal(repetitionSeed(undefined, 0), undefined);
  assert.throws(() => repetitionSeed(42, -1), /non-negative integer/);
});

test('uniqueRunId skips ids already present on disk', () => {
  const base = tempDir('ids');
  try {
    const first = uniqueRunId('trial', base);
    mkdirSync(join(base, first));
    const second = uniqueRunId('trial', base);
    assert.notEqual(first, second);
    assert.ok(!existsSync(join(base, second)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('RunStore refuses to reuse an existing run id and leaves its files alone', () => {
  const base = tempDir('runs');
  try {
    const store = new RunStore('trial-1', { models: ['m1'], roles: ['writing'], corpus: 'c.db' }, base);
    store.save(result('m1', 'chapter text'));
    store.finish();
    const before = readFileSync(join(base, 'trial-1', 'run.json'), 'utf8');
    assert.throws(
      () => new RunStore('trial-1', { models: ['m2'], roles: ['writing'], corpus: 'other.db' }, base),
      /already exists/,
    );
    assert.equal(readFileSync(join(base, 'trial-1', 'run.json'), 'utf8'), before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('run metadata preserves structured provenance details', () => {
  const base = tempDir('provenance');
  try {
    const details = {
      baselineModel: 'qwen2.5:7b',
      sourceTextSha256: ['source-hash'],
      modelSettings: [{ key: 'writer-a', seed: 42 }],
    };
    const store = new RunStore(
      'trial-provenance',
      { models: ['writer-a'], roles: ['writing'], corpus: 'corpus.db', details },
      base,
    );
    store.finish();

    const loaded = RunStore.load('trial-provenance', base);
    assert.deepEqual(loaded.meta.details, details);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('RunStore refuses to overwrite a recorded result in the same run', () => {
  const base = tempDir('dupes');
  try {
    const store = new RunStore('trial-2', { models: ['m1'], roles: ['writing'], corpus: 'c.db' }, base);
    store.save(result('m1', 'first'));
    assert.throws(() => store.save(result('m1', 'second')), /already recorded/);
    const saved = JSON.parse(
      readFileSync(join(base, 'trial-2', 'writing', 'm1__seed42__rep0.json'), 'utf8'),
    ) as ScenarioResult;
    assert.equal(saved.artefact, 'first');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loading an unknown run fails instead of returning empty metadata', () => {
  const base = tempDir('missing');
  try {
    assert.throws(() => RunStore.load('not-a-run', base), /no run "not-a-run"/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a blind packet is written once and keeps model details out of rater files', () => {
  const runs = tempDir('packet-runs');
  const blind = tempDir('packet-blind');
  try {
    const store = new RunStore('trial-3', { models: ['alpha', 'beta'], roles: ['writing'], corpus: 'c.db' }, runs);
    store.save(result('alpha', 'Alpha writes about the hall.'));
    store.save(result('beta', 'Beta writes about the hall too.'));
    store.finish();

    const first = buildPacket('trial-3', blind, 'writing', 7, runs);
    assert.equal(first.dir, join(blind, 'trial-3'));
    const packet = readFileSync(join(first.dir, 'packet.md'), 'utf8');
    const brief = readFileSync(join(first.dir, 'brief.md'), 'utf8');
    const csv = readFileSync(join(first.dir, 'ratings.csv'), 'utf8');
    const aiCsv = readFileSync(join(first.dir, 'ai-ratings.csv'), 'utf8');
    const aiInput = readFileSync(join(first.dir, 'ai-rater-input.md'), 'utf8');
    for (const text of [packet, brief, csv, aiCsv, aiInput]) {
      assert.ok(!text.includes('trial-3'), 'rater files must not name the run');
      assert.ok(!text.includes('alpha'));
      assert.ok(!text.includes('beta'));
    }
    assert.equal(aiCsv, csv, 'human and AI ratings have separate but matching forms');
    assert.match(aiInput, /Return only CSV/);
    assert.match(aiInput, /Freedom from repetition/);
    assert.equal(first.entries.length, 2);
    assert.match(packet, /^# Blind chapter rating/);
    assert.doesNotMatch(packet, /Run: /);

    assert.throws(() => buildPacket('trial-3', blind, 'writing', 7, runs), /already exists/);
    assert.equal(readFileSync(join(first.dir, 'ratings.csv'), 'utf8'), csv);
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});

test('blind packet generation refuses writing samples with different initial prompts', () => {
  const runs = tempDir('prompt-runs');
  const blind = tempDir('prompt-blind');
  try {
    const store = new RunStore('trial-prompts', { models: ['alpha', 'beta'], roles: ['writing'], corpus: 'c.db' }, runs);
    const alpha = result('alpha', 'Alpha chapter.');
    alpha.calls = [{ system: 'shared system', prompt: 'context A', output: 'draft A', durationMs: 1 }];
    const beta = result('beta', 'Beta chapter.');
    beta.calls = [{ system: 'shared system', prompt: 'context B', output: 'draft B', durationMs: 1 }];
    store.save(alpha);
    store.save(beta);
    store.finish();

    assert.throws(
      () => buildPacket('trial-prompts', blind, 'writing', 7, runs),
      /did not receive the same initial prompt/,
    );
    assert.ok(!existsSync(join(blind, 'trial-prompts')));
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});

test('analysis names its run and refuses to guess', () => {
  const blind = tempDir('analysis');
  try {
    const dir = join(blind, 'trial-4');
    mkdirSync(dir);
    writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nA\n');
    writeFileSync(join(dir, 'key.json'), JSON.stringify({ runId: 'trial-4', entries: [{ code: 'A', model: 'alpha' }] }));
    writeFileSync(
      join(dir, 'ratings.csv'),
      'passage,prose,voice,dialogue,pacing,emotion,originality,outline,canon,knowledge,repetition\nA,4,3,5,4,4,3,4,5,4,5\n',
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      analyzeRatings('trial-4', blind);
    } finally {
      console.log = original;
    }
    const out = lines.join('\n');
    assert.match(out, /Blind human ratings — trial-4/);
    assert.match(out, /\| alpha \|/);

    assert.throws(() => analyzeRatings('trial-5', blind), /cannot analyze run "trial-5": missing/);

    mkdirSync(join(blind, 'other'));
    writeFileSync(join(blind, 'other', 'packet.md'), '# Blind\n\n## Passage A\n\nA\n');
    writeFileSync(join(blind, 'other', 'key.json'), JSON.stringify({ runId: 'trial-4', entries: [] }));
    writeFileSync(
      join(blind, 'other', 'ratings.csv'),
      'passage,prose,voice,dialogue,pacing,emotion,originality,outline,canon,knowledge,repetition\nA,4,3,5,4,4,3,4,5,4,5\n',
    );
    assert.throws(() => analyzeRatings('other', blind), /belong to run "trial-4", not "other"/);
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
});

test('paired packet allows one prompt per arm and records the arm for every passage', () => {
  const runs = tempDir('paired-runs');
  const blind = tempDir('paired-blind');
  try {
    const qwen = new RunStore('pair-qwen', { models: ['gemma-writer'], roles: ['writing'], corpus: 'qwen.db' }, runs);
    const gemma = new RunStore('pair-gemma', { models: ['gemma-writer'], roles: ['writing'], corpus: 'gemma.db' }, runs);
    for (const seed of [42, 43, 44]) {
      qwen.save(pairedResult('gemma-writer', seed, 'QWEN CORPUS CONTEXT', `First arm sample ${seed}.`));
      gemma.save(pairedResult('gemma-writer', seed, 'GEMMA CORPUS CONTEXT', `Second arm sample ${seed}.`));
    }
    qwen.finish();
    gemma.finish();

    const { dir, entries } = buildPairedPacket('pair-qwen', 'pair-gemma', 'paired-01', blind, 'writing', 7, runs);
    assert.equal(dir, join(blind, 'paired-01'));
    assert.equal(entries.length, 6);
    assert.equal(new Set(entries.map((e) => e.code)).size, 6);
    assert.equal(entries.filter((e) => e.arm === 'qwen').length, 3);
    assert.equal(entries.filter((e) => e.arm === 'gemma').length, 3);

    const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as {
      pairedId: string;
      arms: Record<string, string>;
      entries: { code: string; arm: string; model: string; seed: number }[];
    };
    assert.equal(key.pairedId, 'paired-01');
    assert.deepEqual(key.arms, { qwen: 'pair-qwen', gemma: 'pair-gemma' });
    assert.equal(key.entries.length, 6);
    const byCode = new Map(entries.map((entry) => [entry.code, entry]));
    for (const row of key.entries) {
      assert.equal(row.arm, byCode.get(row.code)!.arm, 'key and packet agree on the arm');
      assert.equal(row.model, 'gemma-writer');
    }
    assert.deepEqual(
      key.entries.map((e) => `${e.arm}:${e.seed}`).sort(),
      ['gemma:42', 'gemma:43', 'gemma:44', 'qwen:42', 'qwen:43', 'qwen:44'],
    );

    const packet = readFileSync(join(dir, 'packet.md'), 'utf8');
    assert.equal([...packet.matchAll(/^## Passage [A-Z]+\s*$/gm)].length, 6);
    for (const leak of ['paired-01', 'pair-qwen', 'pair-gemma', 'qwen', 'gemma']) {
      assert.ok(!packet.toLowerCase().includes(leak.toLowerCase()), `packet must not contain "${leak}"`);
    }
    for (const entry of entries) assert.ok(packet.includes(entry.body));

    const csv = readFileSync(join(dir, 'ratings.csv'), 'utf8');
    const lines = csv.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'passage,prose,voice,dialogue,pacing,emotion,originality,outline,canon,knowledge,repetition',
    );
    assert.equal(lines.length, 7);
    for (const line of lines.slice(1)) assert.equal(line.split(',').length, 11);
    assert.equal(readFileSync(join(dir, 'ai-ratings.csv'), 'utf8'), csv);

    const before = readFileSync(join(dir, 'ratings.csv'), 'utf8');
    assert.throws(
      () => buildPairedPacket('pair-qwen', 'pair-gemma', 'paired-01', blind, 'writing', 7, runs),
      /already exists/,
    );
    assert.equal(readFileSync(join(dir, 'ratings.csv'), 'utf8'), before);
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});

test('paired packet rejects a third prompt signature instead of merging groups', () => {
  const runs = tempDir('paired-prompts');
  const blind = tempDir('paired-prompts-blind');
  try {
    const qwen = new RunStore('pair-prompt-qwen', { models: ['gemma-writer'], roles: ['writing'], corpus: 'q.db' }, runs);
    const gemma = new RunStore('pair-prompt-gemma', { models: ['gemma-writer'], roles: ['writing'], corpus: 'g.db' }, runs);
    for (const seed of [42, 43, 44]) {
      qwen.save(pairedResult('gemma-writer', seed, 'QWEN CONTEXT', `Qwen sample ${seed}.`));
    }
    gemma.save(pairedResult('gemma-writer', 42, 'GEMMA CONTEXT A', 'Gemma sample 42.'));
    gemma.save(pairedResult('gemma-writer', 43, 'GEMMA CONTEXT B', 'Gemma sample 43.'));
    gemma.save(pairedResult('gemma-writer', 44, 'GEMMA CONTEXT B', 'Gemma sample 44.'));
    qwen.finish();
    gemma.finish();

    assert.throws(
      () => buildPairedPacket('pair-prompt-qwen', 'pair-prompt-gemma', 'paired-3-prompts', blind, 'writing', 7, runs),
      /did not receive the same initial prompt/,
    );
    assert.ok(!existsSync(join(blind, 'paired-3-prompts')));
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});

test('paired packet requires three matched seeds per arm', () => {
  const runs = tempDir('paired-seeds');
  const blind = tempDir('paired-seeds-blind');
  try {
    const qwen = new RunStore('pair-seed-qwen', { models: ['gemma-writer'], roles: ['writing'], corpus: 'q.db' }, runs);
    const mismatch = new RunStore('pair-seed-mismatch', { models: ['gemma-writer'], roles: ['writing'], corpus: 'g.db' }, runs);
    const short = new RunStore('pair-seed-short', { models: ['gemma-writer'], roles: ['writing'], corpus: 'g.db' }, runs);
    for (const seed of [42, 43, 44]) {
      qwen.save(pairedResult('gemma-writer', seed, 'QWEN CONTEXT', `Qwen sample ${seed}.`));
    }
    for (const seed of [42, 43, 45]) {
      mismatch.save(pairedResult('gemma-writer', seed, 'GEMMA CONTEXT', `Gemma sample ${seed}.`));
    }
    for (const seed of [42, 43]) {
      short.save(pairedResult('gemma-writer', seed, 'GEMMA CONTEXT', `Gemma sample ${seed}.`));
    }
    qwen.finish();
    mismatch.finish();
    short.finish();

    assert.throws(
      () => buildPairedPacket('pair-seed-qwen', 'pair-seed-mismatch', 'paired-mismatch', blind, 'writing', 7, runs),
      /seeds differ between arms/,
    );
    assert.throws(
      () => buildPairedPacket('pair-seed-qwen', 'pair-seed-short', 'paired-short', blind, 'writing', 7, runs),
      /needs exactly 3 writing samples/,
    );
    assert.ok(!existsSync(join(blind, 'paired-mismatch')));
    assert.ok(!existsSync(join(blind, 'paired-short')));
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});
