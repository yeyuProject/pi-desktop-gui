import { Worker } from 'node:worker_threads';

/** One short-lived worker per preview; cancellation also stops the CPU work. */
export function computeDiff(
  path: string,
  before: string,
  after: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./diff-worker.mjs', import.meta.url), {
      workerData: { path, before, after },
      execArgv: [],
    });
    let settled = false;
    const finish = (error?: Error, patch?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(patch!);
    };
    const abort = () => finish(new DOMException('差异预览已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('差异计算耗时过长，请在编辑器中查看完整内容')), 8000);
    worker.once('message', (value: { patch?: string; error?: string }) => {
      if (typeof value.patch === 'string') finish(undefined, value.patch);
      else finish(new Error(value.error || '无法计算差异，请重试'));
    });
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', () => finish(new Error('差异计算已中断，请重试')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
