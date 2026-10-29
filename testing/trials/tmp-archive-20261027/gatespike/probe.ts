import * as lore from '/home/jacob/Documents/FanFable/fanfable/src/lore.ts';
import { routeQuery } from '/home/jacob/Documents/FanFable/fanfable/src/retrieval.ts';
import { seedProject, tempDb } from '/home/jacob/Documents/FanFable/testing/tests/helpers.ts';

const GATE = 'hf.co/mradermacher/RAG-Gate-4B-GGUF:latest';
const OLLAMA = 'http://127.0.0.1:11434';

interface Case { id: string; question: string; searchTerms: string; want: 'Answer' | 'Retrieve' | 'Stop'; retrievalAvailable: boolean; decoy?: string; }

const CASES: Case[] = [
  { id: 'F1', question: 'Where did Serena watch the bridge from?', searchTerms: 'ridge Serena watched bridge', want: 'Answer', retrievalAvailable: true },
  { id: 'F2', question: 'What did three lights mean?', searchTerms: 'lantern lights bridge wardens', want: 'Answer', retrievalAvailable: true },
  { id: 'F3', question: 'Who said two hundred yards?', searchTerms: 'yards Kade behind', want: 'Answer', retrievalAvailable: true },
  { id: 'F4', question: 'What did Kade spit into?', searchTerms: 'spat river Kade', want: 'Answer', retrievalAvailable: true, decoy: 'bell village dawn' },
  { id: 'T1', question: "Who is Serena Marsh's brother?", searchTerms: 'brother coat ridge', want: 'Retrieve', retrievalAvailable: true },
  { id: 'T2', question: 'Who owns the coat?', searchTerms: 'coat belonged brother', want: 'Retrieve', retrievalAvailable: true },
  { id: 'E1', question: 'Who is the unicorn keeper?', searchTerms: 'unicorn keeper', want: 'Retrieve', retrievalAvailable: true },
  { id: 'E2', question: 'Who is the unicorn keeper?', searchTerms: 'unicorn keeper', want: 'Stop', retrievalAvailable: false },
  { id: 'V1', question: 'What happened at the bridge?', searchTerms: 'bridge Ardenne rain stood', want: 'Answer', retrievalAvailable: true },
];

async function gate(question: string, passages: { sourceTitle: string; text: string }[], retrievalAvailable: boolean): Promise<string> {
  const ev = passages.map((p, i) => `[${i + 1}] ${p.sourceTitle}\n${p.text.slice(0, 600)}`).join('\n\n');
  const policy = 'Policy: answer only if the retrieved evidence above contains a complete support chain for the answer. Do not use prior knowledge when judging whether the evidence is sufficient. If the evidence is insufficient and retrieval is available, retrieve more. If the evidence is insufficient and retrieval is not available, stop without answering.';
  const actions = 'Actions: Answer = answer now; Retrieve = retrieve more evidence; Stop = stop without answering.';
  const user = `Question: ${question}\n\nRetrieved evidence:\n${ev || '(none)'}\n\nRetrieval available: ${retrievalAvailable ? 'YES' : 'NO'}\n\n${policy}\n${actions}\nReply with the action word only, on one line of the form 'Final action: '.`;
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GATE, stream: false, think: false, messages: [{ role: 'user', content: user }], options: { temperature: 0, num_predict: 10 } }),
  });
  const j = await res.json() as { message?: { content?: string } };
  const text = (j.message?.content ?? '').trim();
  const m = text.match(/(answer|retrieve|stop)/i);
  return m ? m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase() : `UNPARSEABLE:${text.slice(0, 40)}`;
}

const { db } = tempDb();
const project = seedProject(db, 'gatespike');
let detCorrect = 0, gateCorrect = 0, detOverRef = 0, gateOverRef = 0, detUnsup = 0, gateUnsup = 0, answerCases = 0, nonAnswerCases = 0;
for (const c of CASES) {
  const hits = lore.searchCanon(db, project.id, c.searchTerms, { limit: 4 });
  let passages = hits.map((h) => ({ sourceTitle: h.sourceTitle, text: h.text }));
  if (c.decoy) {
    const d = lore.searchCanon(db, project.id, c.decoy, { limit: 1 });
    if (d[0]) passages = [...passages, { sourceTitle: d[0].sourceTitle, text: d[0].text }];
  }
  const route = routeQuery(c.question, []);
  const detWouldAnswer = passages.length > 0 ? 'Answer' : (c.retrievalAvailable ? 'Retrieve' : 'Stop');
  const g = await gate(c.question, passages, c.retrievalAvailable);
  const dOk = detWouldAnswer === c.want;
  const gOk = g === c.want;
  if (dOk) detCorrect++;
  if (gOk) gateCorrect++;
  if (c.want === 'Answer') {
    answerCases++;
    if (detWouldAnswer !== 'Answer') detOverRef++;
    if (g !== 'Answer') gateOverRef++;
  } else {
    nonAnswerCases++;
    if (detWouldAnswer === 'Answer') detUnsup++;
    if (g === 'Answer') gateUnsup++;
  }
  console.log(`${c.id} route=${route} passages=${passages.length} want=${c.want} det=${detWouldAnswer} gate=${g}`);
}
console.log(`n=${CASES.length} answerCases=${answerCases} nonAnswer=${nonAnswerCases}`);
console.log(`deterministic acc=${detCorrect}/${CASES.length} overRefusal=${detOverRef}/${answerCases} unsupported=${detUnsup}/${nonAnswerCases}`);
console.log(`gate acc=${gateCorrect}/${CASES.length} overRefusal=${gateOverRef}/${answerCases} unsupported=${gateUnsup}/${nonAnswerCases}`);
db.close();
