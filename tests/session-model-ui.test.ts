import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyRuntime, type Environment, type Model, type Runtime, type Session } from '../shared/types';
import { sessionModelState } from '../src/lib/session-model';
import type { ComposerProps } from '../src/components/Composer';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { desktop: { platform: 'darwin' } },
});
const { ReadinessChecklist } = await import('../src/components/ReadinessChecklist');
const { ModelPicker } = await import('../src/components/ModelPicker');
const { ComposerFooter } = await import('../src/components/conversation/ComposerStatus');
const session: Session = {
  id: 'new-chat',
  title: '新对话',
  draft: '',
  attachments: [],
  updatedAt: 1,
  lastStatus: 'idle',
};
const first: Model = { provider: 'first', id: 'same-id', name: '模型 A' };
const previous: Model = { provider: 'second', id: 'same-id', name: '上一会话模型' };
const runtime: Runtime = {
  ...emptyRuntime(),
  sessionId: 'previous-chat',
  connected: true,
  model: previous,
  models: [first, previous],
  thinking: 'high',
  thinkingLevels: ['off', 'high'],
};
const noPreference = { provider: '', modelId: '' };
const environment: Environment = {
  piPath: '/pi',
  bash: '/bin/bash',
  supported: true,
  compatibility: 'verified',
  version: '1.1.0',
  agentDir: '/agent',
  authExists: true,
  modelsExist: true,
  errors: [],
};
const checklist = (selection: ReturnType<typeof sessionModelState>, ownRuntime = false, env = environment) =>
  renderToStaticMarkup(
    React.createElement(ReadinessChecklist, {
      environment: env,
      runtime: selection.runtime,
      ownRuntime,
      modelLabel: selection.label,
      canConnect: true,
      checkEnvironment() {},
      connect() {},
      providers() {},
    }),
  );
const picker = (selection: ReturnType<typeof sessionModelState>) =>
  renderToStaticMarkup(
    React.createElement(ModelPicker, {
      runtime: selection.runtime,
      fallback: selection.label,
      locked: false,
      thinkingLocked: false,
      canConnect: true,
      loadModels() {},
      pick() {},
      setThinking() {},
      manage() {},
      open: false,
      setOpen() {},
    }),
  );

test('a new chat with available Pi models has no first-run setup and displays Pi defaults, not another session', () => {
  const selection = sessionModelState(runtime, session, noPreference);
  assert.equal(checklist(selection), '');
  assert.match(picker(selection), /Pi 默认模型/);
  assert.doesNotMatch(picker(selection), /上一会话模型|high/);
  assert.equal(selection.runtime.connected, false);
  assert.deepEqual(selection.runtime.thinkingLevels, []);
  assert.equal(runtime.model, previous);
  assert.equal(runtime.thinking, 'high');
});

test('the selected session model wins over desktop defaults and the cached model from another provider', () => {
  const target = { ...session, model: { provider: first.provider, id: first.id }, thinking: 'low' };
  const selection = sessionModelState(runtime, target, { provider: previous.provider, modelId: previous.id });
  assert.equal(selection.runtime.model, first);
  assert.equal(selection.runtime.thinking, 'low');
  assert.match(picker(selection), /模型 A/);
  assert.doesNotMatch(picker(selection), /上一会话模型|high/);
  assert.equal(checklist(selection), '');
});

test('a saved desktop choice is shown before connection even when its metadata has not been loaded', () => {
  const selection = sessionModelState(emptyRuntime(), session, { provider: 'saved', modelId: 'saved-model' });
  assert.match(picker(selection), /saved-model/);
  assert.equal(checklist(selection), '');
});

test('the current live model and thinking take precedence over saved preferences', () => {
  const live = { ...runtime, sessionId: session.id };
  const selection = sessionModelState(live, { ...session, model: first }, noPreference);
  assert.equal(selection.runtime, live);
  assert.match(picker(selection), /上一会话模型/);
  assert.match(picker(selection), /high/);
  assert.equal(checklist(selection, true), '');
});

test('actual missing models after connection still require selection despite cached choices', () => {
  const selection = sessionModelState(
    { ...runtime, sessionId: session.id, model: undefined },
    { ...session, model: first },
    noPreference,
  );
  assert.match(checklist(selection, true), /选择一个模型/);
  assert.match(checklist(selection, true), /共 2 个可用模型/);
});

test('fresh installation and missing Pi retain actionable setup instructions', () => {
  const fresh = sessionModelState(emptyRuntime(), session, noPreference);
  assert.match(checklist(fresh), /选择一个模型/);
  assert.match(checklist(fresh), /连接并读取模型/);
  const configured = sessionModelState(runtime, session, noPreference);
  assert.match(
    checklist(configured, false, {
      ...environment,
      supported: false,
      compatibility: 'unknown',
      version: undefined,
    }),
    /检查运行环境/,
  );
});

test('connection progress is shown without a task timer; real task startup retains its timer', () => {
  const footer = (runtime: Runtime) =>
    renderToStaticMarkup(
      React.createElement(ComposerFooter, {
        runtime,
        ownRuntime: true,
        ownRunning: true,
        selected: session,
        pending: true,
        sessionEnabled: true,
        running: true,
      } as ComposerProps),
    );
  const connecting = footer({ ...emptyRuntime(), sessionId: session.id, status: 'starting' });
  assert.match(connecting, /正在连接 Pi/);
  assert.doesNotMatch(connecting, /class="elapsed"|0:00/);
  const starting = footer({
    ...emptyRuntime(),
    sessionId: session.id,
    connected: true,
    status: 'starting',
    startedAt: 1,
  });
  assert.match(starting, /启动中/);
  assert.match(starting, /class="elapsed"/);
  assert.doesNotMatch(starting, /正在连接 Pi/);
});

test('composer exposes zero and partial stats, while keeping absent or another session stats hidden', () => {
  const footer = (stats: Runtime['stats'], ownRuntime = true) =>
    renderToStaticMarkup(
      React.createElement(ComposerFooter, {
        runtime: { ...emptyRuntime(), sessionId: session.id, connected: true, stats },
        ownRuntime,
        ownRunning: false,
        selected: session,
        pending: false,
        sessionEnabled: true,
        running: false,
      } as ComposerProps),
    );
  const zero = footer({ tokens: 0, cost: 0, contextTokens: 0, contextWindow: 10000, contextPercent: 0 });
  assert.match(zero, /class="context-meter /);
  assert.match(zero, /上下文 0% \(0 \/ 10k\)/);
  assert.match(zero, /累计 0 tokens/);
  assert.match(zero, /估算 \$0\.0000/);
  const partial = footer({ contextTokens: 500, contextWindow: 10000, contextPercent: 5 });
  assert.match(partial, /上下文 5% \(500 \/ 10k\)/);
  assert.match(partial, /累计 未知 tokens/);
  assert.match(footer({ contextWindow: 10000 }), /上下文 未知 \/ 10k/);
  assert.match(footer({}), /累计 未知 tokens/);
  for (const markup of [footer(undefined), footer({ tokens: 12345 }, false)]) {
    assert.doesNotMatch(markup, /context-meter/);
    assert.match(markup, /shortcut-link/);
  }
});

test('a disabled model entry gives its reason and cannot expose a stale open picker', () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelPicker, {
      runtime,
      fallback: 'old model',
      locked: false,
      thinkingLocked: false,
      canConnect: false,
      loadModels() {},
      pick() {},
      setThinking() {},
      manage() {},
      open: true,
      setOpen() {},
      disabledReason: '会话切换中…',
    }),
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /title="会话切换中…"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /role="dialog"|role="option"/);
});

test('Windows readiness still reports missing Git Bash with a connected Pi and chosen model', () => {
  const desktop = (globalThis as any).window.desktop;
  const previousPlatform = desktop.platform;
  desktop.platform = 'win32';
  try {
    const selection = sessionModelState({ ...runtime, sessionId: session.id }, session, noPreference);
    const html = checklist(selection, true, { ...environment, bash: undefined });
    assert.match(html, /安装 Git Bash/);
    assert.match(html, /执行命令会失败/);
    assert.match(html, /重新检查运行环境/);
  } finally {
    desktop.platform = previousPlatform;
  }
});
