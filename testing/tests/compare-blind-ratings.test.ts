import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBlindRatings } from '../scripts/compare-blind-ratings.ts';

const HEADER = 'passage,prose,voice,dialogue,pacing,emotion,originality,outline,canon,knowledge,repetition';

function setup(humanRows: string[], aiRows: string[]): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'fanfable-rater-compare-'));
  const dir = join(root, 'trial');
  mkdirSync(dir);
  writeFileSync(join(dir, 'packet.md'), '# Blind\n\n## Passage A\n\nText A\n\n## Passage B\n\nText B\n');
  writeFileSync(join(dir, 'ratings.csv'), [HEADER, ...humanRows].join('\n') + '\n');
  writeFileSync(join(dir, 'ai-ratings.csv'), [HEADER, ...aiRows].join('\n') + '\n');
  return { root, dir };
}

test('comparison uses paired nonblank scores and reports N/A counts', () => {
  const { root } = setup(
    ['A,5,4,,,,,,,,', 'B,2,3,,,,,,,,'],
    ['A,4,4,,,,,,,,', 'B,,,,,,,,,,'],
  );
  try {
    const result = compareBlindRatings('trial', root);
    assert.equal(result.overall.pairedN, 2);
    assert.equal(result.overall.exactN, 1);
    assert.equal(result.overall.withinOneN, 2);
    assert.equal(result.overall.meanAbsoluteDifference, 0.5);
    assert.deepEqual(result.byCriterion.prose, {
      humanN: 2,
      aiN: 1,
      pairedN: 1,
      exactN: 0,
      withinOneN: 1,
      meanAbsoluteDifference: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('comparison rejects incomplete passage grids and invalid ratings', () => {
  const { root, dir } = setup(['A,5,4,,,,,,,,'], ['A,5,4,,,,,,,,', 'B,2,3,,,,,,,,']);
  try {
    assert.throws(() => compareBlindRatings('trial', root), /missing passage rows/);
    writeFileSync(join(dir, 'ratings.csv'), [HEADER, 'A,6,4,,,,,,,,', 'B,2,3,,,,,,,,'].join('\n'));
    assert.throws(() => compareBlindRatings('trial', root), /invalid score/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
