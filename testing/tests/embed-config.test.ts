import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEmbedConfig } from '../../fanfable/src/embeddings.ts';
import type { Db } from '../../fanfable/src/core/db.ts';
import { saveGlobalConfig } from '../../fanfable/src/core/llm.ts';

/** resolveEmbedConfig only reads one settings blob. */
function fakeDb(settings: Record<string, unknown>): Db {
  return {
    get: () => ({ settings: JSON.stringify(settings) }),
  } as unknown as Db;
}

/** Keep the user's real global config out of the test. */
function withConfigDir<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-embed-'));
  const saved = process.env.FANFABLE_CONFIG_DIR;
  process.env.FANFABLE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.FANFABLE_CONFIG_DIR;
    else process.env.FANFABLE_CONFIG_DIR = saved;
  }
}

test('a local embeddingBaseUrl wins over a cloud chat baseUrl', () => {
  withConfigDir(() => {
    const db = fakeDb({
      provider: 'openai',
      baseUrl: 'https://openrouter.ai/api',
      embeddingBaseUrl: 'http://127.0.0.1:11434',
    });
    assert.equal(resolveEmbedConfig(db, 1).baseUrl, 'http://127.0.0.1:11434');
  });
});

test('embeddingBaseUrl set in the global config is used when the project has none', () => {
  withConfigDir(() => {
    saveGlobalConfig({ embeddingBaseUrl: 'http://127.0.0.1:11500' });
    const db = fakeDb({ baseUrl: 'https://openrouter.ai/api' });
    assert.equal(resolveEmbedConfig(db, 1).baseUrl, 'http://127.0.0.1:11500');
  });
});

test('without an embeddingBaseUrl the project baseUrl still serves the embedder', () => {
  withConfigDir(() => {
    const db = fakeDb({ baseUrl: 'http://127.0.0.1:11434' });
    assert.equal(resolveEmbedConfig(db, 1).baseUrl, 'http://127.0.0.1:11434');
  });
});

test('nothing configured falls back to the local Ollama default', () => {
  withConfigDir(() => {
    assert.equal(resolveEmbedConfig(fakeDb({}), 1).baseUrl, 'http://127.0.0.1:11434');
  });
});

test('an explicit baseUrl override still beats every setting', () => {
  withConfigDir(() => {
    const db = fakeDb({ embeddingBaseUrl: 'http://127.0.0.1:11434' });
    assert.equal(resolveEmbedConfig(db, 1, { baseUrl: 'http://127.0.0.1:9999' }).baseUrl, 'http://127.0.0.1:9999');
  });
});
