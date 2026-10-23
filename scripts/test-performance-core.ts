import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LfJsonDecoder } from '../electron/rpc';
import { conversationTurns } from '../src/lib/conversation-layout';
import { SessionSearch } from '../src/lib/session-search';
import type { Message, ToolActivity } from '../shared/types';

function measure(run: () => void, samples = 7) {
  run();
  const times: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { samples, medianMs: times[Math.floor(samples / 2)], maxMs: times.at(-1)! };
}

// Exercise the production stdout decoder as well as the renderer's pure hot paths.
// These fixtures do not start Pi or call a model. Timings are observations, not CI deadlines.
const decoder = [8, 16, 32].map((sizeMiB) => {
  const payload = 'A'.repeat(sizeMiB * 1024 * 1024);
  const bytes = Buffer.from(
    JSON.stringify({
      type: 'response',
      id: 'fixture',
      command: 'get_messages',
      success: true,
      data: {
        messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: payload }] }],
      },
    }) + '\n',
  );
  return {
    sizeMiB,
    chunkKiB: 64,
    ...measure(() => {
      let count = 0;
      const decoder = new LfJsonDecoder(
        (value) => {
          count++;
          assert.equal(value.data.messages[0].content[0].data.length, payload.length);
        },
        (error) => {
          throw error;
        },
      );
      for (let offset = 0; offset < bytes.length; offset += 65536)
        decoder.push(bytes.subarray(offset, offset + 65536));
      assert.equal(count, 1);
    }, 3),
  };
});

const patch = Array.from(
  { length: 500 },
  (_, i) => (i % 2 ? '+' : '-') + 'const item = { value: 12345678, label: "fixture" };',
).join('\n');
const messages: Message[] = [],
  tools = new Map<string, ToolActivity>();
for (let i = 0; i < 1250; i++) {
  messages.push(
    { role: 'user', content: `Please inspect the selected module ${i}` },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `t${i}`, name: 'edit', arguments: { path: `src/file${i}.ts` } }],
    },
    { role: 'toolResult', toolCallId: `t${i}`, toolName: 'edit', content: 'done', details: { patch } },
    { role: 'assistant', content: `Completed module ${i}` },
  );
  tools.set(`t${i}`, {
    id: `t${i}`,
    name: 'edit',
    status: 'done',
    args: {},
    output: 'done',
    startedAt: 0,
    patch,
  });
}
const turns = measure(() => {
  const result = conversationTurns(messages, (message) => tools.get(message.toolCallId!)!);
  assert.equal(result.length, 1250);
  assert.equal(result.at(-1)!.added, 250);
});

const searchMessages: Message[] = Array.from({ length: 1000 }, () => ({
  role: 'assistant',
  content: 'const value = 42;\n'.repeat(200),
}));
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const search = new SessionSearch();
const started = performance.now();
let results = search.search(searchMessages, [], 'const');
const coldMs = performance.now() - started;
const warm = measure(() => {
  results = search.search(searchMessages, [], 'const');
  assert.equal(results.length, 200_000);
  assert.equal(results.at(199_999)!.messageIndex, 999);
});
global.gc?.();
const retainedHeapMiB = global.gc ? (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024 : undefined;
const report = {
  node: process.version,
  platform: process.platform,
  note: 'Synthetic local data. Decoder times exclude I/O and IPC; turn statistics are warm; search retains its current query cache. Heap delta requires --expose-gc.',
  decoder,
  turns: { messages: 5000, tools: 1250, patchLinesPerTool: 500, ...turns },
  search: { messages: 1000, matches: results.length, coldMs, warm, retainedHeapMiB },
};
await fs.mkdir('test-results', { recursive: true });
await fs.writeFile('test-results/performance-core.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
