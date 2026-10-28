import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';
import { AgentService } from '../electron/agent';
import { applyRuntimePatch, emptyRuntime, type Message, type RuntimePatch } from '../shared/types';

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-transcript-'));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  session.file = path.join(dir, 'native-session.jsonl');
  const messages: Message[] = [
    { role: 'user', content: 'EARLY_REQUEST', timestamp: 1 },
    { role: 'assistant', content: 'EARLY_ANSWER', timestamp: 2 },
    { role: 'user', content: 'LATEST_REQUEST', timestamp: 3 },
    { role: 'assistant', content: 'PERSISTED_FINAL_SUMMARY', timestamp: 4, stopReason: 'stop' },
  ];
  const records: object[] = [{ type: 'session', version: 3, id: session.id, cwd: dir }];
  let parentId: string | null = null;
  for (const [index, message] of messages.entries()) {
    const id = 'm-' + index;
    records.push({ type: 'message', id, parentId, message });
    parentId = id;
    if (index === 1) {
      records.push({
        type: 'compaction',
        id: 'compact',
        parentId,
        firstKeptEntryId: id,
        summary: 'COMPACTED_CONTEXT',
      });
      parentId = 'compact';
    }
  }
  await fs.writeFile(session.file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const service = new AgentService(store, new Workspace(dir));
  service.runtime = {
    ...emptyRuntime(),
    sessionId: session.id,
    connected: true,
    status: 'completed',
    messages: messages.slice(0, 3),
  };
  // A model-context snapshot after compaction is not the full persisted conversation.
  let context: Message[] = [{ role: 'compactionSummary', content: 'COMPACTED_CONTEXT' }, messages[2]];
  const rpc = {
    closed: false,
    async request(type: string): Promise<Record<string, unknown>> {
      if (type === 'get_state')
        return { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: session.file };
      if (type === 'get_messages') return { messages: context };
      if (type === 'get_session_stats') return { tokens: { total: 12 } };
      throw new Error('Unexpected command ' + type);
    },
  };
  const internal = service as unknown as {
    rpc: typeof rpc | undefined;
    refresh(reconcile?: boolean): Promise<void>;
  };
  internal.rpc = rpc;
  t.after(async () => {
    internal.rpc = undefined;
    service.runtime.status = 'idle';
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    service,
    session,
    messages,
    internal,
    rpc,
    setContext: (value: Message[]) => {
      context = value;
    },
  };
}

test('settled refresh restores native history and the final summary after a compacted or incomplete stream', async (t) => {
  const f = await fixture(t);
  let view = emptyRuntime();
  const patches: RuntimePatch[] = [];
  f.service.on('runtimePatch', (patch: RuntimePatch) => {
    patches.push(patch);
    view = applyRuntimePatch(view, patch);
  });
  f.service.publish(true);
  await f.internal.refresh();
  f.service.publish(true);
  assert.deepEqual(f.service.runtime.messages, f.messages);
  assert.deepEqual(view.messages, f.messages);
  assert.equal(
    patches.at(-1)?.messagesFrom,
    0,
    'settlement sends a complete transcript to repair a stale renderer',
  );
  assert.deepEqual(await f.service.history(f.session.id), f.messages);
});

test('a running refresh keeps live messages rather than an older persisted transcript', async (t) => {
  const f = await fixture(t);
  f.service.runtime.status = 'running';
  const messages = [{ role: 'assistant', content: 'CURRENT_PARTIAL_REPLY' }];
  f.service.runtime.messages = messages;
  await f.internal.refresh();
  assert.equal(f.service.runtime.messages, messages);
});

test('opening idle history reads the latest native transcript instead of the live cache', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.history(f.session.id), f.messages);
});

test('a completion refresh cannot replace messages from a newly started run', async (t) => {
  const f = await fixture(t);
  let release!: (value: Record<string, unknown>) => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (type: string) => {
    if (type === 'get_messages') {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return original(type);
  };
  const refreshing = f.internal.refresh();
  await pending;
  f.service.runtime.status = 'running';
  f.service.runtime.messages.push({ role: 'user', content: 'NEXT_REQUEST', timestamp: 5 });
  release({ messages: f.messages });
  await refreshing;
  assert.equal(f.service.runtime.messages.at(-1)?.content, 'NEXT_REQUEST');
  assert.equal(f.service.runtime.status, 'running');
});

test('ordinary turn refresh preserves event history without reading or resending the whole transcript', async (t) => {
  const f = await fixture(t);
  const rpc = f.internal.rpc!;
  const original = rpc.request;
  const calls: string[] = [];
  rpc.request = async (type) => {
    calls.push(type);
    return original(type);
  };
  const messages = f.service.runtime.messages;
  let resyncs = 0;
  const internal = f.service as unknown as { resync(): void; historyRevision: number };
  t.mock.method(internal, 'resync', () => {
    resyncs++;
  });
  await f.internal.refresh(false);
  assert.ok(!calls.includes('get_messages'));
  assert.equal(f.service.runtime.messages, messages);
  assert.equal(resyncs, 0);
  internal.historyRevision++;
  await f.internal.refresh(false);
  assert.equal(calls.filter((type) => type === 'get_messages').length, 1);
  assert.equal(resyncs, 1);
  await f.internal.refresh(false);
  assert.equal(calls.filter((type) => type === 'get_messages').length, 1);
});

test('native boundary entries retain hidden context without settling the active task', async (t) => {
  const f = await fixture(t);
  f.service.runtime.status = 'running';
  const internal = f.service as unknown as {
    onEvent(event: object): void;
    historyRevision: number;
  };
  const revision = internal.historyRevision;
  const previousLength = f.service.runtime.messages.length;
  internal.onEvent({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'desktop-goal', data: { status: 'active' } },
  });
  assert.equal(f.service.runtime.messages.length, previousLength, 'goal state is not a chat message');
  internal.onEvent({
    type: 'entry_appended',
    entry: {
      type: 'custom_message',
      customType: 'desktop-goal-continuation',
      content: 'Continue the active goal',
      display: false,
      timestamp: '2026-10-28T00:00:00.000Z',
    },
  });
  assert.equal(f.service.runtime.status, 'running');
  assert.equal(f.service.runtime.messages.at(-1)?.display, false);
  assert.equal(f.service.runtime.messages.at(-1)?.content, 'Continue the active goal');
  assert.equal(internal.historyRevision, revision + 1, 'settlement will reconcile appended context');
});
