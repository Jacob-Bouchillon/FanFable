/** Cloud credentials never go local, never print whole, config is owner-only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authHeadersFor, createClient, isLocalEndpoint, saveGlobalConfig } from '../../fanfable/src/llm.ts';
import { maskSettingsForOutput } from '../../fanfable/src/server.ts';

const KEY = 'sk-test-SECRET-key';
const LOCAL = [
  'http://localhost:11434',
  'http://127.0.0.1:11434',
  'http://127.4.5.6:11434',
  'http://[::1]:11434',
  'http://0.0.0.0:11434',
  'http://LOCALHOST:11434',
  'http://localhost.:11434',
  'http://foo.localhost:1234',
  'http://host.docker.internal:11434',
  'http://user:pass@localhost:11434',
];

test('loopback endpoints withhold the key and remote ones send it', () => {
  for (const url of LOCAL) {
    assert.equal(isLocalEndpoint(url), true, url);
    assert.deepEqual(authHeadersFor(url, KEY), {}, url);
  }
  for (const url of ['https://openrouter.ai/api', 'https://example.com/v1', 'https://user:pass@example.com/v1']) {
    assert.equal(isLocalEndpoint(url), false, url);
    assert.deepEqual(authHeadersFor(url, KEY), { authorization: `Bearer ${KEY}` }, url);
  }
  assert.equal(isLocalEndpoint('not a url'), true);
  assert.deepEqual(authHeadersFor('not a url', KEY), {});
  assert.deepEqual(authHeadersFor('https://example.com/v1', undefined), {});
});

test('config files are owner-only after create and update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-config-'));
  const previous = process.env.FANFABLE_CONFIG_DIR;
  process.env.FANFABLE_CONFIG_DIR = dir;
  try {
    saveGlobalConfig({ model: 'first', apiKey: KEY });
    const file = join(dir, 'config.json');
    // Windows has no POSIX mode bits: chmod is a no-op there, and the profile
    // directory's ACLs are what keep the file private. The create/update path
    // still has to work, so assert that on both platforms.
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'new file is 0600');
      assert.equal(statSync(dir).mode & 0o777, 0o700, 'config dir is 0700');
    }
    saveGlobalConfig({ model: 'second' });
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'updated file stays 0600');
    }
  } finally {
    if (previous === undefined) delete process.env.FANFABLE_CONFIG_DIR;
    else process.env.FANFABLE_CONFIG_DIR = previous;
  }
});

test('a failing request never puts the key in the error message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error(`network failure with ${KEY}`);
  }) as typeof fetch;
  try {
    const client = createClient({
      provider: 'openai',
      baseUrl: 'https://example.com/v1',
      model: 'm',
      apiKey: KEY,
      timeoutMs: 1000,
    });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }),
      (error: Error) => !error.message.includes(KEY),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a remote request actually carries the bearer header', async () => {
  const original = globalThis.fetch;
  let seen: string | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers).get('authorization') ?? undefined;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = createClient({
      provider: 'openai',
      baseUrl: 'https://example.com/v1',
      model: 'm',
      apiKey: KEY,
      timeoutMs: 1000,
    });
    const response = await client.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
    assert.equal(response.text, 'ok');
    assert.equal(seen, `Bearer ${KEY}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('settings returned to the UI mask the key', () => {
  const masked = maskSettingsForOutput({ model: 'm', apiKey: KEY });
  assert.notEqual(masked.apiKey, KEY);
  assert.match(String(masked.apiKey), /^sk-tes…/);
  assert.equal(masked.model, 'm');
});
