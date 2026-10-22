import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient, LlmError } from '../src/llm.ts';

async function drainBody(req: http.IncomingMessage): Promise<void> {
  for await (const _ of req) {
    // consume request body so the client gets a response
  }
}

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
          server.close();
          (server as any).closeAllConnections?.();
        },
      });
    });
  });
}

test('Ollama streaming chat accumulates content, model and token counts', async () => {
  const { baseUrl, close } = await withServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(
      JSON.stringify({
        model: 'test-model',
        message: { role: 'assistant', content: 'Hello ' },
        done: false,
      }) + '\n',
    );
    res.write(
      JSON.stringify({
        model: 'test-model',
        message: { role: 'assistant', content: 'world' },
        done: false,
      }) + '\n',
    );
    res.write(
      JSON.stringify({
        model: 'test-model',
        message: { role: 'assistant', content: '' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 2,
      }) + '\n',
    );
    res.end();
  });
  try {
    const client = createClient({ provider: 'ollama', baseUrl, model: 'test-model', timeoutMs: 5000 });
    const response = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.text, 'Hello world');
    assert.equal(response.model, 'test-model');
    assert.equal(response.provider, 'ollama');
    assert.equal(response.usage?.promptTokens, 10);
    assert.equal(response.usage?.completionTokens, 2);
    assert.ok(response.durationMs >= 0);
  } finally {
    close();
  }
});

test('Ollama streaming chat surfaces Ollama error objects', async () => {
  const { baseUrl, close } = await withServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ error: 'model not found' }) + '\n');
  });
  try {
    const client = createClient({ provider: 'ollama', baseUrl, model: 'test-model', timeoutMs: 5000 });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) => err instanceof LlmError && (err as LlmError).message.includes('Ollama error: model not found'),
    );
  } finally {
    close();
  }
});

test('Ollama streaming chat rejects malformed NDJSON lines', async () => {
  const { baseUrl, close } = await withServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('this is not json\n');
    res.end();
  });
  try {
    const client = createClient({ provider: 'ollama', baseUrl, model: 'test-model', timeoutMs: 5000 });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) =>
        err instanceof LlmError && (err as LlmError).message.includes('Malformed Ollama response line'),
    );
  } finally {
    close();
  }
});

test('Ollama streaming chat rejects incomplete streams', async () => {
  const { baseUrl, close } = await withServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n');
    res.end();
  });
  try {
    const client = createClient({ provider: 'ollama', baseUrl, model: 'test-model', timeoutMs: 5000 });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) =>
        err instanceof LlmError &&
        (err as LlmError).message.includes('Ollama response stream ended without completion marker'),
    );
  } finally {
    close();
  }
});

test('Ollama streaming chat rejects non-2xx responses', async () => {
  const { baseUrl, close } = await withServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal' }));
  });
  try {
    const client = createClient({ provider: 'ollama', baseUrl, model: 'test-model', timeoutMs: 5000 });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) =>
        err instanceof LlmError && (err as LlmError).message.includes('LLM request failed (500)'),
    );
  } finally {
    close();
  }
});

test('Ollama streaming chat times out and releases reader during slow streams', async () => {
  const { baseUrl, close } = await withServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'start' }, done: false }) + '\n');
    setTimeout(() => {
      try {
        res.end();
      } catch {
        // connection may already be closed by client abort
      }
    }, 200);
  });
  try {
    const client = createClient({ provider: 'ollama', baseUrl, model: 'test-model', timeoutMs: 50 });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) =>
        err instanceof LlmError && (err as LlmError).message.includes('LLM request timed out after 50ms'),
    );
  } finally {
    close();
  }
});

test('Ollama availability reports false when the server is unreachable', async () => {
  const client = createClient({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:0',
    model: 'test-model',
    timeoutMs: 100,
  });
  const ok = await client.available();
  assert.equal(ok, false);
});
