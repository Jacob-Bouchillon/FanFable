/**
 * LLM access layer.
 *
 * All subsystems talk to one local model through different system prompts, so
 * the provider layer only has to deal with: "here is a system prompt, here is a
 * conversation, give me text back".
 *
 * Supported backends:
 *   ollama    -> POST {baseUrl}/api/chat              (default)
 *   llamacpp  -> POST {baseUrl}/v1/chat/completions   (llama.cpp server, OpenAI-shaped)
 *   openai    -> POST {baseUrl}/v1/chat/completions   (any compatible local gateway)
 *   mock      -> offline deterministic stub, used by the test suite
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ProviderName = 'ollama' | 'llamacpp' | 'openai' | 'mock';

export interface LlmSettings {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  /** Optional cheaper model for bulk indexing work (lore extraction). */
  extractionModel?: string;
  temperature: number;
  maxTokens: number;
  /** Extra context: characters written before a word is dropped from the prompt. */
  contextTokens: number;
  timeoutMs: number;
  /** Fixes the random seed, so the same prompt gives the same result. */
  seed?: number;
  /**
   * For models that think out loud. false asks for no thinking, but some
   * builds ignore it; 'low'/'medium'/'high' set the reasoning level, and the
   * thinking tokens otherwise come out of the same budget as the answer.
   */
  think?: boolean | 'low' | 'medium' | 'high';
  /**
   * Key for a gateway that checks one (OpenRouter and other cloud hosts).
   * Unset for local servers. When config stores none, FANFABLE_API_KEY then
   * OPENROUTER_API_KEY are used, so a key can stay out of the config file.
   */
  apiKey?: string;
  /**
   * Server used by the embedder (Ollama). Read by embeddings.ts only; set it
   * when `baseUrl` points at a cloud chat gateway, which serves no /api/embed.
   */
  embeddingBaseUrl?: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.1:8b',
  temperature: 0.8,
  maxTokens: 2048,
  // 16k rather than 8k: the planner's prompt alone is close to 6k tokens, and
  // a model that has no room left cannot finish its answer.
  contextTokens: 16384,
  timeoutMs: 600_000,
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Ask Ollama for constrained JSON output. Off by default; extraction
   *  calls opt in. Only shapes the output, never the content. */
  format?: 'json';
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: ProviderName;
  durationMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface LlmClient {
  readonly settings: LlmSettings;
  chat(req: ChatRequest): Promise<ChatResponse>;
  available(): Promise<boolean>;
}

export class LlmError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/* --------------------------------------------------------------- config file */

export function configPath(): string {
  const base = process.env.FANFABLE_CONFIG_DIR || join(homedir(), '.config', 'fanfable');
  return join(base, 'config.json');
}

export function loadGlobalConfig(): Partial<LlmSettings> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Partial<LlmSettings>;
  } catch {
    return {};
  }
}

export function saveGlobalConfig(patch: Partial<LlmSettings>): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const current = loadGlobalConfig();
  writeFileSync(p, JSON.stringify({ ...current, ...patch }, null, 2));
  // Owner-only on every write. A platform without chmod support simply keeps
  // its native permissions; the config still saves.
  try {
    chmodSync(p, 0o600);
  } catch {
    /* unsupported platform */
  }
}

export function resolveSettings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  const clean = <T extends object>(o: T): Partial<T> => {
    const out: Partial<T> = {};
    for (const [k, v] of Object.entries(o) as [keyof T, unknown][]) {
      if (v !== undefined && v !== null) out[k] = v as T[keyof T];
    }
    return out;
  };
  const merged: LlmSettings = {
    ...DEFAULT_LLM_SETTINGS,
    ...clean(loadGlobalConfig()),
    ...clean(overrides),
  };
  if (merged.apiKey === undefined) {
    const envKey = apiKeyFallback();
    if (envKey) merged.apiKey = envKey;
  }
  return merged;
}

/** Key from the environment, used only when config names none. */
function apiKeyFallback(): string | undefined {
  return process.env.FANFABLE_API_KEY || process.env.OPENROUTER_API_KEY || undefined;
}

/* ------------------------------------------------------------------ helpers */

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let msg = err.message;
  if (err.cause instanceof Error) {
    const c = err.cause as Error & { code?: string };
    msg += ` (${c.name}${c.code ? ` ${c.code}` : ''}: ${c.message})`;
  }
  return msg;
}

/**
 * True when the endpoint is this machine. Credentials never travel to a local
 * server, including the default Ollama endpoint.
 */
export function isLocalEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host.docker.internal') return true;
  if (host === '0.0.0.0') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/** Authorization header only for non-local endpoints. */
export function authHeadersFor(url: string, apiKey?: string): Record<string, string> {
  if (!apiKey || isLocalEndpoint(url)) return {};
  return { authorization: `Bearer ${apiKey}` };
}

function redactSecret(message: string, apiKey?: string): string {
  return apiKey ? message.split(apiKey).join('[redacted]') : message;
}

async function postJson(url: string, body: unknown, timeoutMs: number, apiKey?: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeadersFor(url, apiKey),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(
        redactSecret(`LLM request failed (${res.status}) ${text.slice(0, 400)}`, apiKey),
        res.status,
      );
    }
    return await res.json();
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new LlmError(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError(redactSecret(`LLM request failed: ${describeFetchError(err)}`, apiKey));
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number, apiKey?: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: Object.keys(authHeadersFor(url, apiKey)).length ? authHeadersFor(url, apiKey) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new LlmError(redactSecret(`HTTP ${res.status}`, apiKey));
    return await res.json();
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(redactSecret(`Request failed: ${describeFetchError(err)}`, apiKey));
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- providers */

class OllamaProvider implements LlmClient {
  readonly settings: LlmSettings;
  constructor(settings: LlmSettings) {
    this.settings = settings;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push(...req.messages);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let done = false;
    let text = '';
    let finalModel = this.settings.model;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    try {
      const res = await fetch(`${this.settings.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          stream: true,
          ...(req.format ? { format: req.format } : {}),
          ...(this.settings.think !== undefined ? { think: this.settings.think } : {}),
          options: {
            temperature: req.temperature ?? this.settings.temperature,
            num_predict: req.maxTokens ?? this.settings.maxTokens,
            num_ctx: this.settings.contextTokens,
            ...(this.settings.seed !== undefined ? { seed: this.settings.seed } : {}),
          },
          ...(req.stop ? { stop: req.stop } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new LlmError(`LLM request failed (${res.status}) ${errorText.slice(0, 400)}`, res.status);
      }
      reader = res.body?.getReader();
      if (!reader) throw new LlmError('LLM response has no body');
      const decoder = new TextDecoder();
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const rawLine of chunk.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          let data: any;
          try {
            data = JSON.parse(line);
          } catch (parseErr) {
            throw new LlmError(
              `Malformed Ollama response line: ${(parseErr as Error).message}: ${line.slice(0, 200)}`,
            );
          }
          if (data.error) {
            throw new LlmError(`Ollama error: ${data.error}`);
          }
          if (typeof data.message?.content === 'string') {
            text += data.message.content;
          }
          if (data.done === true) {
            finalModel = data.model ?? finalModel;
            promptTokens = data.prompt_eval_count ?? promptTokens;
            completionTokens = data.eval_count ?? completionTokens;
            done = true;
          }
        }
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new LlmError(`LLM request timed out after ${this.settings.timeoutMs}ms`);
      }
      throw new LlmError(redactSecret(`LLM request failed: ${describeFetchError(err)}`, this.settings.apiKey));
    } finally {
      clearTimeout(timer);
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // release the body even if cancellation fails
        }
      }
    }
    if (!done) {
      throw new LlmError('Ollama response stream ended without completion marker');
    }
    return {
      text,
      model: finalModel,
      provider: 'ollama',
      durationMs: Date.now() - started,
      usage: {
        promptTokens,
        completionTokens,
      },
    };
  }

  async available(): Promise<boolean> {
    try {
      const data = await getJson(`${this.settings.baseUrl.replace(/\/$/, '')}/api/tags`, 3000);
      return Array.isArray(data?.models);
    } catch {
      return false;
    }
  }
}

class OpenAiCompatProvider implements LlmClient {
  readonly settings: LlmSettings;
  readonly provider: 'llamacpp' | 'openai';
  constructor(settings: LlmSettings, provider: 'llamacpp' | 'openai') {
    this.settings = settings;
    this.provider = provider;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push(...req.messages);
    const data = await postJson(
      `${this.settings.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
      {
        model: this.settings.model,
        messages,
        temperature: req.temperature ?? this.settings.temperature,
        max_tokens: req.maxTokens ?? this.settings.maxTokens,
        stream: false,
        ...(this.settings.seed !== undefined ? { seed: this.settings.seed } : {}),
        ...(req.stop ? { stop: req.stop } : {}),
        // Same shape Ollama's format:'json' asks for, so extraction gets the
        // same constraint on a gateway that has no `format` field.
        ...(req.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
      },
      this.settings.timeoutMs,
      this.settings.apiKey,
    );
    return {
      text: data?.choices?.[0]?.message?.content ?? '',
      model: data?.model ?? this.settings.model,
      provider: this.provider,
      durationMs: Date.now() - started,
      usage: {
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
      },
    };
  }

  async available(): Promise<boolean> {
    try {
      await getJson(`${this.settings.baseUrl.replace(/\/$/, '')}/v1/models`, 3000, this.settings.apiKey);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Offline stub. It answers based on simple cues so the whole pipeline (planning,
 * writing, context requests, continuity checks) can be exercised without a model
 * or a GPU. Never used for real writing.
 */
export class MockProvider implements LlmClient {
  readonly settings: LlmSettings;
  /** Queue of canned replies; each chat() shifts one. */
  readonly queue: string[] = [];
  /** Optional scripted handler, used by the test suite. */
  handler?: (req: ChatRequest) => string;

  constructor(settings: Partial<LlmSettings> = {}) {
    this.settings = { ...DEFAULT_LLM_SETTINGS, provider: 'mock', ...settings };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const next = this.handler ? this.handler(req) : this.queue.shift();
    const text = next ?? MockProvider.autoReply(req);
    return {
      text,
      model: 'mock',
      provider: 'mock',
      durationMs: Date.now() - started,
    };
  }

  async available(): Promise<boolean> {
    return true;
  }

  static autoReply(req: ChatRequest): string {
    const system = req.system ?? '';
    const user = req.messages.map((m) => m.content).join('\n');
    if (system.includes('JSON') || user.includes('JSON')) {
      return '```json\n{}\n```';
    }
    if (system.includes('continuity')) {
      return '```json\n{"issues":[]}\n```';
    }
    if (system.includes('context request')) {
      return 'No context request.';
    }
    return 'Mock response.';
  }
}

/* ------------------------------------------------------------------ factory */

export function createClient(settings: Partial<LlmSettings> = {}): LlmClient {
  const resolved = resolveSettings(settings);
  switch (resolved.provider) {
    case 'ollama':
      return new OllamaProvider(resolved);
    case 'llamacpp':
    case 'openai':
      return new OpenAiCompatProvider(resolved, resolved.provider);
    case 'mock':
      return new MockProvider(resolved);
    default:
      throw new LlmError(`Unknown provider: ${resolved.provider}`);
  }
}

export function clientFrom(projectSettings: unknown, opts: { useExtractionModel?: boolean } = {}): LlmClient {
  const s = (projectSettings ?? {}) as Partial<LlmSettings>;
  return createClient({
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: opts.useExtractionModel && s.extractionModel ? s.extractionModel : s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    contextTokens: s.contextTokens,
    timeoutMs: s.timeoutMs,
    seed: s.seed,
    think: s.think,
    apiKey: s.apiKey,
  });
}
