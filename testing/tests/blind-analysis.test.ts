import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore, type ScenarioResult } from '../scripts/benchmark/harness.ts';
import { analyzeRatings } from '../scripts/evaluate-blind.ts';

const HEADER = 'passage,prose,voice,dialogue,pacing,emotion,originality,outline,canon,knowledge,repetition';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `fanfable-${name}-`));
}

function fixture(root: string, runId: string, ratings: string[]): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'key.json'),
    JSON.stringify({
      runId,
      role: 'writing',
      seed: 7,
      entries: [
        { code: 'A', model: 'alpha' },
        { code: 'B', model: 'beta' },
        { code: 'C', model: 'gamma' },
      ],
    }),
  );
  writeFileSync(join(dir, 'ratings.csv'), [HEADER, ...ratings].join('\n') + '\n');
  return dir;
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
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
    metrics: { words: 3, target: 3, repetition: 0, inventedNames: 0 },
    artefact,
    calls: [],
    durationMs: 1,
    promptTokens: 1,
    completionTokens: 1,
  };
}

test('blank cells are N/A and are excluded from the mean', () => {
  const root = tempDir('blank');
  try {
    const dir = fixture(root, 'run-blank', ['A,4,,,,,,,,,', 'B,2,,,,,,,,,']);
    writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nA\n\n## Passage B\n\nB\n');
    const out = capture(() => analyzeRatings('run-blank', root));
    assert.match(out, /\| alpha \| 4\.0 \(1\) \| n\/a \(0\) \|/);
    assert.match(out, /\| beta \| 2\.0 \(1\) \| n\/a \(0\) \|/);
    assert.match(out, /4\.00 \(1\)/);
    assert.doesNotMatch(out, /2\.0 \(2\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an all-blank form reports no scores and presents no result', () => {
  const root = tempDir('allblank');
  try {
    const dir = fixture(root, 'run-allblank', ['A,,,,,,,,,,', 'B,,,,,,,,,,', 'C,,,,,,,,,,']);
    writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nA\n\n## Passage B\n\nB\n\n## Passage C\n\nC\n');
    // This invalid key proves the all-blank guard runs before key parsing.
    writeFileSync(join(dir, 'key.json'), 'not a key');
    const out = capture(() => analyzeRatings('run-allblank', root));
    assert.match(out, /No scores in ratings\.csv for run "run-allblank"; nothing to analyze\./);
    assert.doesNotMatch(out, /\| model \|/);
    assert.doesNotMatch(out, /writing mean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new blind runs do not unblind until the AI sheet has scores too', () => {
  const root = tempDir('ai-unlocked');
  try {
    const dir = fixture(root, 'run-ai-unlocked', ['A,4,,,,,,,,,']);
    writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nA\n');
    writeFileSync(join(dir, 'ai-ratings.csv'), `${HEADER}\nA,,,,,,,,,,\n`);
    writeFileSync(join(dir, 'key.json'), 'not a key');

    assert.throws(
      () => analyzeRatings('run-ai-unlocked', root),
      /ai-ratings\.csv.*has no scores.*before unblinding/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('valid ratings average only the values that were given', () => {
  const root = tempDir('valid');
  try {
    const dir = fixture(root, 'run-valid', [
      'A,4,2,,,,,,,,',
      'B,5,,,,,,,,,',
      'C,3,4,,,,,,,,',
    ]);
    writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nA\n\n## Passage B\n\nB\n\n## Passage C\n\nC\n');
    const out = capture(() => analyzeRatings('run-valid', root));
    assert.match(out, /\| alpha \| 4\.0 \(1\) \| 2\.0 \(1\) .* \| 3\.00 \(2\) \| 3\.00 \(2\) \|/);
    assert.match(out, /\| beta \| 5\.0 \(1\) \| n\/a \(0\) .* \| 5\.00 \(1\) \| 5\.00 \(1\) \|/);
    assert.match(out, /\| gamma \| 3\.0 \(1\) \| 4\.0 \(1\) .* \| 3\.50 \(2\) \| 3\.50 \(2\) \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonblank ratings outside 1-5 are rejected', () => {
  const root = tempDir('range');
  try {
    for (const bad of ['0', '6', 'x', '-1']) {
      const id = `run-${bad.replace(/\W/g, '')}`;
      const dir = fixture(root, id, [`A,${bad},,,,,,,,,`]);
      writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nA\n');
      assert.throws(
        () => analyzeRatings(id, root),
        /invalid rating/,
        `expected "${bad}" to be rejected`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet-generation CLI output names no model or passage mapping', () => {
  const runs = tempDir('cli-runs');
  const blind = tempDir('cli-blind');
  try {
    const store = new RunStore('trial-cli', { models: ['alpha', 'beta'], roles: ['writing'], corpus: 'c.db' }, runs);
    store.save(result('alpha', 'The hall was quiet and the candles burned low.'));
    store.save(result('beta', 'The hall was loud and the candles burned high.'));
    store.finish();

    const script = fileURLToPath(new URL('../scripts/evaluate-blind.ts', import.meta.url));
    const stdout = execFileSync(process.execPath, ['--no-warnings', script, 'trial-cli', '--out', blind], {
      encoding: 'utf8',
      env: { ...process.env, FANFABLE_RUNS_DIR: runs },
    });

    assert.doesNotMatch(stdout, /alpha|beta/i);
    assert.doesNotMatch(stdout, /passage [A-Z]\s*:/);
    assert.doesNotMatch(stdout, /key\.json/i);
    assert.match(stdout, /ratings\.csv/);
    assert.match(stdout, /only ai-rater-input\.md/);
    assert.match(stdout, /when both rating sets are final/i);
    assert.match(stdout, /node testing\/scripts\/evaluate-blind\.ts trial-cli --analyze/);

    const packet = readFileSync(join(blind, 'trial-cli', 'packet.md'), 'utf8');
    const aiInput = readFileSync(join(blind, 'trial-cli', 'ai-rater-input.md'), 'utf8');
    assert.doesNotMatch(packet, /alpha|beta|trial-cli/i);
    assert.doesNotMatch(aiInput, /alpha|beta|trial-cli/i);
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});
