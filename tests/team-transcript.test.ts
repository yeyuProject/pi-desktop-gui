import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveHistory } from '../src/lib/history-derive';
import { SessionSearch } from '../src/lib/session-search';
import { groupConversation, conversationTurns } from '../src/lib/conversation-layout';
import type { Message, ToolActivity } from '../shared/types';

const user: Message = { role: 'user', content: [{ type: 'text', text: '调研任务' }], timestamp: 1 };
const call: Message = {
  role: 'assistant',
  timestamp: 2,
  content: [
    {
      type: 'toolCall',
      id: 'team-1',
      name: 'desktop_team_dispatch',
      arguments: { members: [{ name: '成员唯一名', task: '查找独立任务' }] },
    },
  ],
};
const tool: ToolActivity = {
  id: 'team-1',
  name: 'desktop_team_dispatch',
  args: {},
  status: 'done',
  output: '',
  startedAt: 2,
};

test('unfinished dispatch gets one renderer-only result at its original position and is searchable offline', () => {
  const original = [user, call];
  const history = deriveHistory(original);
  assert.equal(history.length, 3);
  assert.equal(original.length, 2);
  assert.equal(history[2].toolCallId, 'team-1');
  assert.equal(history[2].isError, undefined);
  assert.equal(new SessionSearch().search(history, [], '成员唯一名').length, 1);
  assert.equal(new SessionSearch().search(history, [], '独立任务').length, 1);
  assert.ok(
    groupConversation(history, () => tool, []).some((item) => item.kind === 'message' && item.index === 2),
  );
  const finished: Message = {
    role: 'toolResult',
    toolCallId: 'team-1',
    toolName: 'desktop_team_dispatch',
    content: [{ type: 'text', text: '汇报' }],
  };
  assert.equal(deriveHistory([...original, finished]).filter((m) => m.role === 'toolResult').length, 1);
});

test('failed member data is searchable but does not mark the leader turn as failed or add its line counts', () => {
  const result: Message = {
    role: 'toolResult',
    toolCallId: 'team-1',
    toolName: 'desktop_team_dispatch',
    content: [],
    details: {
      version: 1,
      leadId: 'lead',
      dispatchId: 'dispatch',
      toolCallId: 'team-1',
      startedAt: 1,
      endedAt: 3,
      members: [
        {
          sessionId: 'member',
          name: '成员唯一名',
          role: 'worker',
          task: '独立任务',
          status: 'failed',
          writable: true,
          tokens: 12,
          billedTokens: 12,
          cost: 0,
          added: 8,
          removed: 2,
          files: ['a.txt'],
          recent: [],
          report: '汇报唯一词',
          error: { kind: 'network', message: '网络连接失败' },
        },
      ],
    },
  };
  const messages = [user, call, result];
  assert.equal(new SessionSearch().search(messages, [], '汇报唯一词').length, 1);
  const turns = conversationTurns(messages, () => tool);
  assert.equal(turns[0].failed, false);
  assert.equal(turns[0].added, 0);
  assert.equal(turns[0].removed, 0);
});
