/**
 * Name sweep v2 (trials only): line references, not copied quotes.
 *
 * For each character, gather every sentence mentioning the name in reading
 * order and number them. The model answers with line numbers; the sentence is
 * retrieved by index, so every quote is verbatim by construction.
 *
 * usage: node name-sweep.ts <db> [model] [maxNames] [batch] [onlyName] [out]
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { writeFileSync } from 'node:fs';

const dbPath = process.argv[2];
const model = process.argv[3] ?? 'qwen3.5:9b';
const maxNames = Number(process.argv[4] ?? 1);
const batchSize = Number(process.argv[5] ?? 60);
const onlyName = process.argv[6] ?? '';
const outPath = process.argv[7] ?? `testing/trials/adjudication/sweep-run-${Date.now()}.json`;
if (!dbPath) {
  console.error('usage: name-sweep.ts <db> [model] [maxNames] [batch] [onlyName] [out]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
const projectId = proj!.id;

const characters = onlyName
  ? db.all<{ id: number; name: string; aliases: string; mentions: number }>(
      "SELECT id, name, aliases, mentions FROM canon_entity WHERE project_id = ? AND kind = 'character' AND name LIKE ? LIMIT 1",
      projectId,
      `%${onlyName}%`,
    )
  : db.all<{ id: number; name: string; aliases: string; mentions: number }>(
      "SELECT id, name, aliases, mentions FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined' ORDER BY mentions DESC LIMIT ?",
      projectId,
      maxNames,
    );

const chunks = db.all<{ locator: string; text: string }>(
  'SELECT locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  projectId,
);

interface LedgerLine {
  locator: string;
  sentence: string;
}
interface Tie {
  to: string;
  kind: string;
  line: number;
  quote: string;
}
interface Note {
  name: string;
  says: string;
  line: number;
  quote: string;
}
interface RawTie {
  to: string;
  kind: string;
  line: number;
}
interface RawNote {
  name: string;
  says: string;
  line: number;
}

const call = async (
  name: string,
  ledger: LedgerLine[],
  known: Tie[],
  from: number,
  to: number,
  prior: Note[],
): Promise<{ ties: RawTie[]; notes: RawNote[] }> => {
  const batch = ledger
    .slice(from, to)
    .map((l, j) => `#${from + j} ${l.sentence}`)
    .join('\n');
  const knownLines = known.map((t) => `- ${t.to} (${t.kind}) — ${t.quote}`).join('\n') || '(none yet)';
  const priorLines = prior.map((n) => `- ${n.name}: ${n.says} — ${n.quote}`).join('\n') || '(none)';
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content:
            'You track one character in a novel. Each sentence is numbered. ' +
            'Reply with JSON only: {"notes":[{"name":"other person","says":"what is said about them","line":12}],' +
            '"ties":[{"to":"name","kind":"short phrase","line":12}]}. ' +
            'Use the line number of the sentence that says it; never retype the sentence.',
        },
        {
          role: 'user',
          content:
            `Character: ${name}\n` +
            `Known ties so far:\n${knownLines}\n\n` +
            `Notes from other characters:\n${priorLines}\n\n` +
            `Sentences mentioning ${name}:\n${batch}\n\n` +
            'List every other named person here with what is said about them (notes), and every lasting ' +
            'relationship this character has with another named person (ties). Family, marriage, lasting ' +
            'roles, lasting friendship or enmity only. Give the line number for each.',
        },
      ],
      options: { temperature: 0.1, num_ctx: 16384, num_predict: 1200 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      ties?: { to?: unknown; kind?: unknown; line?: unknown }[];
      notes?: { name?: unknown; says?: unknown; line?: unknown }[];
    };
    const asLine = (v: unknown): number => {
      const n = Number(String(v ?? '').replace(/[^0-9]/g, ''));
      return Number.isFinite(n) ? n : -1;
    };
    return {
      ties: (parsed.ties ?? [])
        .map((t) => ({ to: String(t.to ?? '').trim(), kind: String(t.kind ?? '').trim(), line: asLine(t.line) }))
        .filter((t) => t.to && t.line >= 0 && t.line < ledger.length),
      notes: (parsed.notes ?? [])
        .map((n) => ({ name: String(n.name ?? '').trim(), says: String(n.says ?? '').trim(), line: asLine(n.line) }))
        .filter((n) => n.name && n.line >= 0 && n.line < ledger.length),
    };
  } catch {
    return { ties: [], notes: [] };
  }
};

const deriveTies = async (name: string, notes: Note[]): Promise<RawTie[]> => {
  const body = notes.map((n) => `#${n.line} ${n.name}: ${n.says}`).join('\n');
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      messages: [
        { role: 'system', content: 'Reply with JSON only: {"ties":[{"to":"name","kind":"short phrase","line":12}]}.' },
        {
          role: 'user',
          content:
            `Notes about ${name}, gathered from every mention of them:\n${body}\n\n` +
            `Which other named people does ${name} have a lasting relationship with? One entry per relationship, ` +
            'with the line number of the note that shows it. Ignore one-off meetings.',
        },
      ],
      options: { temperature: 0.1, num_ctx: 16384, num_predict: 1000 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      ties?: { to?: unknown; kind?: unknown; line?: unknown }[];
    };
    return (parsed.ties ?? [])
      .map((t) => ({ to: String(t.to ?? '').trim(), kind: String(t.kind ?? '').trim(), line: Number(t.line) }))
      .filter((t) => t.to && Number.isFinite(t.line));
  } catch {
    return [];
  }
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const wholeText = norm(chunks.map((c) => c.text).join(' \n '));

const runNotes: Note[] = [];
const run: { character: string; mentions: number; batches: number; ties: (Tie & { character: string })[]; notes: number }[] = [];

for (const character of characters) {
  const variants = [character.name, ...(JSON.parse(character.aliases || '[]') as string[])];
  const forms = [
    ...new Set(
      variants
        .flatMap((v) => [v, ...v.split(/\s+/)])
        .map((v) => v.trim())
        .filter((v) => v.length >= 3 && /^[A-Z]/.test(v)),
    ),
  ];
  if (!forms.length) continue;
  const formRe = new RegExp(`\\b(${forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);

  const ledger: LedgerLine[] = [];
  for (const chunk of chunks) {
    for (const sentence of chunk.text.split(/(?<=[.!?])\s+/)) {
      if (formRe.test(sentence)) ledger.push({ locator: chunk.locator, sentence: sentence.trim() });
    }
  }
  if (!ledger.length) continue;

  const prior = runNotes.filter((note) => formRe.test(note.name));
  let known: Tie[] = [];
  let notes: Note[] = [];
  let batches = 0;
  for (let i = 0; i < ledger.length; i += batchSize) {
    const out = await call(character.name, ledger, known, i, Math.min(i + batchSize, ledger.length), prior);
    known = out.ties.map((t) => ({ ...t, quote: ledger[t.line]!.sentence }));
    notes = [
      ...notes,
      ...out.notes.map((n) => ({ ...n, quote: ledger[n.line]!.sentence })),
    ];
    batches++;
  }

  notes = notes.filter((n) => wholeText.includes(norm(n.quote)));
  let ties: Tie[] = known.filter((t) => wholeText.includes(norm(t.quote)));
  if (notes.length) {
    const derived = await deriveTies(character.name, notes);
    const fromNotes = derived
      .filter((t) => t.line >= 0 && t.line < ledger.length)
      .map((t) => ({ to: t.to, kind: t.kind, line: t.line, quote: ledger[t.line]!.sentence }));
    const merged = new Map<string, Tie>();
    for (const tie of [...ties, ...fromNotes]) {
      const key = `${norm(tie.to)}|${norm(tie.kind)}`;
      const prev = merged.get(key);
      if (!prev || tie.quote.length > prev.quote.length) merged.set(key, tie);
    }
    ties = [...merged.values()];
  }

  runNotes.push(...notes);
  run.push({ character: character.name, mentions: ledger.length, batches, ties: ties.map((t) => ({ ...t, character: character.name })), notes: notes.length });
  console.log(
    JSON.stringify({
      name: character.name,
      mentions: ledger.length,
      batches,
      ties: ties.length,
      verbatim: ties.filter((t) => wholeText.includes(norm(t.quote))).length,
      notes: notes.length,
      sample: ties.slice(0, 5).map((t) => `${t.to} (${t.kind})`),
    }),
  );
}

writeFileSync(
  outPath,
  JSON.stringify({ settings: { model, batchSize, onlyName, at: new Date().toISOString() }, characters: run }, null, 1),
);
db.close();
