import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../electron/agent';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';
import type { PiRpc } from '../electron/rpc';
import { emptyRuntime, type Runtime } from '../shared/types';

test('overlapping reads cannot roll back usage or cross into a switched session', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-live-stats-'));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  const service = new AgentService(store, new Workspace(dir));
  const responses: ((value: unknown) => void)[] = [];
  const rpc = {
    closed: false,
    request: () => new Promise((resolve) => responses.push(resolve)),
  } as unknown as PiRpc;
  const internal = service as unknown as {
    rpc?: PiRpc;
    readStats(rpc: PiRpc, runtime: Runtime): Promise<void>;
  };
  internal.rpc = rpc;
  service.runtime = { ...emptyRuntime(), sessionId: session.id, status: 'running' };
  t.after(async () => {
    service.runtime.status = 'idle';
    internal.rpc = undefined;
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const result = (total: number) => ({ tokens: { total }, contextUsage: { tokens: total } });
  const first = internal.readStats(rpc, service.runtime);
  const second = internal.readStats(rpc, service.runtime);
  responses[1](result(200));
  await second;
  responses[0](result(100));
  await first;
  assert.equal(service.runtime.stats?.tokens, 200);
  assert.equal(session.stats?.tokens, 200);

  const oldRuntime = service.runtime;
  const stale = internal.readStats(rpc, oldRuntime);
  service.runtime = { ...emptyRuntime(), sessionId: 'other', status: 'idle' };
  responses[2](result(300));
  await stale;
  assert.equal(service.runtime.stats, undefined);
  assert.equal(session.stats?.tokens, 200);
});

test('a burst of message boundaries coalesces statistics requests', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-live-stats-burst-'));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  const service = new AgentService(store, new Workspace(dir));
  const responses: ((value: unknown) => void)[] = [];
  const rpc = {
    closed: false,
    request: () => new Promise((resolve) => responses.push(resolve)),
  } as unknown as PiRpc;
  const internal = service as unknown as { rpc?: PiRpc; refreshLiveStats(): void };
  internal.rpc = rpc;
  service.runtime = { ...emptyRuntime(), sessionId: session.id, status: 'running' };
  t.after(async () => {
    service.runtime.status = 'idle';
    internal.rpc = undefined;
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  internal.refreshLiveStats();
  internal.refreshLiveStats();
  internal.refreshLiveStats();
  assert.equal(responses.length, 1);
  responses[0]({ tokens: { total: 100 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 2);
  responses[1]({ tokens: { total: 200 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.runtime.stats?.tokens, 200);
  assert.equal(responses.length, 2);
});
