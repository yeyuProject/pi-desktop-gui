import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  applyRuntimePatch,
  emptyRuntime,
  type Message,
  type Runtime,
  type ToolActivity,
} from '../shared/types';
import { deriveHistory, HistoryDeriver } from '../src/lib/history-derive';
import { TranscriptIndex } from '../src/lib/transcript-index';
import { ConversationDeriver } from '../src/lib/conversation-derive';
import {
  groupConversation,
  conversationTurns,
  placeRuntimeTools,
  turnThinking,
} from '../src/lib/conversation-layout';

const initial: Message[] = Array.from({ length: 1000 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  timestamp: i + 1,
  content: `Message ${i}`,
}));
initial[999] = { role: 'assistant', timestamp: 1000, content: 'a'.repeat(50000) };
const toolFor = (): ToolActivity => ({
  id: '',
  name: 'read',
  args: {},
  output: '',
  status: 'done',
  startedAt: 0,
});
const summary = (times: number[]) => {
  const sorted = times.toSorted((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] };
};
const results = [];
for (const incremental of [false, true]) {
  let runtime: Runtime = { ...emptyRuntime(), sessionId: 'derive', messages: initial };
  const history = new HistoryDeriver(),
    transcript = new TranscriptIndex(),
    conversation = new ConversationDeriver();
  const times: number[] = [];
  for (let i = 0; i < 220; i++) {
    runtime = applyRuntimePatch(runtime, {
      sessionId: 'derive',
      messagesFrom: 999,
      messageCount: 1000,
      messages: [{ ...runtime.messages[999], content: String(runtime.messages[999].content) + 'next' }],
      toolsFrom: 0,
      tools: [],
      toolCount: 0,
    });
    const start = performance.now();
    const messages = incremental ? history.derive(runtime.messages) : deriveHistory(runtime.messages);
    transcript.derive(messages);
    placeRuntimeTools(messages, []);
    turnThinking(messages, 920, 1000);
    if (incremental) conversation.derive(messages, [], toolFor, [], true);
    else {
      groupConversation(messages, toolFor, []);
      conversationTurns(messages, toolFor, true);
    }
    if (i >= 20) times.push(performance.now() - start);
  }
  results.push({ incremental, ...summary(times) });
}
const result = {
  node: process.version,
  platform: process.platform,
  messages: 1000,
  samples: 200,
  note: 'Pure derivation paths; excludes React/DOM and IPC. Full path uses the pre-optimization history and grouping operations.',
  results,
};
await fs.mkdir('test-results', { recursive: true });
await fs.writeFile('test-results/history-derive.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
