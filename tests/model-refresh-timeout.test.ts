import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import desktopBridge from '../electron/pi-bridge';
import { AgentService } from '../electron/agent';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';

test('a slow model refresh aborts after 15 seconds, releases the session and can be retried', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-model-refresh-timeout-'));
  const store = new Store(directory);
  await store.load();
  const session = store.createSession();
  const service = new AgentService(store, new Workspace(directory));
  const internal = service as unknown as { rpc?: unknown };
  t.after(async () => {
    t.mock.timers.reset();
    internal.rpc = undefined;
    await service.dispose();
    await store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let handler!: (encoded: string, ctx: ExtensionCommandContext) => Promise<void>;
  desktopBridge({
    on() {},
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);
  let slow = true;
  let signal!: AbortSignal;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  let result: { error?: string; data?: unknown };
  const ctx = {
    modelRegistry: {
      async refresh(options: { signal: AbortSignal }) {
        signal = options.signal;
        entered();
        if (slow)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        return { aborted: signal.aborted, errors: new Map() };
      },
      getError() {},
    },
    ui: { notify: (message: string) => (result = JSON.parse(message.slice('__PI_DESKTOP__'.length))) },
  } as unknown as ExtensionCommandContext;
  const available = [{ provider: 'fixture', id: 'model', name: 'Model' }];
  internal.rpc = {
    closed: false,
    async bridge(method: string) {
      await handler(Buffer.from(JSON.stringify({ id: 'refresh', method })).toString('base64'), ctx);
      if (result.error) throw new Error(result.error);
      return result.data;
    },
    async request() {
      return { models: available };
    },
  };
  Object.assign(service.runtime, { sessionId: session.id, connected: true, models: available });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refresh = assert.rejects(service.readModels(session.id), /超过 15 秒，已取消/);
  await ready;
  t.mock.timers.tick(14_999);
  assert.equal(signal.aborted, false);
  assert.equal(service.runtime.modelsLoading, true);
  t.mock.timers.tick(1);
  await refresh;
  assert.equal(signal.aborted, true);
  assert.equal(service.runtime.modelsLoading, false);
  assert.equal(service.runtime.models, available);
  assert.equal(service.runtime.connected, true);
  assert.equal(service.hasPendingWork, false);
  slow = false;
  await service.readModels(session.id);
  assert.equal(service.runtime.modelsLoaded, true);
  assert.equal(service.runtime.error, undefined);
  t.mock.timers.tick(15_000);
  assert.equal(signal.aborted, false, 'successful refreshes clear their timeout');
});
