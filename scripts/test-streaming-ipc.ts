import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import { RuntimePublisher } from '../electron/runtime-publisher';
import { emptyRuntime } from '../shared/types';
import { streamingMarkdown } from '../src/lib/streaming-markdown';

const runtime = { ...emptyRuntime(), sessionId: 'ipc-audit' };
const events = new EventEmitter();
let bytes = 0;
events.on('runtimePatch', (patch) => {
  bytes += Buffer.byteLength(JSON.stringify(patch));
});
const publisher = new RuntimePublisher(() => runtime, events);
const block = { type: 'toolCall', id: 'write', name: 'write', arguments: {}, partialJson: '' };
runtime.messages.push({ role: 'assistant', content: [block] });
publisher.publish(true);
const timings: number[] = [];
for (let i = 0; i < 200; i++) {
  block.partialJson = (block.partialJson + 'x'.repeat(1000)).slice(-2000);
  publisher.messageChanged(0);
  const started = performance.now();
  publisher.publish(true);
  timings.push(performance.now() - started);
}
timings.sort((a, b) => a - b);
const textBefore = bytes;
const textBlock = { type: 'text', text: '' };
runtime.messages = [{ role: 'assistant', content: [textBlock] }];
publisher.resync();
for (let i = 0; i < 200; i++) {
  textBlock.text += 'a'.repeat(256);
  publisher.messageChanged(0);
  publisher.publish(true);
}
const text = 'Paragraph with arr[i] and [x].\n\n'.repeat(350);
const started = performance.now();
const markdown = streamingMarkdown(text);
const result = {
  node: process.version,
  platform: process.platform,
  ipcBytes: bytes,
  parameterIpcBytes: textBefore,
  textIpcBytes: bytes - textBefore,
  flushP95Ms: timings[Math.floor(timings.length * 0.95)],
  markdownMs: performance.now() - started,
  markdownBlocks: markdown.blocks.length,
  rss: process.memoryUsage().rss,
};
await fs.mkdir('test-results', { recursive: true });
await fs.writeFile(
  process.env.PI_PERF_RESULT ?? 'test-results/streaming-ipc.json',
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
