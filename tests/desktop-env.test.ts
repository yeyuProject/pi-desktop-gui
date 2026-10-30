import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installDesktopBridge } from './support/bridge-fixture';
import { desktopTestEnv } from './support/desktop-env';

test('bridge fixtures ignore inherited desktop switches, restore them and allow explicit checkpoints', async (t) => {
  const keys = ['PI_DESKTOP_APPROVAL', 'PI_DESKTOP_CHECKPOINTS', 'PI_DESKTOP_DATA_DIR'] as const;
  const before = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    }),
  );
  process.env.PI_DESKTOP_APPROVAL = 'readonly';
  process.env.PI_DESKTOP_CHECKPOINTS = '1';
  process.env.PI_DESKTOP_DATA_DIR = 'inherited-directory';
  const env = desktopTestEnv({ PI_DESKTOP_DATA_DIR: 'fixture-directory' });
  assert.equal(env.PI_DESKTOP_DATA_DIR, 'fixture-directory');
  assert.equal(env.PI_DESKTOP_APPROVAL, undefined);
  assert.equal(env.PI_DESKTOP_CHECKPOINTS, undefined);
  for (const checkpoints of [false, true]) {
    let toolCall!: (...args: any[]) => Promise<unknown>;
    installDesktopBridge(
      {
        on(name: string, handler: typeof toolCall) {
          if (name === 'tool_call') toolCall = handler;
        },
        registerCommand() {},
        registerTool() {},
      } as unknown as ExtensionAPI,
      checkpoints ? { PI_DESKTOP_CHECKPOINTS: '1' } : {},
    );
    let requests = 0;
    assert.equal(
      await toolCall(
        { toolName: 'write', input: { path: 'fixture.txt' } },
        {
          ui: {
            input: async () => {
              requests++;
              return '{"ok":true}';
            },
          },
        },
      ),
      undefined,
    );
    assert.equal(requests, checkpoints ? 1 : 0);
    assert.deepEqual(
      keys.map((key) => process.env[key]),
      ['readonly', '1', 'inherited-directory'],
    );
  }
  assert.throws(() =>
    installDesktopBridge({
      on() {
        throw new Error('fixture failure');
      },
    } as unknown as ExtensionAPI),
  );
  assert.deepEqual(
    keys.map((key) => process.env[key]),
    ['readonly', '1', 'inherited-directory'],
  );
});
