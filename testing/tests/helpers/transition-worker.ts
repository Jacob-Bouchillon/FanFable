import { parentPort, workerData } from 'node:worker_threads';
import { Db } from '../../../fanfable/src/core/db.ts';
import {
  transitionClaim,
  type TransitionClaimInput,
  type TransitionResult,
} from '../../../fanfable/src/court/claim-transition.ts';

interface WorkerData {
  path: string;
  projectId: number;
  input: TransitionClaimInput;
  ready: SharedArrayBuffer;
  go: SharedArrayBuffer;
}

const data = workerData as WorkerData;
const db = new Db(data.path);
const ready = new Int32Array(data.ready);
const go = new Int32Array(data.go);

Atomics.add(ready, 0, 1);
Atomics.notify(ready, 0, 2);
Atomics.wait(go, 0, 0, 10000);

try {
  const result: TransitionResult = transitionClaim(db, data.projectId, data.input);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
