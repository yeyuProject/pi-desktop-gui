import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionAgents } from '../electron/session-agents';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';
import { busy, applyRuntimePatch, emptyRuntime, type Runtime, type RuntimePatch } from '../shared/types';

async function fixture(t: TestContext, terminalOpen?: (id: string) => Promise<boolean>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-concurrent-'));
  const store = new Store(directory);
  await store.load();
  const agentDir = path.join(directory, 'agent');
  await fs.mkdir(agentDir);
  Object.assign(store.state.settings, {
    piPath: path.resolve('tests/support/fixture-pi.mjs'),
    nodePath: process.execPath,
    agentDir,
  });
  const a = store.createSession();
  const b = store.createSession();
  const agents = new SessionAgents(store, new Workspace(directory), undefined, undefined, terminalOpen);
  const runtimes = new Map<string, Runtime>();
  agents.on('runtimePatch', (patch: RuntimePatch) => {
    if (patch.sessionId)
      runtimes.set(
        patch.sessionId,
        applyRuntimePatch(runtimes.get(patch.sessionId) ?? emptyRuntime(), patch),
      );
  });
  agents.on('runtimeRemoved', (id: string) => runtimes.delete(id));
  t.after(async () => {
    await agents.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { agents, store, a, b, runtimes, directory };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for protocol fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('idle background processes and cached runtimes are released, selected and busy sessions survive', async (t) => {
  const { agents, store, a, b, runtimes } = await fixture(t);
  const first = agents.get(a.id),
    selected = agents.get(b.id);
  await first.connect(a.id);
  await selected.connect(b.id);
  await agents.collectIdle(Date.now() + 6 * 60_000);
  assert.equal(first.runtime.connected, false);
  assert.equal(runtimes.has(a.id), false);
  assert.equal(selected.runtime.connected, true);
  const restored = agents.get(a.id);
  assert.notEqual(restored, first);
  await restored.send(a.id, 'hold', [], 'steer');
  await agents.collectIdle(Date.now() + 12 * 60_000);
  assert.equal(agents.get(a.id), restored);
  assert.equal(busy(restored.runtime.status), true);
  await restored.stop();
  restored.runtime.dialogs = [{ id: 'waiting' } as never];
  await agents.collectIdle(Date.now() + 18 * 60_000);
  assert.equal(agents.get(a.id), restored);
  restored.runtime.dialogs = [];
  restored.runtime.followUp = ['queued'];
  await agents.collectIdle(Date.now() + 24 * 60_000);
  assert.equal(agents.get(a.id), restored);
  restored.runtime.followUp = [];
  assert.equal(store.state.selectedSessionId, b.id);
});

test('opening an idle conversation while its process closes retains ownership and reconnects in order', async (t) => {
  const { agents, a } = await fixture(t);
  const first = agents.get(a.id);
  await first.connect(a.id);
  const rpc = (first as any).rpc;
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = rpc.close.bind(rpc);
  t.mock.method(rpc, 'close', async () => {
    enter();
    await finished;
    await close();
  });
  const collecting = agents.collectIdle(Date.now() + 6 * 60_000);
  await entered;
  const reopened = agents.get(a.id);
  const reconnecting = reopened.connect(a.id);
  finish();
  await Promise.all([collecting, reconnecting]);
  assert.equal(agents.get(a.id), first);
  assert.equal(first.runtime.connected, true);
});

test('failed idle termination retains its process until a verified retry, including subsequent reconnects', async (t) => {
  const { agents, a } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.connect(a.id);
  const rpc = (agent as any).rpc;
  const close = rpc.close.bind(rpc);
  let fail = true;
  t.mock.method(rpc, 'close', async () => {
    if (fail) throw new Error('termination unconfirmed');
    await close();
  });
  await assert.rejects(agent.releaseIdleProcess(), /termination unconfirmed/);
  assert.equal((agent as any).rpc, rpc);
  assert.equal(agent.runtime.connected, false);
  await assert.rejects(agent.connect(a.id), /termination unconfirmed/);
  assert.equal((agent as any).rpc, rpc);
  fail = false;
  await agent.connect(a.id);
  assert.equal(rpc.closed, true);
  assert.notEqual((agent as any).rpc, rpc);
});

test('conversations run in separate processes; queues, models and stopping stay in their own session', async (t) => {
  const { agents, store, a, b, runtimes } = await fixture(t);
  const first = agents.get(a.id);
  const second = agents.get(b.id);
  await Promise.all([first.send(a.id, 'hold', [], 'steer'), second.send(b.id, 'hold', [], 'steer')]);
  assert.ok(busy(first.runtime.status));
  assert.ok(busy(second.runtime.status));
  assert.equal(agents.requiresStopConfirmation, true);
  assert.notEqual(first.lastSwitch?.pid, second.lastSwitch?.pid);
  await first.send(a.id, 'only A', [], 'followUp');
  await second.send(b.id, 'only B', [], 'steer');
  await first.setModel(a.id, 'fixture', 'test-next');
  assert.equal(first.runtime.model?.id, 'test');
  assert.equal(first.runtime.nextTask?.model.id, 'test-next');
  assert.equal(second.runtime.model?.id, 'test');
  assert.deepEqual(first.runtime.followUp, ['only A']);
  assert.deepEqual(second.runtime.steering, ['only B']);
  store.selectSession(a.id);
  assert.equal(agents.runtime, first.runtime);
  store.selectSession(b.id);
  assert.equal(agents.runtime, second.runtime);
  runtimes.clear();
  agents.resync();
  assert.equal(runtimes.get(a.id)?.model?.id, 'test');
  assert.equal(runtimes.get(a.id)?.nextTask?.model.id, 'test-next');
  assert.equal(runtimes.get(b.id)?.model?.id, 'test');
  await second.stop();
  assert.equal(second.runtime.status, 'stopped');
  assert.ok(busy(first.runtime.status));
  assert.ok(agents.hasPendingWork, 'a background run must block application updates');
  assert.match(store.session(b.id).draft, /only B/);
  assert.doesNotMatch(store.session(a.id).draft, /only B/);
  await agents.stop();
  assert.equal(first.runtime.status, 'stopped');
  await until(() => !agents.hasPendingWork);
});

test('identical dialog IDs from different Pi processes are answered independently', async (t) => {
  const { agents, a, b } = await fixture(t);
  const first = agents.get(a.id);
  const second = agents.get(b.id);
  await Promise.all([
    first.send(a.id, 'extension confirm', [], 'steer'),
    second.send(b.id, 'extension confirm', [], 'steer'),
  ]);
  await until(() => first.runtime.dialogs.length === 1 && second.runtime.dialogs.length === 1);
  assert.equal(first.runtime.dialogs[0].id, second.runtime.dialogs[0].id);
  await second.respond(second.runtime.dialogs[0].id, { confirmed: true });
  await until(() => second.runtime.status === 'completed');
  assert.equal(first.runtime.status, 'waiting');
  assert.equal(first.runtime.dialogs.length, 1);
  assert.equal(second.runtime.dialogs.length, 0);
});

test('a crash and process cleanup in one conversation leave another run and model switch available', async (t) => {
  const { agents, a, b } = await fixture(t);
  const first = agents.get(a.id);
  const second = agents.get(b.id);
  await Promise.all([first.send(a.id, 'hold', [], 'steer'), second.send(b.id, 'crash', [], 'steer')]);
  await until(() => second.runtime.status === 'interrupted');
  await first.setModel(a.id, 'fixture', 'test-next');
  assert.equal(first.runtime.status, 'running');
  assert.equal(first.runtime.model?.id, 'test');
  assert.equal(first.runtime.nextTask?.model.id, 'test-next');
  assert.equal(second.runtime.connected, false);
  await first.stop();
});

test('concurrent thinking preferences remain session choices without overwriting the shared Pi settings', async (t) => {
  const { agents, store, a, b } = await fixture(t);
  await Promise.all([agents.setThinking(a.id, 'low'), agents.setThinking(b.id, 'high')]);
  assert.equal(store.session(a.id).thinking, 'low');
  assert.equal(store.session(b.id).thinking, 'high');
  await assert.rejects(fs.access(path.join(store.state.settings.agentDir, 'settings.json')), {
    code: 'ENOENT',
  });
});

test('thinking choices follow the levels synchronized from Pi, including max and newly supplied levels', async (t) => {
  const { agents, store, a } = await fixture(t);
  await fs.writeFile(
    path.join(store.state.settings.agentDir, 'control.json'),
    JSON.stringify({ thinkingLevels: { test: ['off', 'max', 'future-level'] } }),
  );
  const agent = agents.get(a.id);
  await agent.connect(a.id);
  assert.deepEqual(agent.runtime.thinkingLevels, ['off', 'max', 'future-level']);
  for (const level of ['max', 'future-level']) {
    await agent.setThinking(a.id, level);
    assert.equal(agent.runtime.thinking, level);
    assert.equal(store.session(a.id).thinking, level);
    assert.equal(store.state.settings.thinking, level);
  }
  const preferences = () =>
    structuredClone({
      thinking: store.session(a.id).thinking,
      settings: store.state.settings,
      runtimeThinking: agent.runtime.thinking,
      nextTask: agent.runtime.nextTask,
    });
  const before = preferences();
  await assert.rejects(agent.setThinking(a.id, 'low'), /所选模型不支持这个推理级别/);
  await assert.rejects(agent.setThinking(a.id, 'unsupported-level'), /所选模型不支持这个推理级别/);
  assert.deepEqual(preferences(), before);
});

test('pending thinking choices use the next model levels rather than the current model levels', async (t) => {
  const { agents, store, a } = await fixture(t);
  await fs.writeFile(
    path.join(store.state.settings.agentDir, 'control.json'),
    JSON.stringify({ thinkingLevels: { test: ['off', 'high'], 'test-next': ['off', 'max'] } }),
  );
  const agent = agents.get(a.id);
  await agent.send(a.id, 'hold', [], 'steer');
  await agent.setModel(a.id, 'fixture', 'test-next');
  await agent.setThinking(a.id, 'max');
  assert.equal(agent.runtime.model?.id, 'test');
  assert.equal(agent.runtime.thinking, 'off');
  assert.equal(agent.runtime.nextTask?.thinking, 'max');
  await assert.rejects(agent.setThinking(a.id, 'high'), /所选模型不支持这个推理级别/);
  assert.equal(agent.runtime.nextTask?.thinking, 'max');
  assert.equal(store.session(a.id).thinking, 'max');
  await agent.stop();
  await agent.send(a.id, 'hold', [], 'steer');
  assert.equal(agent.runtime.model?.id, 'test-next');
  assert.equal(agent.runtime.thinking, 'max');
  assert.equal(agent.runtime.nextTask, undefined);
});

test('model and thinking changes stay pending through running supplements and apply on a new task', async (t) => {
  const { agents, a } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.send(a.id, 'hold', [], 'steer');
  await agent.setModel(a.id, 'fixture', 'test-next');
  await agent.setThinking(a.id, 'high');
  await agent.send(a.id, 'supplement', [], 'steer');
  assert.equal(agent.runtime.model?.id, 'test');
  assert.equal(agent.runtime.thinking, 'off');
  assert.equal(agent.runtime.nextTask?.thinking, 'high');
  await agent.stop();
  assert.equal(agent.runtime.model?.id, 'test');
  await agent.send(a.id, 'hold', [], 'steer');
  assert.equal(agent.runtime.model?.id, 'test-next');
  assert.equal(agent.runtime.thinking, 'high');
  assert.equal(agent.runtime.nextTask, undefined);
});

test('approval and automatic step settings can change while running without stopping or closing a dialog', async (t) => {
  const { agents, a, b } = await fixture(t);
  const agent = agents.get(a.id),
    other = agents.get(b.id);
  await Promise.all([
    agent.send(a.id, 'extension confirm', [], 'steer'),
    other.send(b.id, 'hold', [], 'steer'),
  ]);
  await until(() => agent.runtime.dialogs.length === 1);
  const dialog = agent.runtime.dialogs[0];
  await agent.setApprovalMode(a.id, 'readonly');
  await agent.option(a.id, 'autoCompaction', false);
  await agent.option(a.id, 'autoRetry', false);
  assert.equal(agent.runtime.dialogs[0].id, dialog.id);
  assert.equal(agent.runtime.approvalMode, 'readonly');
  assert.equal(agent.runtime.autoRetry, false);
  assert.equal(agent.runtime.autoCompaction, false);
  assert.equal(other.runtime.approvalMode, 'auto');
  assert.equal(other.runtime.autoRetry, true);
  assert.equal(other.runtime.autoCompaction, true);
  assert.equal(other.runtime.status, 'running');
});

test('saved configuration waits for each affected session to become safe', async (t) => {
  const { agents, a, b } = await fixture(t);
  const agent = agents.get(a.id),
    other = agents.get(b.id);
  await Promise.all([agent.send(a.id, 'hold', [], 'steer'), other.send(b.id, 'hold', [], 'steer')]);
  const oldPid = agent.lastSwitch?.pid,
    otherPid = other.lastSwitch?.pid;
  assert.deepEqual(await agents.reloadConfiguration(a.id, false), { applied: false, deferred: true });
  assert.equal(agent.lastSwitch?.pid, oldPid);
  assert.equal(other.lastSwitch?.pid, otherPid);
  await agent.stop();
  assert.notEqual(agent.lastSwitch?.pid, oldPid);
  assert.equal(agent.runtime.configurationPending, undefined);
  assert.equal(other.lastSwitch?.pid, otherPid);
  assert.equal(other.runtime.status, 'running');
  assert.equal(other.runtime.configurationPending, true);
});

test('a configuration load failure after abort does not turn a confirmed stop into a stop failure', async (t) => {
  const { agents, store, a, directory } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.send(a.id, 'hold', [], 'steer');
  await agents.reloadConfiguration(a.id, false);
  store.state.settings.nodePath = path.join(directory, 'missing-node.exe');
  await agent.stop();
  assert.equal(agent.runtime.status, 'stopped');
  assert.equal(agent.runtime.connected, false);
  assert.equal(agent.runtime.configurationPending, true);
  assert.ok(agent.runtime.notices.some((notice) => notice.includes('配置已保存，加载失败')));
});

test('application shutdown stops without restarting Pi to load deferred configuration', async (t) => {
  const { agents, a } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.send(a.id, 'hold', [], 'steer');
  const pid = agent.lastSwitch?.pid;
  await agents.reloadConfiguration(a.id, false);
  agents.suspendReload(true);
  await agents.stop();
  assert.equal(agent.lastSwitch?.pid, pid);
  assert.equal(agent.runtime.configurationPending, true);
  assert.equal(agent.runtime.status, 'stopped');
  agents.suspendReload(false);
  await until(() => agent.runtime.connected && agent.lastSwitch?.pid !== pid);
});

test('shutdown refuses new conversations before waiting for existing processes to close', async (t) => {
  const { agents, a, b } = await fixture(t);
  const first = agents.get(a.id);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispose = first.dispose.bind(first);
  t.mock.method(first, 'dispose', async () => {
    await gate;
    await dispose();
  });
  const closing = agents.dispose();
  try {
    assert.throws(() => agents.get(b.id), /正在关闭/);
    assert.throws(() => agents.setThinking(b.id, 'low'), /正在关闭/);
  } finally {
    finish();
    await closing;
  }
});

test('exit waits for finishing operations without a stop prompt and cancels queued work', async (t) => {
  const { agents, store, a, directory } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.connect(a.id);
  const rpc = (agent as any).rpc;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const finishing = (agent as any).exclusive(async () => {
    entered = true;
    await gate;
    store.session(a.id).draft = 'saved before exit';
    await store.save();
  });
  await until(() => entered);
  const queuedSend = assert.rejects(
    agent.send(a.id, 'must not run during exit', [], 'steer'),
    /任务已取消|应用正在关闭/,
  );
  const queuedMutation = assert.rejects(agent.admin(a.id, 'reload'), /应用正在关闭/);
  assert.equal(agents.hasPendingWork, true);
  assert.equal(agents.requiresStopConfirmation, false);
  let disposed = false;
  const closing = agents.dispose().then(() => {
    disposed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(rpc.closed, false, 'do not close the process before the finishing operation');
  } finally {
    release();
    await Promise.all([finishing, queuedSend, queuedMutation, closing]);
  }
  assert.equal(rpc.closed, true);
  assert.ok(!agent.runtime.messages.some((message) => message.content === 'must not run during exit'));
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(
    saved.sessions.find((session: { id: string }) => session.id === a.id).draft,
    'saved before exit',
  );
});

test('workspace protection follows real overlapping directories and leaves unrelated projects available', async (t) => {
  const { agents, a, b, directory } = await fixture(t);
  const root = path.join(directory, 'project');
  const nested = path.join(root, 'nested');
  const unrelated = path.join(directory, 'other-project');
  await Promise.all([fs.mkdir(nested, { recursive: true }), fs.mkdir(unrelated)]);
  Object.assign(agents.get(a.id).runtime, { sessionId: a.id, cwd: root, status: 'running' });
  Object.assign(agents.get(b.id).runtime, { sessionId: b.id, cwd: unrelated });
  await assert.rejects(
    agents.inWorkspace(nested, true, async () => {}),
    /停止相关任务/,
  );
  assert.equal(await agents.inWorkspace(unrelated, true, async () => 42), 42);
  (agents.get(a.id) as any).activeWriteTargets.set('outside', path.join(unrelated, 'shared.txt'));
  await assert.rejects(
    agents.inWorkspace(unrelated, true, async () => {}),
    /停止相关任务/,
  );
  (agents.get(a.id) as any).activeWriteTargets.clear();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const mutation = agents.inWorkspace(unrelated, true, async () => {
    entered = true;
    await gate;
  });
  await until(() => entered);
  try {
    await assert.rejects(
      agents.inWorkspace(unrelated, false, async () => {}),
      /目录正在执行/,
    );
    assert.equal(await agents.inWorkspace(nested, false, async () => 7), 7);
  } finally {
    release();
    await mutation;
  }
});

test('terminal handoff reserves only its session before disconnecting the old process', async (t) => {
  let nativeOwner = '';
  const { agents, a, b } = await fixture(t, async (id) => id === nativeOwner);
  const agent = agents.get(a.id);
  await agent.connect(a.id);
  const rpc = (agent as any).rpc;
  const close = rpc.close.bind(rpc);
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(rpc, 'close', async () => {
    entered = true;
    await gate;
    await close();
  });
  const handoff = agents.handoffToTerminal(a.id, async () => {
    nativeOwner = a.id;
  });
  await until(() => entered);
  try {
    await assert.rejects(agent.tree(a.id), /Pi 终端/);
    await agents.get(b.id).send(b.id, 'hold', [], 'steer');
    await until(() => agents.get(b.id).runtime.status === 'running');
    assert.equal(agents.get(b.id).runtime.status, 'running');
  } finally {
    release();
    await handoff;
  }
  assert.equal(agent.runtime.connected, false);
  await assert.rejects(
    agents.updatePackages(b.id, false, async () => {}),
    /Pi 终端/,
  );
  await assert.rejects(agent.connect(a.id), /Pi 终端/);
  nativeOwner = '';
  await agent.connect(a.id);
});

test('resource reload waits for an in-flight read without putting reads in the task queue', async (t) => {
  const { agents, a } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.connect(a.id);
  const rpc = (agent as any).rpc;
  const bridge = rpc.bridge.bind(rpc);
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(rpc, 'bridge', async (method: string, ...args: unknown[]) => {
    if (method === 'tree') {
      entered = true;
      await gate;
    }
    return bridge(method, ...args);
  });
  const read = agent.tree(a.id);
  await until(() => entered);
  const pid = agent.lastSwitch?.pid;
  assert.equal(
    await agents.inWorkspace(agent.runtime.cwd!, true, async () => 42),
    42,
    'passive history reads must not be treated as project file writes',
  );
  assert.deepEqual(await agents.reloadConfiguration(a.id, false), { applied: false, deferred: true });
  assert.equal(agent.lastSwitch?.pid, pid);
  release();
  await read;
  await until(() => agent.runtime.connected && agent.lastSwitch?.pid !== pid);
});

test('resource reload also waits for a model preference request that is still being saved', async (t) => {
  const { agents, a } = await fixture(t);
  const agent = agents.get(a.id);
  await agent.connect(a.id);
  const rpc = (agent as any).rpc;
  const bridge = rpc.bridge.bind(rpc);
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(rpc, 'bridge', async (method: string, ...args: unknown[]) => {
    if (method === 'task_options') {
      entered = true;
      await gate;
    }
    return bridge(method, ...args);
  });
  const preference = agent.setModel(a.id, 'fixture', 'test-next');
  await until(() => entered);
  const pid = agent.lastSwitch?.pid;
  assert.deepEqual(await agents.reloadConfiguration(a.id, false), { applied: false, deferred: true });
  assert.equal(agent.lastSwitch?.pid, pid);
  release();
  await preference;
  await until(() => agent.runtime.connected && agent.lastSwitch?.pid !== pid);
  assert.equal(agent.runtime.model?.id, 'test-next');
});
