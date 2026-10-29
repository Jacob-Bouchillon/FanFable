/**
 * Guard A/B runner. Read-only on the live bank; writes answers and report only.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { answerLoreQuestion } from '../../../fanfable/src/lore-ask.ts';
import { createClient } from '../../../fanfable/src/llm.ts';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const DIR = '/home/jacob/Documents/FanFable/testing/trials/guard-ab';
const questions = JSON.parse(readFileSync(`${DIR}/questions.json`, 'utf8'));
const raw = new DatabaseSync(DB, { readOnly: true });
const db = { path: DB, get: (s, ...p) => raw.prepare(s).get(...p), all: (s, ...p) => raw.prepare(s).all(...p) };
const projectId = db.get('SELECT id FROM project ORDER BY id LIMIT 1').id;
const llm = createClient({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', temperature: 0.1, maxTokens: 2048, contextTokens: 16384, timeoutMs: 600_000, seed: 42 });

const arms = ['guarded', 'unguarded'];
for (const arm of arms) {
  if (arm === 'unguarded') process.env.FANFABLE_NO_GUARD = '1';
  else delete process.env.FANFABLE_NO_GUARD;
  mkdirSync(`${DIR}/${arm}`, { recursive: true });
  for (const item of questions) {
    const res = await answerLoreQuestion(db, llm, projectId, item.question, { limit: 6 });
    writeFileSync(`${DIR}/${arm}/${item.id}.md`, `# ${item.id}\n\n${item.question}\n\n${res.answer}\n`);
    console.log(`${arm} ${item.id} done`);
  }
}
delete process.env.FANFABLE_NO_GUARD;
raw.close();
