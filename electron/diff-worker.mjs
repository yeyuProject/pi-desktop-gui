import { parentPort, workerData } from 'node:worker_threads';
import { createTwoFilesPatch } from 'diff';

try {
  const { path, before, after } = workerData;
  const patch = createTwoFilesPatch(path, path, before, after, '原内容', '当前内容', {
    context: 4,
    timeout: 5000,
  });
  if (patch === undefined) throw new Error('差异计算耗时过长，请在编辑器中查看完整内容');
  parentPort.postMessage({
    patch:
      patch.length > 256 * 1024
        ? patch.slice(0, 256 * 1024) + '\n… 差异已截断，请在编辑器中查看完整内容'
        : patch,
  });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
