import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../electron/agent';
import { placeRuntimeTools, RuntimeToolPlacer } from '../src/lib/conversation-layout';
import {
  applyRuntimePatch,
  emptyRuntime,
  messageArrayChanges,
  type Message,
  type Runtime,
  type ToolActivity,
} from '../shared/types';
import { deriveHistory, HistoryDeriver } from '../src/lib/history-derive';

const activity = (id: string, parentToolCallId?: string): ToolActivity => ({
  id,
  parentToolCallId,
  name: id === 'script' ? 'codemode' : 'bash',
  args: { command: id },
  status: 'done',
  output: `output ${id}`,
  startedAt: 1,
});
const request: Message = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: 'local fixture' } }],
};
const result: Message = {
  role: 'toolResult',
  toolCallId: 'script',
  toolName: 'codemode',
  content: 'Script completed',
  nestedCalls: {
    complete: true,
    calls: [
      { id: 'script/1', name: 'bash', status: 'ok' },
      { id: 'script/2', name: 'bash', status: 'ok' },
    ],
  },
};

test('incremental tool placement matches a full calculation through stream updates and history replacement', () => {
  const placer = new RuntimeToolPlacer();
  let messages: Message[] = [request];
  let tools = [activity('script'), activity('script/1', 'script')];
  const check = () => assert.deepEqual(placer.place(messages, tools), placeRuntimeTools(messages, tools));
  check();
  messages = [...messages, result, { role: 'assistant', content: 'one' }];
  check();
  const previous = messages;
  messages = [...messages.slice(0, -1), { role: 'assistant', content: 'two' }];
  messageArrayChanges.set(messages, { previous: new WeakRef(previous), from: 2 });
  check();
  tools = tools.map((tool) => ({ ...tool, status: 'running', output: 'latest' }));
  check();
  messages = messages.slice(0, 1);
  check();
  messages = [
    { ...result, nestedCalls: { complete: true, calls: [{ id: 'other', name: 'bash', status: 'ok' }] } },
  ];
  check();
  tools = [activity('other')];
  check();
  messages = [];
  tools = [];
  check();
});

test('a hinted text patch does not read the completed 5000-message prefix', () => {
  const placer = new RuntimeToolPlacer();
  let reads = 0;
  const prefix = Array.from({ length: 5000 }, (_, index) => ({
    get role() {
      reads++;
      return index % 2 ? ('assistant' as const) : ('user' as const);
    },
    content: 'history',
  }));
  const previous: Message[] = [...prefix, { role: 'assistant', content: 'one' }];
  placer.place(previous, []);
  reads = 0;
  const next: Message[] = [...prefix, { role: 'assistant', content: 'two' }];
  messageArrayChanges.set(next, { previous: new WeakRef(previous), from: 5000 });
  placer.place(next, []);
  assert.equal(reads, 0);
});

test('parallel nested commands stay with their script before the final answer and later turns', () => {
  const messages: Message[] = [
    { role: 'user', content: 'Look up both sources' },
    request,
    result,
    { role: 'assistant', content: 'FINAL_ANSWER' },
    { role: 'user', content: 'Follow-up question' },
    { role: 'assistant', content: 'FOLLOW_UP_ANSWER' },
  ];
  // Existing live snapshots already have native nested-call metadata, even without parent event fields.
  const tools = [activity('script'), activity('script/1'), activity('script/2')];
  const before = JSON.stringify({ messages, tools });
  const placed = placeRuntimeTools(messages, tools);
  assert.deepEqual(placed.afterMessage.get(2), tools.slice(1));
  assert.equal(placed.afterMessage.size, 1);
  assert.deepEqual(placed.trailing, []);
  assert.equal(placed.messageForTool.get('script/1'), 2);
  assert.equal(placed.messageForTool.get('script/2'), 2);
  assert.equal(JSON.stringify({ messages, tools }), before, 'presentation preserves the native transcript');
  assert.deepEqual(placeRuntimeTools(messages, []).trailing, [], 'history creates no duplicate tool cards');
});

test('running nested tools keep their output and move into place when the script result arrives', () => {
  const tools = [activity('script'), activity('script/1', 'script'), activity('script/2', 'script')];
  for (const tool of tools) tool.status = 'running';
  assert.deepEqual(placeRuntimeTools([request], tools).trailing, tools);
  tools[1].output += '\nstreamed output';
  for (const tool of tools) tool.status = 'done';
  const placed = placeRuntimeTools([request, result, { role: 'assistant', content: 'FINAL_ANSWER' }], tools);
  assert.deepEqual(placed.trailing, []);
  assert.equal(placed.afterMessage.get(1)?.[0], tools[1]);
  assert.match(placed.afterMessage.get(1)![0].output, /streamed output/);
});

test('native parent events locate deeper calls even when the saved nested-call summary is truncated', () => {
  const parent: Message = { ...result, nestedCalls: { complete: false, calls: [] } };
  const tools = [
    activity('script'),
    activity('script/1', 'script'),
    activity('script/1/1', 'script/1'),
    activity('unrelated'),
  ];
  const placed = placeRuntimeTools([request, parent, { role: 'assistant', content: 'FINAL_ANSWER' }], tools);
  assert.deepEqual(placed.afterMessage.get(1), tools.slice(1, 3));
  assert.deepEqual(placed.trailing, [tools[3]], 'unrelated activity is never assigned to a guessed parent');
});

test('tool execution events retain the native parent call id through completion', async () => {
  const service = new AgentService({ state: {}, flush: async () => {} } as never, {} as never);
  const internal = service as unknown as { onEvent(record: unknown): void };
  try {
    internal.onEvent({
      type: 'tool_execution_start',
      toolCallId: 'script/1',
      parentToolCallId: 'script',
      toolName: 'bash',
      args: { command: 'local fixture' },
    });
    assert.equal(service.runtime.tools[0].parentToolCallId, 'script');
    internal.onEvent({
      type: 'tool_execution_end',
      toolCallId: 'script/1',
      parentToolCallId: 'script',
      toolName: 'bash',
      result: { content: 'done' },
    });
    assert.equal(service.runtime.tools[0].parentToolCallId, 'script');
    assert.equal(service.runtime.tools[0].status, 'done');
    internal.onEvent({
      type: 'tool_execution_end',
      toolCallId: 'script/2',
      parentToolCallId: 'script',
      toolName: 'bash',
      result: { content: 'done' },
    });
    assert.equal(service.runtime.tools[1].parentToolCallId, 'script');
  } finally {
    await service.dispose();
  }
});

test('a tool result delivered with a steering message in one patch stays before the final answer', () => {
  const history = new HistoryDeriver();
  const placer = new RuntimeToolPlacer();
  const rg = (status: ToolActivity['status']): ToolActivity => ({ ...activity('rg'), status });
  const patch = (
    runtime: Runtime,
    messagesFrom: number,
    messages: Message[],
    tools: ToolActivity[],
  ): Runtime =>
    applyRuntimePatch(runtime, {
      sessionId: 'session',
      messagesFrom,
      messages,
      messageCount: messagesFrom + messages.length,
      toolsFrom: 0,
      tools,
      toolCount: tools.length,
    });
  const check = (runtime: Runtime) => {
    const messages = history.derive(runtime.messages);
    const placed = placer.place(messages, runtime.tools);
    assert.deepEqual(placed, placeRuntimeTools(deriveHistory(runtime.messages), runtime.tools));
    return placed;
  };
  let runtime: Runtime = { ...emptyRuntime(), sessionId: 'session' };
  runtime = patch(
    runtime,
    0,
    [
      { role: 'user', content: '扫描素材' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'rg', name: 'bash', arguments: {} }] },
    ],
    [rg('running')],
  );
  assert.deepEqual(
    check(runtime).trailing.map((tool) => tool.id),
    ['rg'],
  );
  // Pi delivers the queued steering message immediately after the failed command's result.
  runtime = patch(
    runtime,
    2,
    [
      { role: 'toolResult', toolCallId: 'rg', toolName: 'bash', content: 'exit code 1', isError: true },
      { role: 'user', content: '补充要求' },
    ],
    [rg('error')],
  );
  assert.deepEqual(check(runtime).trailing, []);
  runtime = patch(
    runtime,
    4,
    [{ role: 'assistant', content: '最终回复', stopReason: 'stop' }],
    [rg('error')],
  );
  const placed = check(runtime);
  assert.deepEqual(placed.trailing, []);
  assert.equal(placed.messageForTool.get('rg'), 2);
});
