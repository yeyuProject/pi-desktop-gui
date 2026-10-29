import test from 'node:test';
import assert from 'node:assert/strict';
import desktopBridge from '../electron/pi-bridge';
import { APPROVAL_ALWAYS, APPROVAL_DENY, alwaysKey, decide, describe } from '../shared/approval';

function bridge(mode: 'confirm' | 'readonly') {
  const handlers = new Map<string, (...args: any[]) => any>();
  const previous = process.env.PI_DESKTOP_APPROVAL;
  process.env.PI_DESKTOP_APPROVAL = mode;
  try {
    desktopBridge({
      on: (name: string, handler: (...args: any[]) => any) => {
        const previous = handlers.get(name);
        handlers.set(name, async (...args: any[]) => {
          const result = await previous?.(...args);
          return result?.block ? result : ((await handler(...args)) ?? result);
        });
      },
      registerCommand: () => {},
      registerTool: () => {},
      getActiveTools: () => ['desktop_plan'],
      setActiveTools: () => {},
      getAllTools: () => [{ name: 'external_writer', annotations: { readOnlyHint: true } }],
    } as never);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_APPROVAL;
    else process.env.PI_DESKTOP_APPROVAL = previous;
  }
  return handlers;
}

test('external read-only hints cannot bypass confirmation or read-only restrictions', async () => {
  for (const mode of ['confirm', 'readonly'] as const) {
    let asked = 0;
    const result = await bridge(mode).get('tool_call')!(
      { toolName: 'external_writer', input: {}, toolCallId: 'external' },
      {
        ui: {
          select: async () => {
            asked++;
            return APPROVAL_DENY;
          },
        },
      },
    );
    assert.equal(result?.block, true);
    assert.equal(asked, mode === 'confirm' ? 1 : 0);
  }
});

test('only the two built-in Goal state tools bypass workspace approval', async () => {
  for (const mode of ['confirm', 'readonly'] as const) {
    for (const tool of [
      'desktop_goal_get',
      'desktop_goal_update',
      'desktop_goal_plan',
      'desktop_goal_complete',
      'desktop_goal_blocked',
    ])
      assert.equal(decide(mode, tool), 'allow', tool);
    const unknown = 'desktop_goal_execute';
    assert.equal(decide(mode, unknown), mode === 'confirm' ? 'ask' : 'deny');
    let asked = 0;
    const result = await bridge(mode).get('tool_call')!(
      { toolName: unknown, input: {}, toolCallId: 'unknown-goal-tool' },
      {
        ui: {
          select: async () => {
            asked++;
            return APPROVAL_DENY;
          },
        },
      },
    );
    assert.equal(result?.block, true);
    assert.equal(asked, mode === 'confirm' ? 1 : 0);
  }
});

test('approval displays the entire command and grants only its exact text', () => {
  const prefix = 'echo ' + 'x'.repeat(5000);
  const first = describe('bash', { command: prefix + '; echo first' });
  const second = describe('bash', { command: prefix + '; echo second' });
  assert.equal(first.summary, prefix + '; echo first');
  assert.notEqual(alwaysKey(first), alwaysKey(second));
});

test('always-allow grants end when Pi starts a different session', async () => {
  const handlers = bridge('confirm');
  let asked = 0;
  const notifications: string[] = [];
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [], getSessionId: () => 'approval-test' },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        asked++;
        return APPROVAL_ALWAYS;
      },
    },
  };
  const event = { toolName: 'write', input: { path: 'a.txt', content: 'a' }, toolCallId: 'write' };
  await handlers.get('tool_call')!(event, ctx);
  await handlers.get('tool_call')!(event, ctx);
  assert.equal(asked, 1);
  await handlers.get('session_start')?.({}, ctx);
  assert.ok(notifications.includes('__PI_DESKTOP__{"type":"desktop_session_start"}'));
  assert.ok(notifications.includes('__PI_DESKTOP__{"type":"desktop_approval_grants","grants":[]}'));
  await handlers.get('tool_call')!(event, ctx);
  assert.equal(asked, 2);
});

test('manual ! commands obey read-only mode before the shell starts', async () => {
  const handler = bridge('readonly').get('user_bash');
  assert.ok(handler, 'RPC user commands need the same approval policy');
  const response = await handler({ command: 'echo blocked', excludeFromContext: false, cwd: '.' }, {});
  assert.notEqual(response?.result?.exitCode, 0);
  assert.match(response.result.output, /只读/);
});

test('desktop_plan only writes session metadata and never requires approval', () => {
  for (const mode of ['auto', 'confirm', 'readonly'] as const)
    assert.equal(decide(mode, 'desktop_plan'), 'allow');
});
