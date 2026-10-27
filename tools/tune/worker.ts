// 튜닝 워커 스레드: 본 스레드가 보낸 평가 작업(EvalJob)을 하나씩 돌려 결과를 돌려준다.
// tsx로 띄운 본 스레드의 execArgv(--import tsx loader)를 물려받아 TS를 그대로 읽는다.
import { parentPort } from 'node:worker_threads';
import { evalRun, type EvalJob } from './evaluate';

parentPort!.on('message', (m: { id: number; job: EvalJob }) => {
  evalRun(m.job)
    .then((row) => parentPort!.postMessage({ id: m.id, row }))
    .catch((e: unknown) => parentPort!.postMessage({ id: m.id, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }));
});
