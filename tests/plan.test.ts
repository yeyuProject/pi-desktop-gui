import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { validatePlanSteps, type PlanSnapshot, type PlanStep } from '../shared/plan';
import { planProgress } from '../src/lib/plan-progress';
import { hidePlanTools } from '../src/lib/plan-transcript';
import { SessionSearch } from '../src/lib/session-search';
import { placeRuntimeTools } from '../src/lib/conversation-layout';
import { registerDesktopPlan } from '../electron/pi-plan';
import { readPlanState, readPlanView } from '../electron/plan-state';
import { readSessionFile } from '../electron/store';
import { readLargeTranscript } from '../electron/large-transcript';
import type { Message, ToolActivity } from '../shared/types';

const steps: PlanStep[] = [
  { text: '检查输入', status: 'completed' },
  { text: '修复问题', status: 'in_progress' },
  { text: '验证结果', status: 'pending' },
];
const snapshot: PlanSnapshot = { turnId: 123, steps };
const entry = (data: unknown, id = 'p', parentId: string | null = null) =>
  ({
    type: 'custom',
    customType: 'desktop-plan',
    id,
    parentId,
    data,
    timestamp: new Date().toISOString(),
  }) as SessionEntry;

function harness() {
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  let entries: SessionEntry[] = [];
  const events: { plan: PlanSnapshot | null }[] = [];
  let activeTools: string[] = ['read'];
  let activeGoal = false,
    failWrite = false;
  const ctx = {
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (text: string) => {
        if (text.startsWith('__PI_DESKTOP__')) events.push(JSON.parse(text.slice('__PI_DESKTOP__'.length)));
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      hooks.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    appendEntry: (_type: string, data: unknown) => {
      if (failWrite) throw new Error('disk full');
      entries.push(entry(structuredClone(data), String(entries.length)));
    },
  } as unknown as ExtensionAPI;
  registerDesktopPlan(pi, () => activeGoal);
  return {
    emit: (type: string, value = {}) => hooks.get(type)?.({ type, ...value }, ctx),
    call: (value: unknown = steps) =>
      tools.get('desktop_plan')!.execute('call', { steps: value }, undefined, undefined, ctx as never),
    tool: () => tools.get('desktop_plan')!,
    entries: () => entries,
    events,
    branch: (value: SessionEntry[]) => {
      entries = value;
    },
    goal: (value: boolean) => {
      activeGoal = value;
    },
    fail: (value: boolean) => {
      failWrite = value;
    },
    active: () => activeTools,
  };
}

test('shared plan validation accepts bounds and rejects invalid or ambiguous steps', () => {
  for (const value of [
    [],
    steps,
    Array.from({ length: 12 }, () => ({ text: '字'.repeat(4000), status: 'pending' })),
  ])
    assert.doesNotThrow(() => validatePlanSteps(value));
  for (const value of [
    null,
    {},
    [null],
    [{ text: ' ', status: 'pending' }],
    [{ text: '', status: 'pending' }],
    [{ text: '字'.repeat(4001), status: 'pending' }],
    [{ text: 'x', status: 'invalid' }],
    Array(13).fill(steps[0]),
    [steps[1], steps[1]],
  ])
    assert.throws(() => validatePlanSteps(value));
});

test('plan progress selects active, first pending, all completed, or empty without false completion', () => {
  assert.deepEqual(planProgress(steps), { index: 2, total: 3, text: '修复问题', done: false });
  assert.equal(planProgress([steps[2], steps[1]]).index, 2);
  assert.deepEqual(planProgress([steps[0], steps[2]]), { index: 2, total: 2, text: '验证结果', done: false });
  assert.deepEqual(planProgress([steps[0]]), { index: 1, total: 1, text: '全部完成', done: true });
  assert.deepEqual(planProgress([]), { index: 0, total: 0, text: '', done: false });
});

test('last branch entry wins, null clears, returned state is isolated, malformed metadata is recoverable', () => {
  const rows = [entry(snapshot), entry({ ...snapshot, turnId: 456 })];
  assert.equal(readPlanState(rows)?.turnId, 456);
  readPlanState(rows)!.steps[0].text = 'mutated';
  assert.equal(readPlanState(rows)!.steps[0].text, steps[0].text);
  assert.equal(readPlanState([...rows, entry(null)]), null);
  assert.equal(readPlanState([]), null);
  assert.ok(readPlanView([entry({ turnId: -1, steps })]).warning);
  assert.deepEqual(readPlanView([entry(null)]), { plan: null });
});

test('new tasks clear plans, steering preserves the initiating timestamp, and tool updates replace', async () => {
  const h = harness();
  await h.emit('session_start');
  assert.ok(h.active().includes('desktop_plan'));
  assert.equal(h.tool().exposure, 'model-only');
  assert.equal(h.tool().executionMode, 'sequential');
  await h.emit('before_agent_start', { messageType: 'user' });
  await assert.rejects(h.call(), /没有用户任务/);
  await h.emit('message_start', { message: { role: 'user', timestamp: 123 } });
  await h.call();
  assert.deepEqual(h.events.at(-1)?.plan, snapshot);
  const count = h.entries().length;
  await h.emit('message_start', { message: { role: 'user', timestamp: 999 } });
  assert.equal(h.entries().length, count);
  await h.call([{ text: ' replacement ', status: 'pending' }]);
  assert.deepEqual(h.events.at(-1)?.plan, {
    turnId: 123,
    steps: [{ text: 'replacement', status: 'pending' }],
  });
  await h.emit('before_agent_start', { messageType: 'custom' });
  assert.ok(readPlanState(h.entries()));
  await h.emit('before_agent_start', { messageType: 'user' });
  assert.equal(readPlanState(h.entries()), null);
  assert.equal(h.events.at(-1)?.plan, null);
});

test('Goal continuation clears a stale ordinary plan and active Goal rejects before mutation', async () => {
  const h = harness();
  h.branch([entry(snapshot)]);
  await h.emit('session_start');
  h.goal(true);
  await assert.rejects(h.call(), /当前有进行中的 Goal，请使用 desktop_goal_plan/);
  assert.equal(h.entries().length, 1);
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'Continue Goal' });
  assert.equal(readPlanState(h.entries()), null);
  await h.emit('message_start', { message: { role: 'user', timestamp: 456 } });
  await assert.rejects(h.call(), /desktop_goal_plan/);
  assert.equal(h.entries().length, 2);
});

test('branch changes restore or clear state; failed persistence never publishes uncommitted progress', async () => {
  const h = harness();
  h.branch([entry(snapshot)]);
  await h.emit('session_tree');
  h.fail(true);
  await assert.rejects(h.call([]), /disk full/);
  assert.deepEqual(h.events.at(-1)?.plan, snapshot);
  h.fail(false);
  h.branch([]);
  await h.emit('session_tree');
  assert.equal(h.events.at(-1)?.plan, null);
  h.branch([entry({ broken: true })]);
  await h.emit('session_start');
  await h.emit('before_agent_start', { messageType: 'user' });
  assert.equal(readPlanState(h.entries()), null);
});

test('ordinary and large transcript readers follow branch ancestors, including null and damaged entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-plan-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const root = {
      type: 'message',
      id: 'root',
      parentId: null,
      message: { role: 'user', content: 'task', timestamp: 123 },
    };
    const rows: unknown[] = [{ type: 'session', cwd: dir }, root, entry(snapshot, 'plan', 'root')];
    const check = async (expected: PlanSnapshot | null) => {
      await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      for (const read of [readSessionFile, readLargeTranscript]) {
        const result = await read(file);
        assert.deepEqual(result.plan, expected);
        assert.equal(result.messages[0].content, 'task');
      }
    };
    await check(snapshot);
    rows.push(entry({ ...snapshot, turnId: 456 }, 'other', 'root'));
    await check({ ...snapshot, turnId: 456 });
    rows.push({ ...root, id: 'back', parentId: 'plan' });
    await check(snapshot);
    rows.push(entry(null, 'clear', 'plan'));
    await check(null);
    rows.push({ ...root, id: 'no-plan', parentId: 'root' });
    await check(null);
    rows.push(entry({ invalid: true }, 'damaged', 'plan'));
    await check(null);
    assert.match((await readSessionFile(file)).warning!, /计划状态格式无效/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('plan calls/results are hidden from transcript, live tool placement, and session search', () => {
  const messages: Message[] = [
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'p', name: 'desktop_plan', arguments: { steps } }],
    },
    { role: 'toolResult', toolCallId: 'p', content: 'private-plan-marker' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'visible answer' },
        { type: 'toolCall', id: 'p2', name: 'desktop_plan' },
      ],
    },
  ];
  const tools: ToolActivity[] = [
    {
      id: 'p',
      name: 'desktop_plan',
      args: { steps },
      output: 'private-plan-marker',
      status: 'running',
      startedAt: 0,
    },
  ];
  const visible = hidePlanTools(messages);
  assert.equal(visible.length, 2);
  assert.equal((visible[1].content as unknown[]).length, 1);
  assert.equal((messages[3].content as unknown[]).length, 2);
  assert.equal(placeRuntimeTools(visible, tools).trailing.length, 0);
  const search = new SessionSearch();
  for (const text of ['desktop_plan', 'private-plan-marker', '检查输入'])
    assert.equal(search.search(messages, tools, text).length, 0);
  assert.equal(search.search(visible, tools, 'visible answer').length, 1);
});
