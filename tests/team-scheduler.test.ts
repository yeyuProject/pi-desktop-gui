import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { TeamService } from '../electron/team';
import type { AgentService } from '../electron/agent';
import type { Workspace } from '../electron/workspace';
import { emptyRuntime } from '../shared/types';
import { validateTeamResult } from '../shared/team';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-scheduler-'));
  const store = new Store(directory);
  await store.load();
  store.state.settings.agentDir = path.join(directory, 'agent');
  store.state.settings.team.concurrency = 2;
  const lead = store.createSession();
  lead.teamEnabled = true;
  lead.cwd = directory;
  const agents = new Map<string, ReturnType<typeof fakeAgent>>();
  function fakeAgent(id: string) {
    const runtime = emptyRuntime();
    const calls = { sends: 0, stops: 0, forced: 0, logs: [] as unknown[] };
    let cleanup: Promise<void> = Promise.resolve();
    let unsafe = false;
    return {
      runtime,
      calls,
      setCleanup: (value: Promise<void>) => {
        cleanup = value;
      },
      setUnsafe: (value: boolean) => {
        unsafe = value;
      },
      async send() {
        calls.sends++;
        runtime.sessionId = id;
        runtime.status = 'running';
        team.observe(id, runtime);
      },
      async stop() {
        calls.stops++;
        runtime.status = 'stopped';
        team.observe(id, runtime);
      },
      async forceStop() {
        calls.forced++;
        unsafe = false;
        runtime.status = 'stopped';
        team.observe(id, runtime);
      },
      async waitTeamIdle() {
        await cleanup;
        this.assertCommandsStopped();
      },
      assertCommandsStopped() {
        if (unsafe) throw new Error('尚未确认命令停止');
      },
      logTeamError: (error: unknown) => calls.logs.push(error),
      async teamWindDown() {},
      publish() {},
    };
  }
  const get = (id: string) => {
    let agent = agents.get(id);
    if (!agent) {
      agent = fakeAgent(id);
      agents.set(id, agent);
    }
    return agent;
  };
  const team = new TeamService(store, { linkTeamMember() {} } as unknown as Workspace, {
    get: (id) => get(id) as unknown as AgentService,
    changed() {},
    publish() {},
  });
  t.after(async () => {
    await team.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const dispatch = (names: string[], leadId = lead.id, role = 'scout', goalRemaining?: number) =>
    team.handle(
      leadId,
      {
        action: 'dispatch',
        goalRemaining,
        toolCallId: crypto.randomUUID(),
        request: { members: names.map((name) => ({ name, role, task: '验证调度' })) },
      },
      () => true,
    );
  return { team, store, lead, get, dispatch };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'team scheduler timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('global slots cover multiple leaders and remain reserved through checkpoint cleanup', async (t) => {
  const { team, store, lead, get, dispatch } = await fixture(t);
  const other = store.createSession();
  other.teamEnabled = true;
  other.cwd = lead.cwd;
  const first = dispatch(['甲', '乙']);
  await until(() => store.state.sessions.filter((s) => s.team && get(s.id).calls.sends === 1).length === 2);
  const second = dispatch(['丙'], other.id);
  await until(() => store.state.sessions.filter((s) => s.team).length === 3);
  const member = store.state.sessions.find((s) => s.team?.name === '甲')!;
  const queued = store.state.sessions.find((s) => s.team?.name === '丙')!;
  assert.equal(get(queued.id).calls.sends, 0);
  assert.throws(() => team.assertMayConnect(queued.id), /排队/);
  const cleanup = gate();
  get(member.id).setCleanup(cleanup.promise);
  get(member.id).runtime.status = 'completed';
  team.observe(member.id, get(member.id).runtime);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(get(queued.id).calls.sends, 0);
  assert.throws(() => team.assertMaySend(member.id), /尚未收尾/);
  cleanup.resolve();
  await until(() => get(queued.id).calls.sends === 1);
  await Promise.all([team.stopLead(lead.id), team.stopLead(other.id)]);
  validateTeamResult(await first);
  validateTeamResult(await second);
  assert.equal(team.active, false);
});

test('pending initial persistence cannot bypass the queued connection and send guards', async (t) => {
  const { team, store, lead, get, dispatch } = await fixture(t);
  const saving = gate();
  const save = store.save.bind(store);
  t.mock.method(store, 'save', async () => {
    await saving.promise;
    await save();
  });
  const result = dispatch(['尚未保存']);
  try {
    await until(() => store.state.sessions.some((s) => s.team));
    const member = store.state.sessions.find((s) => s.team)!;
    assert.equal(team.owns(member.id), false);
    assert.equal(get(member.id).calls.sends, 0);
    assert.throws(() => team.assertMayConnect(member.id), /排队/);
    assert.throws(() => team.assertMaySend(member.id), /排队/);
  } finally {
    saving.resolve();
  }
  await until(() => store.state.sessions.some((s) => s.team && get(s.id).calls.sends === 1));
  await team.stopLead(lead.id);
  validateTeamResult(await result);
});

test('failed persistence after a member settles returns a recoverable result, not a hung dispatch', async (t) => {
  const { team, store, lead, get, dispatch } = await fixture(t);
  const result = dispatch(['保存失败']);
  await until(() => store.state.sessions.some((s) => s.team?.name === '保存失败'));
  const member = store.state.sessions.find((s) => s.team)!;
  await until(() => get(member.id).calls.sends === 1);
  t.mock.method(store, 'save', async () => {
    throw new Error('磁盘空间不足');
  });
  await team.stopLead(lead.id);
  const value = await result;
  validateTeamResult(value);
  assert.match(value.members[0].warning!, /磁盘空间不足/);
  assert.equal(team.active, false);
});

test('creation save failure leaves no queued process and no active dispatch', async (t) => {
  const { team, store, get, dispatch } = await fixture(t);
  t.mock.method(store, 'save', async () => {
    throw new Error('磁盘空间不足');
  });
  await assert.rejects(dispatch(['未保存']), /磁盘空间不足/);
  const member = store.state.sessions.find((s) => s.team)!;
  assert.equal(member.team!.status, 'interrupted');
  assert.equal(get(member.id).calls.sends, 0);
  assert.equal(team.active, false);
});

test('unsafe command cleanup retains the writer slot until forced stop confirms termination', async (t) => {
  const { team, store, lead, get, dispatch } = await fixture(t);
  const result = dispatch(['写甲', '写乙'], lead.id, 'worker');
  await until(() => store.state.sessions.filter((s) => s.team).length === 2);
  const first = store.state.sessions.find((s) => s.team?.name === '写甲')!;
  const queued = store.state.sessions.find((s) => s.team?.name === '写乙')!;
  await until(() => get(first.id).calls.sends === 1);
  get(first.id).setUnsafe(true);
  get(first.id).runtime.status = 'completed';
  team.observe(first.id, get(first.id).runtime);
  await until(() => get(first.id).calls.logs.length > 0);
  assert.equal(team.active, true);
  assert.equal(get(queued.id).calls.sends, 0);
  await team.stopLead(lead.id, true, false, true);
  const value = await result;
  validateTeamResult(value);
  assert.equal(get(first.id).calls.forced, 1);
  assert.equal(get(queued.id).calls.sends, 0);
  assert.ok(value.members.every((m) => m.status === 'stopped'));
});

test('zero Goal budget starts no member, and stale cancellation cannot stop a later dispatch', async (t) => {
  const { team, store, lead, get, dispatch } = await fixture(t);
  const zero = await dispatch(['无剩余额度'], lead.id, 'scout', 0);
  validateTeamResult(zero);
  assert.equal(zero.members[0].status, 'budget_limited');
  assert.equal(get(zero.members[0].sessionId).calls.sends, 0);
  const result = dispatch(['当前分派']);
  await until(() => store.state.sessions.some((s) => s.team?.name === '当前分派'));
  const current = store.state.sessions.find((s) => s.team?.name === '当前分派')!;
  await until(() => get(current.id).calls.sends === 1);
  await team.cancelDispatch(lead.id, zero.toolCallId);
  assert.equal(get(current.id).calls.stops, 0);
  team.usage(current.id, { tokens: 1.5, billedTokens: 2, cost: 0, budgetLimited: false });
  team.usage(current.id, { tokens: 10, billedTokens: 12, cost: 0, budgetLimited: false });
  team.usage(current.id, { tokens: 1, billedTokens: 2, cost: 0, budgetLimited: false });
  await team.cancelDispatch(lead.id, current.team!.toolCallId);
  const completed = await result;
  validateTeamResult(completed);
  assert.equal(completed.members[0].tokens, 10);
  assert.equal(completed.cancelled, true);
});

test('dispose waits for final checkpoint cleanup and marks queued members interrupted', async (t) => {
  const { team, store, get, dispatch } = await fixture(t);
  store.state.settings.team.concurrency = 1;
  const result = dispatch(['正在结束', '未开始']);
  await until(() => store.state.sessions.filter((s) => s.team).length === 2);
  const first = store.state.sessions.find((s) => s.team?.name === '正在结束')!;
  await until(() => get(first.id).calls.sends === 1);
  const cleanup = gate();
  get(first.id).setCleanup(cleanup.promise);
  let disposed = false;
  const stopping = team.dispose().then(() => {
    disposed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(disposed, false);
  cleanup.resolve();
  await stopping;
  const value = await result;
  validateTeamResult(value);
  assert.ok(value.members.every((m) => m.status === 'interrupted'));
  assert.equal(team.active, false);
});
