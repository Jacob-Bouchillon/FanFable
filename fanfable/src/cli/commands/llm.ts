/**
 * Model settings: show, set and check the local model server.
 *
 * Moved out of cli.ts on 2026-11-13, logic unchanged. `db` is a parameter
 * rather than a module-level singleton so the command is a plain function.
 */
import { Db } from '../../core/db.ts';
import {
  DEFAULT_LLM_SETTINGS,
  LlmError,
  configPath,
  loadGlobalConfig,
  resolveSettings,
  saveGlobalConfig,
} from '../../core/llm.ts';
import { clientFrom } from '../../core/llm.ts';
import type { LlmSettings } from '../../core/llm.ts';
import * as controller from '../../plan/controller.ts';
import { C, ageLabel, flagNumber, flagString, globalState, heading, setGlobalState, type Args } from '../shared.ts';

/** Printed settings never carry the whole key: prefix…suffix only. */
export function maskApiKey<T extends { apiKey?: string }>(settings: T): T {
  if (typeof settings.apiKey === 'string' && settings.apiKey) {
    settings.apiKey = `${settings.apiKey.slice(0, 6)}…${settings.apiKey.slice(-4)}`;
  }
  return settings;
}
export async function cmdLlm(db: Db, args: Args): Promise<void> {
  const sub = args._[1] ?? '';
  if (sub === 'config') {
    const patch: Partial<LlmSettings> = {};
    const provider = flagString(args, 'provider');
    const model = flagString(args, 'model');
    const baseUrl = flagString(args, 'base-url');
    const apiKey = flagString(args, 'api-key');
    const embeddingBaseUrl = flagString(args, 'embedding-base-url');
    const temperature = flagNumber(args, 'temperature', NaN);
    if (provider) patch.provider = provider as LlmSettings['provider'];
    if (model) patch.model = model;
    if (baseUrl) patch.baseUrl = baseUrl;
    if (apiKey) patch.apiKey = apiKey;
    if (embeddingBaseUrl) patch.embeddingBaseUrl = embeddingBaseUrl;
    if (Number.isFinite(temperature)) patch.temperature = temperature;
    saveGlobalConfig(patch);
    console.log(JSON.stringify(maskApiKey({ ...DEFAULT_LLM_SETTINGS, ...loadGlobalConfig() }), null, 2));
    return;
  }

  if (sub === 'status' || sub === '') {
    const settings = resolveSettings();
    heading('Model status');
    console.log(`provider: ${settings.provider}`);
    console.log(`base url: ${settings.baseUrl}`);
    console.log(`model: ${settings.model}`);
    console.log(`api key: ${settings.apiKey ? C.green('set') : C.dim('not set')}`);
    if (settings.embeddingBaseUrl) console.log(`embedding base url: ${settings.embeddingBaseUrl}`);
    const client = controller.createClient(settings);
    const ok = await client.available();
    console.log(ok ? C.green('server reachable') : C.red('server not reachable'));
    if (!ok) {
      console.log(
        C.dim(
          'Start a local server, e.g. "ollama serve" (Ollama) or "llama-server -m model.gguf" (llama.cpp), ' +
            'or set apiKey for a cloud gateway.',
        ),
      );
    }
    return;
  }

  throw new Error(`unknown llm subcommand "${sub}"`);
}

/* ------------------------------------------------------------------ trace */
