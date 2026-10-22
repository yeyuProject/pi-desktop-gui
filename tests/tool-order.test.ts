import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../electron/agent';
import { placeRuntimeTools } from '../src/lib/conversation-layout';
import type { Message, ToolActivity } from '../shared/types';

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
