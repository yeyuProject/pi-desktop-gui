import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  answerAskWithText,
  askHistoryText,
  DESKTOP_ASK_TOOL,
  formatAskResult,
  readAskDetails,
  recommendedAnswers,
  validateAskAnswer,
  validateAskRequest,
  type AskRequest,
} from '../shared/ask';
import { DESKTOP_ASK_PREFIX } from '../shared/pi-bridge';
import { emptyRuntime, type Message, type ToolActivity } from '../shared/types';
import { decide } from '../shared/approval';
import { registerDesktopAsk } from '../electron/pi-ask';
import { AgentDialogs } from '../electron/agent-dialogs';
import type { PiRpc } from '../electron/rpc';
import { SessionSearch } from '../src/lib/session-search';
import { conversationTurns, placeRuntimeTools } from '../src/lib/conversation-layout';
import { RuntimeStore } from '../src/lib/runtime-store';
import { getAskDraft, saveAskDraft } from '../src/lib/ask-drafts';

const request: AskRequest = {
  questions: [
    {
      id: 'database',
      header: '数据库',
      question: '项目应该使用哪种数据库？',
      options: [
        { label: 'SQLite', description: '本地文件，无需服务', recommended: true },
        { label: 'PostgreSQL' },
      ],
    },
  ],
};
const answered = { status: 'answered' as const, answers: { database: { selected: ['SQLite'] } } };

test('question validation enforces sizes, unique ids/labels, recommendation and schema types', () => {
  assert.doesNotThrow(() => validateAskRequest(request));
  const maximum: AskRequest = {
    questions: Array.from({ length: 3 }, (_, i) => ({
      id: String(i).repeat(64),
      header: '字'.repeat(24),
      question: '字'.repeat(2000),
      multiSelect: true,
      options: Array.from({ length: 6 }, (_, j) => ({
        label: String(j).repeat(60),
        description: '字'.repeat(200),
      })),
    })),
  };
  assert.doesNotThrow(() => validateAskRequest(maximum));
  for (const value of [
    null,
    {},
    { questions: [] },
    { ...request, extra: true },
    { questions: Array(4).fill(request.questions[0]) },
    { questions: [request.questions[0], request.questions[0]] },
  ])
    assert.throws(() => validateAskRequest(value));
  for (const change of [
    { id: '' },
    { id: 'x'.repeat(65) },
    { header: 'x'.repeat(25) },
    { question: 'x'.repeat(2001) },
    { multiSelect: 'false' },
    { options: [{ label: 'single' }] },
    { options: [{ label: 'SQLite' }, { label: ' SQLite ' }] },
    { options: [{ label: '其他' }, { label: 'A' }] },
    {
      options: [
        { label: 'A', recommended: true },
        { label: 'B', recommended: true },
      ],
    },
    { options: [{ label: 'A', description: 'x'.repeat(201) }, { label: 'B' }] },
  ])
    assert.throws(() => validateAskRequest({ questions: [{ ...request.questions[0], ...change }] }));
});

test('answers reject forged labels, multiple single choices, unknown questions and oversized other text', () => {
  assert.doesNotThrow(() => validateAskAnswer(request, answered));
  assert.doesNotThrow(() => validateAskAnswer(request, answerAskWithText(request, '字'.repeat(2000))));
  for (const answer of [
    null,
    {},
    { status: 'answered', answers: {} },
    { status: 'skipped', answers: answered.answers },
    { ...answered, extra: true },
    { ...answered, answers: { other: { selected: ['SQLite'] } } },
    ...[[], ['unknown'], ['SQLite', 'SQLite'], ['SQLite', 'PostgreSQL']].map((selected) => ({
      ...answered,
      answers: { database: { selected } },
    })),
    ...['', ' ', 'x'.repeat(2001)].map((other) => ({
      ...answered,
      answers: { database: { selected: [], other } },
    })),
    { ...answered, answers: { database: { selected: ['SQLite'], other: 'also' } } },
  ])
    assert.throws(() => validateAskAnswer(request, answer));
  const multi = { questions: [{ ...request.questions[0], multiSelect: true }] };
  assert.doesNotThrow(() =>
    validateAskAnswer(multi, {
      ...answered,
      answers: { database: { selected: ['SQLite', 'PostgreSQL'], other: '扩展需求' } },
      note: '保留原始说明',
    }),
  );
});

test('composer answer skips remaining questions without accepting an incomplete option answer', () => {
  const questions = { questions: [...request.questions, { ...request.questions[0], id: '__proto__' }] };
  validateAskRequest(questions);
  const answer = answerAskWithText(questions, '自己的方案');
  validateAskAnswer(questions, answer);
  assert.throws(() => validateAskAnswer(questions, answered));
  const recommended = recommendedAnswers(questions);
  assert.equal(Object.hasOwn(recommended, '__proto__'), true);
  validateAskAnswer(questions, { status: 'timeout_recommended', answers: recommended });
  assert.equal(Object.getPrototypeOf(recommended), Object.prototype);
});

test('recommended answers and four result states retain auditable history', () => {
  const unmarked = {
    questions: [
      { ...request.questions[0], options: request.questions[0].options.map(({ label }) => ({ label })) },
    ],
  };
  assert.deepEqual(recommendedAnswers(request), answered.answers);
  assert.deepEqual(recommendedAnswers(unmarked), answered.answers);
  for (const answer of [
    answered,
    { status: 'skipped' as const },
    { status: 'cancelled' as const },
    { status: 'timeout_recommended' as const, answers: answered.answers },
  ]) {
    const details = readAskDetails({ ...request, ...answer });
    assert.ok(details);
    assert.match(formatAskResult(answer), new RegExp(answer.status));
    assert.match(askHistoryText(details), /项目应该使用哪种数据库/);
  }
  assert.equal(readAskDetails({ ...request, status: 'answered', answers: {} }), undefined);
});

function askHarness() {
  const hooks = new Map<string, (event: Record<string, unknown>) => unknown>();
  let tool: ToolDefinition;
  let goal = false,
    clock = 1000,
    calls = 0;
  let active: string[] = [];
  let input: (options: {
    timeout?: number;
    signal?: AbortSignal;
  }) => Promise<string | undefined> = async () => JSON.stringify(answered);
  const ctx = {
    ui: {
      notify() {},
      input: async (
        title: string,
        _placeholder: string,
        options: { timeout?: number; signal?: AbortSignal },
      ) => {
        calls++;
        assert.deepEqual(JSON.parse(title.slice(DESKTOP_ASK_PREFIX.length)), request);
        return input(options);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: Record<string, unknown>) => unknown) => hooks.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    registerTool: (value: ToolDefinition) => {
      tool = value;
    },
  } as unknown as ExtensionAPI;
  registerDesktopAsk(pi, () => goal, { now: () => clock, goalTimeoutMs: 10 });
  return {
    emit: (type: string, event = {}) => hooks.get(type)?.(event),
    call: (signal?: AbortSignal) => tool.execute('test', request, signal, undefined, ctx as never),
    tool: () => tool,
    input: (value: typeof input) => {
      input = value;
    },
    goal: () => {
      goal = true;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    calls: () => calls,
  };
}

test('tool waits without a normal timeout, returns details in the same call and limits requests per turn', async () => {
  const h = askHarness();
  h.emit('session_start');
  h.input(async (options) => {
    assert.equal(options.timeout, undefined);
    return JSON.stringify(answered);
  });
  const result = await h.call();
  assert.deepEqual(result.details, { ...request, ...answered });
  assert.equal(h.tool().exposure, 'model-only');
  assert.equal(h.tool().executionMode, 'sequential');
  await h.call();
  await h.call();
  await assert.rejects(h.call(), /本轮提问次数已达上限/);
  h.emit('before_agent_start', { messageType: 'custom' });
  await assert.rejects(h.call(), /本轮提问次数已达上限/);
  h.emit('before_agent_start', { messageType: 'user' });
  await h.call();
  assert.equal(h.calls(), 4);
});

test('Goal timeout chooses recommendations, cancellation wins over timeout, and continuation resets count', async () => {
  const h = askHarness();
  h.goal();
  h.input(async (options) => {
    assert.equal(options.timeout, 10);
    h.tick(10);
    return undefined;
  });
  assert.equal(readAskDetails((await h.call()).details)?.status, 'timeout_recommended');
  const controller = new AbortController();
  h.input(async () => {
    h.tick(10);
    controller.abort();
    return undefined;
  });
  assert.equal(readAskDetails((await h.call(controller.signal)).details)?.status, 'cancelled');
  await h.call(controller.signal);
  await assert.rejects(h.call(), /次数/);
  h.emit('agent_before_settle');
  await h.call(controller.signal);
  assert.equal(h.calls(), 2, 'an already-aborted call never opens a question');
});

test('invalid and forged timeout replies are cancelled instead of reaching the model as answers', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = askHarness();
  for (const value of [
    'invalid json',
    JSON.stringify({ status: 'timeout_recommended', answers: answered.answers }),
    JSON.stringify({ ...answered, answers: { database: { selected: ['invented'] } } }),
  ]) {
    h.input(async () => value);
    assert.equal(readAskDetails((await h.call()).details)?.status, 'cancelled');
  }
});

test('explicit cancellation at the Goal deadline cannot be mistaken for timeout recommendations', async () => {
  const h = askHarness();
  h.goal();
  h.input(async () => {
    h.tick(10);
    return JSON.stringify({ status: 'cancelled' });
  });
  assert.equal(readAskDetails((await h.call()).details)?.status, 'cancelled');
});

test('desktop validates responses before writing, preserves invalid answers, and clears successful dialogs', async () => {
  const runtime = { ...emptyRuntime(), sessionId: 'ask', status: 'running' as const };
  const writes: unknown[] = [];
  const rpc = {
    write: async (value: unknown) => {
      writes.push(value);
    },
  } as PiRpc;
  const diagnostics: string[] = [];
  const dialogs = new AgentDialogs({
    runtime: () => runtime,
    rpc: () => rpc,
    resumeStatus: () => 'running',
    status: (status) => {
      Object.assign(runtime, { status });
    },
    publish() {},
    diagnostic: (text) => diagnostics.push(text),
  });
  dialogs.show({ id: 'q', method: 'input', title: DESKTOP_ASK_PREFIX + JSON.stringify(request) }, true);
  assert.equal(runtime.status, 'waiting');
  assert.deepEqual(runtime.dialogs[0].ask, request);
  await assert.rejects(dialogs.respond('q', { ask: { ...answered, answers: {} } }), /所有问题/);
  await assert.rejects(dialogs.respond('q', { value: 'raw json' }), /提交回答/);
  assert.equal(writes.length, 0);
  assert.equal(runtime.dialogs.length, 1);
  await dialogs.respond('q', { ask: answered });
  assert.deepEqual(writes[0], { type: 'extension_ui_response', id: 'q', value: JSON.stringify(answered) });
  assert.equal(runtime.dialogs.length, 0);
  assert.equal(runtime.status, 'running');
  dialogs.show({ id: 'bad', method: 'input', title: DESKTOP_ASK_PREFIX + '{}' }, true);
  assert.equal(runtime.dialogs.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(writes[1], { type: 'extension_ui_response', id: 'bad', cancelled: true });
  dialogs.show(
    { id: 'deadline', method: 'input', title: DESKTOP_ASK_PREFIX + JSON.stringify(request), timeout: 10000 },
    true,
  );
  runtime.dialogs[0].expiresAt = Date.now() - 1;
  await dialogs.respond('deadline', { cancelled: true });
  assert.deepEqual(writes[2], {
    type: 'extension_ui_response',
    id: 'deadline',
    value: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(runtime.dialogs.length, 0);
  dialogs.clear();
});

test('history search uses persisted details; pending and cancelled questions do not create failed turns', () => {
  const messages: Message[] = [
    { role: 'user', content: '建立数据库' },
    {
      role: 'toolResult',
      toolName: DESKTOP_ASK_TOOL,
      toolCallId: 'q',
      content: '',
      isError: true,
      details: { ...request, ...answered, note: '保留离线能力' },
    },
  ];
  const tool: ToolActivity = {
    id: 'q',
    name: DESKTOP_ASK_TOOL,
    args: request as unknown as Record<string, unknown>,
    status: 'error',
    output: '',
    startedAt: 1,
  };
  const search = new SessionSearch();
  for (const query of ['数据库', '项目应该', 'SQLite', '保留离线'])
    assert.ok(search.search(messages, [tool], query).length);
  assert.equal(search.search(messages, [tool], 'PostgreSQL').length, 0);
  assert.equal(conversationTurns(messages, () => tool)[0].failed, false);
  assert.deepEqual(placeRuntimeTools([], [tool]).trailing, []);
});

test('answer drafts survive selection changes and are removed with the owning dialog or session', () => {
  const store = new RuntimeStore();
  const dialog = { id: 'same-id', method: 'input' as const, title: '', ask: request };
  store.set({ ...emptyRuntime(), sessionId: 'a', dialogs: [dialog] });
  store.set({ ...emptyRuntime(), sessionId: 'b', dialogs: [dialog] });
  const draft = { ...getAskDraft('a', dialog.id, request), note: '仅会话 A', noteOpen: true };
  saveAskDraft('a', dialog.id, draft);
  assert.equal(getAskDraft('b', dialog.id, request).note, '');
  assert.equal(getAskDraft('a', dialog.id, request).note, '仅会话 A');
  store.set({ ...emptyRuntime(), sessionId: 'a', dialogs: [] });
  assert.equal(getAskDraft('a', dialog.id, request).note, '');
  saveAskDraft('a', dialog.id, draft);
  assert.equal(
    getAskDraft('a', dialog.id, request).note,
    '',
    'a stale UI event cannot recreate a finished answer draft',
  );
  saveAskDraft('b', dialog.id, draft);
  store.remove('b');
  assert.equal(getAskDraft('b', dialog.id, request).note, '');
});

test('model questions need no workspace approval in any mode', () => {
  for (const mode of ['auto', 'confirm', 'readonly'] as const)
    assert.equal(decide(mode, DESKTOP_ASK_TOOL), 'allow');
});
