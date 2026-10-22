import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../electron/agent';
import { Store } from '../electron/store';
import { applyRuntimePatch, emptyRuntime, type RuntimePatch, type RunStatus } from '../shared/types';

function fixture(t: TestContext) {
  const sessions = ['one', 'two'].map((id) => ({
    id,
    title: 'Fixture',
    draft: '',
    attachments: [],
    lastStatus: 'completed',
    updatedAt: 0,
  }));
  const store = {
    state: { selectedSessionId: 'one', settings: {} },
    session: (id: string) => sessions.find((session) => session.id === id)!,
    // These pre-existing conversations are durable; exercise the same lookup contract.
    isTransientSession: () => false,
    promoteSession(id: string) {
      const session = sessions.find((session) => session.id === id);
      assert.ok(session);
      return session;
    },
    assertWritable() {},
    matchesDraft: Store.prototype.matchesDraft,
    async save() {},
    async flush() {},
  };
  const service = new AgentService(store as never, {} as never);
  const model = { provider: 'fixture', id: 'test', name: 'Fixture' };
  service.runtime = {
    ...emptyRuntime(),
    sessionId: 'one',
    connected: true,
    status: 'completed',
    approvalMode: 'auto',
    model,
  };
  const calls: { type: string; params: any }[] = [];
  const rpc = {
    closed: false,
    async request(type: string, params?: any): Promise<any> {
      calls.push({ type, params });
      if (type === 'prompt') return { disposition: 'started' };
      if (type === 'get_state') return { model, isStreaming: false, pendingMessageCount: 0 };
      if (type === 'get_messages') return { messages: service.runtime.messages };
      if (type === 'get_session_stats') return { tokens: { total: 0 } };
      throw new Error('Unexpected command ' + type);
    },
  };
  const internal = service as unknown as {
    rpc: typeof rpc | undefined;
    retryNotice?: number;
    onEvent(event: any): void;
    ensureConnected(id: string): Promise<void>;
    resetSession(id: string, cwd: string): void;
    unsafeExit: boolean;
  };
  internal.rpc = rpc;
  t.after(async () => {
    internal.rpc = undefined;
    service.runtime.status = 'idle';
    await service.dispose();
  });
  const event = (record: any) => internal.onEvent(record);
  const retry = () =>
    event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'Connection error.' });
  const notice = (message: string) => event({ type: 'extension_ui_request', method: 'notify', message });
  return { service, internal, rpc, calls, event, retry, notice, store };
}

function interrupted(f: ReturnType<typeof fixture>) {
  f.service.runtime.connected = false;
  f.service.runtime.status = 'interrupted';
  f.service.runtime.crash = {
    cleanup: 'confirmed',
    code: 1,
    signal: null,
    log: [],
    at: Date.now(),
    repeated: false,
  };
  f.store.session('one').draft = 'unsent recovered draft';
}

test('a new run clears failed retry notices before its first published starting state', async (t) => {
  const f = fixture(t);
  f.retry();
  f.event({ type: 'auto_retry_end', success: false, finalError: 'Connection error.' });
  f.service.runtime.status = 'error';
  assert.match(f.service.runtime.notices[0], /^重试失败/);
  let view = emptyRuntime();
  const starting: string[][] = [];
  f.service.on('runtimePatch', (patch: RuntimePatch) => {
    view = applyRuntimePatch(view, patch);
    if (view.status === 'starting') starting.push([...view.notices]);
  });
  await f.service.send('one', 'next normal request', [], 'steer');
  assert.deepEqual(f.service.runtime.notices, []);
  assert.deepEqual(starting, [[]]);
  assert.deepEqual(view.notices, []);
  assert.equal(f.service.runtime.retry, undefined);
  assert.equal(f.internal.retryNotice, undefined);
});

for (const status of ['idle', 'completed', 'stopped', 'error', 'interrupted'] as const)
  test(`a new run retires ${status} notices and their old retry index`, async (t) => {
    const f = fixture(t);
    f.service.runtime.status = status;
    f.service.runtime.notices = ['old extension warning', 'old retry outcome'];
    // Even a stale index must never overwrite a notice from the new run.
    f.internal.retryNotice = 1;
    await f.service.send('one', 'next request', [], 'steer');
    assert.deepEqual(f.service.runtime.notices, []);
    f.notice('new extension warning');
    f.retry();
    f.event({ type: 'auto_retry_end', success: true });
    assert.deepEqual(f.service.runtime.notices, ['new extension warning']);
    assert.equal(f.service.runtime.notifications?.at(-1)?.text, '连接已恢复');
  });

for (const mode of ['steer', 'followUp'] as const)
  test(`${mode} during an active run preserves its notices and retry updates`, async (t) => {
    const f = fixture(t);
    f.notice('current extension warning');
    f.retry();
    const notices = f.service.runtime.notices;
    const retry = f.service.runtime.retry;
    await f.service.send('one', 'queued request', [], mode);
    assert.equal(f.service.runtime.notices, notices);
    assert.equal(f.service.runtime.retry, retry);
    assert.equal(f.calls.find((call) => call.type === 'prompt')?.params.streamingBehavior, mode);
    f.event({ type: 'agent_start' });
    assert.match(notices[1], /^正在重试/);
    f.event({ type: 'auto_retry_end', success: true });
    assert.deepEqual(notices, ['current extension warning']);
    assert.equal(f.service.runtime.notifications?.at(-1)?.text, '连接已恢复');
    f.retry();
    f.event({ type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' });
    f.event({ type: 'agent_settled', aborted: true });
    assert.equal(f.service.runtime.status, 'stopped');
    assert.equal(notices.length, 2, 'a cancelled retry remains visible in the current run');
    assert.match(notices[1], /^重试已取消/);
  });

test('prompt events and a failed prompt retain only the new run notices', async (t) => {
  const f = fixture(t);
  f.notice('old warning');
  const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (type, params) => {
    if (type === 'prompt') {
      f.notice('new prompt warning');
      f.retry();
      throw new Error('prompt failed');
    }
    return request(type, params);
  };
  await assert.rejects(f.service.send('one', 'new request', [], 'steer'), /prompt failed/);
  assert.equal(f.service.runtime.status, 'error');
  assert.equal(f.service.runtime.notices.length, 2);
  assert.equal(f.service.runtime.notices[0], 'new prompt warning');
  assert.match(f.service.runtime.notices[1], /^重试已中断/);
  assert.equal(f.service.runtime.retry, undefined);
});

for (const sessionId of ['one', 'two'])
  test(`a new connection for ${sessionId} preserves startup notices without leaking the old log`, async (t) => {
    const f = fixture(t);
    f.notice('previous session warning');
    f.internal.ensureConnected = async (id) => {
      const model = f.service.runtime.model;
      f.internal.resetSession(id, '/fixture');
      Object.assign(f.service.runtime, { model, connected: true, approvalMode: 'auto' });
      f.notice('new connection warning');
    };
    await f.service.send(sessionId, 'new request', [], 'steer');
    assert.equal(f.service.runtime.sessionId, sessionId);
    assert.deepEqual(f.service.runtime.notices, ['new connection warning']);
    f.retry();
    f.event({ type: 'auto_retry_end', success: false, finalError: 'Connection error.' });
    assert.equal(f.service.runtime.notices[0], 'new connection warning');
    assert.match(f.service.runtime.notices[1], /^重试失败/);
  });

test('rejected input does not discard the completed run log', async (t) => {
  const f = fixture(t);
  f.notice('completed warning');
  await assert.rejects(f.service.send('one', ' ', [], 'steer'), /请输入/);
  assert.deepEqual(f.service.runtime.notices, ['completed warning']);
  for (const status of ['running', 'waiting', 'compacting', 'starting'] satisfies RunStatus[]) {
    f.service.runtime.status = status;
    await f.service.send('one', 'queued request', [], 'followUp');
    assert.deepEqual(f.service.runtime.notices, ['completed warning']);
  }
});

for (const continuation of [undefined, 'edited continuation'])
  test(`crash recovery ${continuation ? 'with a continuation' : 'without sending'} keeps startup notices`, async (t) => {
    const f = fixture(t);
    interrupted(f);
    f.notice('old run warning');
    let connects = 0;
    f.internal.ensureConnected = async (id) => {
      connects++;
      if (f.service.runtime.connected) return;
      const model = f.service.runtime.model;
      f.internal.resetSession(id, '/fixture');
      Object.assign(f.service.runtime, { model, connected: true, approvalMode: 'auto', crash: undefined });
      f.notice('reconnected extension warning');
    };
    await f.service.recover('one', continuation);
    assert.deepEqual(f.service.runtime.notices, ['reconnected extension warning']);
    assert.equal(connects, 1, 'the continuation must share the reconnect boundary');
    const prompts = f.calls.filter((call) => call.type === 'prompt');
    assert.equal(prompts.length, continuation ? 1 : 0);
    if (continuation) assert.equal(prompts[0].params.message, continuation);
    assert.equal(f.store.session('one').draft, 'unsent recovered draft');
  });

test('invalid or cancelled recovery never sends a continuation or clears the draft', async (t) => {
  const f = fixture(t);
  interrupted(f);
  let connects = 0;
  f.internal.ensureConnected = async () => {
    connects++;
  };
  await assert.rejects(f.service.recover('one', ' '), /请填写继续任务/);
  await assert.rejects(f.service.recover('one', 'x'.repeat(1024 * 1024 + 1)), /消息超过 1 MiB/);
  const recovery = f.service.recover('one', 'cancelled continuation');
  f.internal.rpc = undefined;
  await f.service.forceStop();
  await assert.rejects(recovery, /任务已取消/);
  assert.equal(connects, 0);
  assert.equal(f.calls.filter((call) => call.type === 'prompt').length, 0);
  assert.equal(f.store.session('one').draft, 'unsent recovered draft');
});

test('unsafe tool cleanup still blocks recovery with or without a continuation', async (t) => {
  const f = fixture(t);
  interrupted(f);
  f.internal.unsafeExit = true;
  for (const continuation of [undefined, 'must not run'])
    await assert.rejects(f.service.recover('one', continuation), /无法确认本会话启动的命令已结束/);
  assert.equal(f.calls.filter((call) => call.type === 'prompt').length, 0);
  assert.equal(f.store.session('one').draft, 'unsent recovered draft');
});

for (const outcome of ['failed', 'cancelled', 'interrupted'] as const)
  test(`a new run clears a ${outcome} retry and keeps successful recovery toast-only`, async (t) => {
    const f = fixture(t);
    f.retry();
    if (outcome === 'interrupted') {
      const internal = f.service as unknown as { status(status: RunStatus): void };
      internal.status('interrupted');
    } else {
      f.event({
        type: 'auto_retry_end',
        success: false,
        finalError: outcome === 'cancelled' ? 'Retry cancelled' : 'Connection error.',
      });
      f.service.runtime.status = outcome === 'cancelled' ? 'stopped' : 'error';
    }
    assert.equal(f.service.runtime.notices.length, 1);
    await f.service.send('one', 'next normal request', [], 'steer');
    assert.deepEqual(f.service.runtime.notices, []);
    assert.equal(f.internal.retryNotice, undefined);
    f.retry();
    f.event({ type: 'auto_retry_end', success: true });
    assert.deepEqual(f.service.runtime.notices, []);
    assert.equal(f.service.runtime.notifications?.at(-1)?.text, '连接已恢复');
  });
