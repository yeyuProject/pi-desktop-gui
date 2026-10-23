import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../electron/store';
import { AgentService } from '../electron/agent';
import type { PiRpc } from '../electron/rpc';
import { SessionAgents } from '../electron/session-agents';
import { Workspace } from '../electron/workspace';
import { isOlderSession } from '../shared/usage';

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-session-activity-'));
  const store = new Store(dir);
  await store.load();
  const older = store.createSession(),
    newer = store.createSession();
  older.cwd = newer.cwd = dir;
  older.updatedAt = 1;
  newer.updatedAt = 2;
  older.unread = newer.unread = false;
  Object.assign(store.state.settings, {
    agentDir: dir,
    nodePath: process.execPath,
    piPath: path.resolve('tests/support/fixture-pi.mjs'),
  });
  const service = new AgentService(store, new Workspace(dir));
  t.after(async () => {
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const recency = () => store.state.sessions.map(({ id, updatedAt, unread }) => ({ id, updatedAt, unread }));
  return { dir, store, service, older, newer, recency };
}

async function settled(service: AgentService) {
  const start = Date.now();
  while (service.hasPendingWork) {
    if (Date.now() - start > 5000) throw new Error('Fixture did not settle: ' + service.runtime.status);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForGate(entered: Promise<void>, completion: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      completion.then(() => {
        throw new Error('Fixture operation finished before reaching its gate');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture did not reach its gate within 5 seconds')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('cold connect, reused switching and history reads preserve recency, older grouping and unread', async (t) => {
  const f = await fixture(t);
  const before = f.recency();
  for (const session of [f.older, f.newer, f.older]) {
    await f.service.connect(session.id);
    await f.service.history(session.id);
    assert.deepEqual(f.recency(), before);
    assert.equal(isOlderSession(f.older), true);
    assert.deepEqual(
      [...f.store.state.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.id),
      [f.newer.id, f.older.id],
    );
  }
  assert.equal(f.service.lastSwitch?.mode, 'reuse');
  await f.service.disconnect();
  await f.service.connect(f.older.id);
  assert.equal(f.service.lastSwitch?.mode, 'restart');
  assert.deepEqual(f.recency(), before);
  await f.store.flush();
  const saved = new Store(f.dir);
  await saved.load();
  assert.equal(saved.session(f.older.id).updatedAt, 1);
  assert.equal(saved.session(f.older.id).unread, false);
});

test('tree, settings, admin queries and export do not create content activity', async (t) => {
  const f = await fixture(t);
  await f.service.connect(f.older.id);
  f.older.updatedAt = 1;
  f.older.unread = false;
  const before = f.recency();
  await f.service.tree(f.older.id);
  await f.service.option(f.older.id, 'autoRetry', true);
  await f.service.admin(f.older.id, 'providers');
  await f.service.exportHtml(f.older.id, path.join(f.dir, 'export.html'));
  assert.deepEqual(f.recency(), before);
});

test('cancelled and failed connection attempts preserve activity and unread', async (t) => {
  const f = await fixture(t);
  await f.service.connect(f.older.id);
  f.service.runtime.status = 'completed';
  f.older.updatedAt = 1;
  f.older.unread = false;
  const before = f.recency();
  await fs.writeFile(path.join(f.dir, 'control.json'), JSON.stringify({ cancelSwitch: true }));
  await assert.rejects(f.service.connect(f.newer.id), /取消了会话切换/);
  assert.deepEqual(f.recency(), before);
  await f.service.disconnect();
  await fs.writeFile(path.join(f.dir, 'control.json'), JSON.stringify({ exitOnStats: true }));
  await assert.rejects(f.service.connect(f.older.id), /Pi 在加载会话时已退出/);
  assert.deepEqual(f.recency(), before);
});

test('exit broadcasts wait for the final activity timestamp to be persisted', async (t) => {
  const f = await fixture(t);
  await f.service.connect(f.older.id);
  await f.store.flush();
  const writer = f.store as unknown as {
    replace: (name: string, contents: string) => Promise<void>;
  };
  const replace = writer.replace.bind(writer);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let writes = 0;
  t.mock.method(writer, 'replace', async (name: string, contents: string) => {
    if (name === 'state.json' && ++writes === 2) {
      entered();
      await held;
    }
    await replace(name, contents);
  });
  let renderedAt: number | undefined;
  f.service.on('state', (state: typeof f.store.state) => {
    const session = state.sessions.find((item) => item.id === f.older.id);
    if (session?.lastStatus === 'interrupted') renderedAt = session.updatedAt;
  });
  const rpc = (f.service as unknown as { rpc: PiRpc }).rpc;
  const exited = once(rpc, 'exit');
  try {
    assert.equal(rpc.child!.kill(), true);
    await waitForGate(
      waiting,
      exited.then(() => f.store.flush()),
    );
    const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
    const saved = disk.sessions.find((session: { id: string }) => session.id === f.older.id);
    assert.equal(saved.lastStatus, 'interrupted');
    assert.equal(saved.updatedAt, 1, 'the first queued save still contains the previous activity');
    assert.ok(f.older.updatedAt > 1);
    assert.equal(renderedAt, undefined, 'the superseded save must not broadcast the still-pending activity');
  } finally {
    release();
    await f.store.flush();
  }
  const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
  assert.equal(renderedAt, f.older.updatedAt);
  assert.equal(
    disk.sessions.find((session: { id: string }) => session.id === f.older.id).updatedAt,
    renderedAt,
  );
});

test('accepted messages and background completion still advance activity and mark unread', async (t) => {
  const f = await fixture(t);
  await f.service.connect(f.older.id);
  f.older.updatedAt = 1;
  await f.service.send(f.older.id, '/handled', [], 'steer');
  assert.ok(f.older.updatedAt > f.newer.updatedAt);
  f.older.unread = false;
  f.older.updatedAt = 1;
  await f.service.send(f.older.id, 'reply', [], 'steer');
  await settled(f.service);
  assert.equal(f.service.runtime.status, 'completed');
  assert.ok(f.older.updatedAt > f.newer.updatedAt);
  assert.equal(f.older.unread, true);
  f.store.selectSession(f.older.id);
  assert.equal(f.older.unread, false);
  f.store.selectSession(f.newer.id);
  for (const command of ['hold', 'crash']) {
    f.older.unread = false;
    f.older.updatedAt = 1;
    await f.service.send(f.older.id, command, [], 'steer');
    if (command === 'hold') await f.service.stop();
    await settled(f.service);
    assert.equal(f.service.runtime.status, command === 'hold' ? 'stopped' : 'interrupted');
    assert.ok(f.older.updatedAt > f.newer.updatedAt);
    assert.equal(f.older.unread, true);
  }
});

test('a burst of 400 message and tool boundaries shares one timed save and broadcast', async (t) => {
  const f = await fixture(t);
  f.service.runtime.sessionId = f.older.id;
  f.service.runtime.status = 'running';
  const internal = f.service as unknown as { onEvent(record: unknown): void };
  const saves = t.mock.method(f.store, 'save');
  let broadcasts = 0;
  f.service.on('state', () => broadcasts++);
  const published = once(f.service, 'state');
  for (let index = 0; index < 100; index++) {
    internal.onEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
    internal.onEvent({ type: 'message_end', message: { role: 'assistant', content: `answer ${index}` } });
    internal.onEvent({ type: 'tool_execution_start', toolCallId: `tool-${index}`, toolName: 'read' });
    internal.onEvent({
      type: 'tool_execution_end',
      toolCallId: `tool-${index}`,
      result: { content: 'contents' },
    });
  }
  assert.equal(saves.mock.callCount(), 0);
  assert.equal(broadcasts, 0);
  await published;
  assert.equal(saves.mock.callCount(), 1);
  assert.equal(broadcasts, 1);
  const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
  assert.equal(
    disk.sessions.find((session: { id: string }) => session.id === f.older.id).updatedAt,
    f.older.updatedAt,
  );
});

for (const status of ['completed', 'stopped', 'error', 'interrupted'] as const)
  test(`${status} persists pending activity immediately without a duplicate broadcast`, async (t) => {
    const f = await fixture(t);
    f.service.runtime.sessionId = f.older.id;
    f.service.runtime.status = 'running';
    const internal = f.service as unknown as { activity(): void; status(value: string): void };
    const saves = t.mock.method(f.store, 'save');
    let broadcasts = 0;
    f.service.on('state', () => broadcasts++);
    internal.activity();
    assert.equal(saves.mock.callCount(), 0);
    internal.status(status);
    internal.activity();
    assert.equal(
      saves.mock.callCount(),
      2,
      'terminal status and final activity are immediate durability barriers',
    );
    await f.store.flush();
    assert.equal(broadcasts, 1);
    const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
    const saved = disk.sessions.find((session: { id: string }) => session.id === f.older.id);
    assert.equal(saved.lastStatus, status);
    assert.equal(saved.updatedAt, f.older.updatedAt);
    assert.equal(saved.unread, true);
  });

test('dispose flushes pending running activity', async (t) => {
  const f = await fixture(t);
  f.service.runtime.sessionId = f.older.id;
  f.service.runtime.status = 'running';
  (f.service as unknown as { activity(): void }).activity();
  await f.service.dispose();
  const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
  assert.equal(
    disk.sessions.find((session: { id: string }) => session.id === f.older.id).updatedAt,
    f.older.updatedAt,
  );
});

test('message, tool and run boundaries update activity without per-token persistence', async (t) => {
  const f = await fixture(t);
  await f.service.connect(f.older.id);
  const internal = f.service as unknown as { onEvent(record: unknown): void };
  f.service.runtime.status = 'running';
  for (const record of [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_end', message: { role: 'assistant', content: 'answer' } },
    { type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read' },
    { type: 'tool_execution_end', toolCallId: 'tool', result: { content: 'contents' } },
    { type: 'compaction_start' },
    { type: 'compaction_end', reason: 'manual' },
  ]) {
    f.older.updatedAt = 1;
    internal.onEvent(record);
    assert.ok(f.older.updatedAt > 1, record.type);
  }
  f.older.updatedAt = 1;
  f.service.runtime.status = 'running';
  const saves = t.mock.method(f.store, 'save');
  internal.onEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'next token' },
  });
  assert.equal(f.older.updatedAt, 1);
  assert.equal(saves.mock.callCount(), 0);
});

for (const status of ['completed', 'stopped', 'error'] as const)
  test(`configuration reload preserves ${status} activity and unread`, async (t) => {
    const f = await fixture(t);
    await f.service.connect(f.older.id);
    f.service.runtime.status = status;
    f.older.updatedAt = 1;
    f.older.unread = false;
    const before = f.recency();
    assert.equal(await f.service.scheduleReload(), true);
    assert.equal(f.service.runtime.status, status);
    assert.deepEqual(f.recency(), before);
    await fs.writeFile(path.join(f.dir, 'control.json'), JSON.stringify({ exitOnStats: true }));
    await assert.rejects(f.service.scheduleReload(), /Pi 在加载会话时已退出/);
    assert.deepEqual(f.recency(), before);
  });

test('SessionAgents browsing stays separate from a real background completion', async (t) => {
  const f = await fixture(t);
  const agents = new SessionAgents(f.store, new Workspace(f.dir));
  let primaryError: unknown;
  try {
    const background = agents.get(f.older.id);
    const foreground = agents.get(f.newer.id);
    await background.send(f.older.id, 'extension confirm', [], 'steer');
    const deadline = Date.now() + 5000;
    while (!background.runtime.dialogs.length) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    f.older.updatedAt = 1;
    f.newer.updatedAt = 2;
    f.older.unread = f.newer.unread = false;
    const before = f.recency();
    await foreground.connect(f.newer.id);
    await foreground.history(f.newer.id);
    assert.deepEqual(f.recency(), before, 'opening another process must not move either session');
    assert.equal(agents.runtime, foreground.runtime);
    await background.respond(background.runtime.dialogs[0].id, { confirmed: true });
    await settled(background);
    assert.equal(background.runtime.status, 'completed');
    assert.ok(f.older.updatedAt > f.newer.updatedAt);
    assert.equal(f.older.unread, true);
    assert.equal(f.newer.updatedAt, 2);
    assert.equal(f.newer.unread, false);
    const completed = f.recency();
    await foreground.history(f.newer.id);
    await foreground.tree(f.newer.id);
    assert.deepEqual(f.recency(), completed);
    assert.deepEqual(
      [...f.store.state.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.id),
      [f.older.id, f.newer.id],
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // These processes share the fixture directory, so close them before its after-hook removes it.
    await agents.dispose().catch((cleanupError) => {
      if (primaryError)
        throw new AggregateError([primaryError, cleanupError], 'Test and process cleanup failed');
      throw cleanupError;
    });
  }
});

for (const operation of ['navigate', 'edit'] as const)
  for (const phase of ['navigation', 'refresh', 'refresh-failure'] as const)
    test(`${operation} completing after selection changes during ${phase} marks only its session unread`, async (t) => {
      const f = await fixture(t);
      await f.service.connect(f.older.id);
      f.store.selectSession(f.older.id);
      const rpc = (f.service as unknown as { rpc: PiRpc }).rpc;
      const bridge = rpc.bridge.bind(rpc),
        request = rpc.request.bind(rpc);
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const block = async () => {
        entered();
        await held;
      };
      rpc.bridge = async (method, ...args) => {
        if (method === 'navigate') {
          if (phase === 'navigation') await block();
          return { cancelled: false };
        }
        return bridge(method, ...args);
      };
      rpc.request = async (method, ...args): Promise<any> => {
        if (method === 'get_entries')
          return {
            leafId: 'user-entry',
            entries: [
              {
                id: 'user-entry',
                type: 'message',
                message: { role: 'user', content: 'edited task', timestamp: 1 },
              },
            ],
          };
        if (method === 'get_messages' && phase.startsWith('refresh')) {
          await block();
          if (phase === 'refresh-failure') throw new Error('refresh failed after navigation');
        }
        return request(method, ...args);
      };
      const work =
        operation === 'navigate'
          ? f.service.branch(f.older.id, 'navigate', 'target-entry')
          : f.service.messageAction(f.older.id, 'edit', 'user', 1);
      const completion =
        phase === 'refresh-failure' ? assert.rejects(work, /refresh failed after navigation/) : work;
      try {
        await waitForGate(waiting, completion);
        f.store.selectSession(f.newer.id);
        release();
        await completion;
        assert.equal(f.service.runtime.status, 'idle');
        assert.ok(f.older.updatedAt > f.newer.updatedAt);
        assert.equal(f.older.unread, true);
        assert.equal(f.newer.updatedAt, 2);
        assert.equal(f.newer.unread, false);
        if (operation === 'edit' && phase !== 'refresh-failure') assert.equal(f.older.draft, 'edited task');
        await f.store.flush();
        const saved = new Store(f.dir);
        await saved.load();
        assert.equal(saved.session(f.older.id).unread, true);
      } finally {
        // Release before the fixture's after-hook waits for the operation in dispose().
        release();
        await completion.catch(() => {});
      }
    });

for (const operation of ['navigate', 'edit', 'reload'] as const)
  for (const outcome of operation === 'reload' ? (['success'] as const) : (['cancelled', 'failed'] as const))
    test(`${operation} ${outcome} after a selection change does not create activity or unread`, async (t) => {
      const f = await fixture(t);
      await f.service.connect(f.older.id);
      f.store.selectSession(f.older.id);
      const before = f.recency();
      const rpc = (f.service as unknown as { rpc: PiRpc }).rpc;
      const bridge = rpc.bridge.bind(rpc),
        request = rpc.request.bind(rpc);
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      rpc.bridge = async (method, ...args) => {
        if (method === (operation === 'reload' ? 'reload' : 'navigate')) {
          entered();
          await held;
          if (outcome === 'failed') throw new Error('navigation failed');
          return { cancelled: outcome === 'cancelled' };
        }
        return bridge(method, ...args);
      };
      rpc.request = async (method, ...args): Promise<any> => {
        if (method === 'get_entries')
          return {
            leafId: 'user-entry',
            entries: [
              {
                id: 'user-entry',
                type: 'message',
                message: { role: 'user', content: 'unchanged task', timestamp: 1 },
              },
            ],
          };
        return request(method, ...args);
      };
      const work =
        operation === 'navigate'
          ? f.service.branch(f.older.id, 'navigate', 'target-entry')
          : operation === 'edit'
            ? f.service.messageAction(f.older.id, 'edit', 'user', 1)
            : f.service.admin(f.older.id, 'reload');
      const result = outcome === 'success' ? work : assert.rejects(work, /取消了这次操作|navigation failed/);
      try {
        await waitForGate(waiting, result);
        f.store.selectSession(f.newer.id);
        release();
        await result;
        assert.deepEqual(f.recency(), before);
        assert.equal(f.older.draft, '');
      } finally {
        release();
        await result.catch(() => {});
      }
    });
