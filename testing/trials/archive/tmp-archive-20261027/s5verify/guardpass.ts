import * as lore from '/home/jacob/Documents/FanFable/fanfable/src/answer/lore.ts';
import { seedProject, tempDb, mockProvider } from '/home/jacob/Documents/FanFable/testing/tests/helpers.ts';
const { db } = tempDb();
const project = seedProject(db, 'guard-pass');
// non-status question must pass through untouched
const llm1 = mockProvider(() => 'Serena watches [S1].\n\nCONFIRMED: the bridge at Ardenne [S1].');
const r1 = await lore.answerLoreQuestion(db, llm1 as never, project.id, 'Where is the bridge?');
console.log('nonstatus_passthrough=', /CONFIRMED: the bridge/.test(r1.answer));
// status question with both-names passage must pass through
const llm2 = mockProvider(() => 'CONFIRMED: Serena Marsh is with Kade [S1].');
const both = [{ chunkId: 1, sourceId: 1, sourceTitle: 't', path: 't', locator: 'p. 1', heading: '', text: 'Serena Marsh stood with Kade at the ridge.', score: 1 }];
const r2 = await lore.answerLoreQuestion(db, llm2 as never, project.id, 'status of Serena Marsh to Kade', { search: both as never });
console.log('bothnames_passthrough=', !/Tie not established/.test(r2.answer));
db.close();
