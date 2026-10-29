// Control arm: OLD relations prompt (HEAD version) on w83, chain-identical call.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const w = duel.windows.find((x: any) => x.index === 83);
const passages = 'PASSAGES:\n' + w.text.split('\n\n').map((t: string, i: number) => `[#${i}] Darth Plagueis | ${w.locators[i] ?? ''}\n${t.slice(0, 1400)}`).join('\n\n');
const names = ['Ranulph Tarkin', 'Bor Gracus', 'Pax Teem', 'Aks Moe', 'Boss Cabra', 'Darnada', 'Palpatine', 'Hego Damask', 'Vidar Kim', 'Ars Veruna', 'King Tapalo', 'Doriana'];
const oldPrompt = readFileSync(dir + 'old-relations-prompt.txt', 'utf8')
  .replace(/^export const EXTRACT_RELATIONS_SYSTEM = `?/, '').replace(/`;?\s*$/, '');
const system = `${oldPrompt}\n\nKNOWN ENTITIES:\n${names.map((n) => `- ${n}`).join('\n')}`;

const body = JSON.stringify({ model: 'qwen2.5:7b', system, messages: [{ role: 'user', content: passages }], stream: false, think: false, options: { temperature: 0, num_predict: 3000 } });
const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
const j: any = await res.json();
writeFileSync(dir + 'prompt-smoke-qwen-OLD.txt', j.message?.content ?? '');
console.log('chars:', (j.message?.content ?? '').length);
console.log(((j.message?.content ?? '').match(/"relations"/g) || []).length, 'relations-key hits;', (j.message?.content ?? '').split('\n').slice(0, 6).join('\n').slice(0, 400));
