// 퍼징 worker_threads 일꾼: 시드를 받아 실행하고 결과를 돌려준다. 시드가 다 떨어지면(null) 끝난다.
import { parentPort } from 'node:worker_threads';
import { fuzzCase } from './gen';
import { runFuzzCase } from './run';

const port = parentPort!;
port.on('message', async (seed: number | null) => {
  if (seed === null) { port.close(); process.exit(0); }
  const { result } = await runFuzzCase(fuzzCase(seed));
  port.postMessage(result);
});
port.postMessage('ready');
