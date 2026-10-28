import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyPiVersion, PI_INSTALL_COMMAND, VERIFIED } from '../shared/pi-version';
import { detectEnvironment } from '../electron/environment';
import { defaultSettings } from '../electron/store';
import { validateRpcResult, validateBridgeResult, sessionStats } from '../electron/pi/protocol';
import { PiRpc } from '../electron/rpc';
import { AgentService } from '../electron/agent';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';

test('the development Pi dependency matches the verified regression baseline', async () => {
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], VERIFIED);
});

test('version policy allows every recognized version without claiming it has been verified', () => {
  for (const [version, expected] of [
    ['1.4.0', 'verified'],
    ['1.4.1', 'unverified'],
    ['1.4.0-rc.1', 'unverified'],
    ['1.4.0+build.1', 'unverified'],
    ['1.1.0', 'unverified'],
    ['1.1.1', 'unverified'],
    ['1.1.10', 'unverified'],
    ['1.1.0-rc.1', 'unverified'],
    ['1.1.2+build.1', 'unverified'],
    ['1.0.99', 'unverified'],
    ['0.99.999', 'unverified'],
    ['1.2.0', 'unverified'],
    ['1.10.0', 'unverified'],
    ['2.0.0', 'unverified'],
    ['2.0.0-rc.1', 'unverified'],
    ['', 'unknown'],
    ['banana', 'unknown'],
    ['1.1', 'unknown'],
    ['01.1.0', 'unknown'],
    ['1.1.9007199254740992', 'unknown'],
  ])
    assert.equal(classifyPiVersion(version), expected, version);
});

test('versioned CLI entry is admitted or rejected by environment detection', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-version-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [version, supported, compatibility] of [
    ['1.4.0', true, 'verified'],
    ['1.1.0', true, 'unverified'],
    ['1.1.1', true, 'unverified'],
    ['1.2.0', true, 'unverified'],
    ['2.0.0', true, 'unverified'],
    ['0.99.999', true, 'unverified'],
    ['no version', false, 'unknown'],
  ] as const) {
    await fs.writeFile(path.join(dir, 'fixture-version.txt'), version);
    const result = await detectEnvironment({
      ...defaultSettings,
      agentDir: dir,
      nodePath: process.execPath,
      piPath: path.resolve('tests/support/versioned-pi.mjs'),
    });
    assert.equal(result.supported, supported);
    assert.equal(result.compatibility, compatibility);
    if (!supported) assert.ok(result.errors.some((error) => error.includes(PI_INSTALL_COMMAND)));
  }
});

test('documented RPC fields are checked at the adapter, without guessing renamed fields', () => {
  assert.doesNotThrow(() =>
    validateRpcResult('get_state', {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      addedInPatch: true,
    }),
  );
  for (const [command, value] of [
    ['get_state', { streaming: false }],
    ['get_messages', { messages: [{ role: 'user' }] }],
    ['get_available_models', { models: [{ id: 'missing provider' }] }],
    ['get_available_thinking_levels', { thinkingLevels: ['off'] }],
    ['get_commands', { commands: [null] }],
  ] as const)
    assert.throws(() => validateRpcResult(command, value), /不兼容/);
  assert.throws(
    () => validateBridgeResult('options', { protocolVersion: 999, autoRetry: true, approvalMode: 'auto' }),
    /不兼容/,
  );
  assert.deepEqual(
    sessionStats({
      tokens: { total: 12 },
      cost: 0.1,
      contextUsage: { tokens: null, percent: null, contextWindow: 32768 },
    }),
    {
      tokens: 12,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      cost: 0.1,
      contextPercent: undefined,
      contextTokens: undefined,
      contextWindow: 32768,
    },
  );
  assert.throws(() => sessionStats({ tokens: { total: '12' } }), /不兼容/);
});

test('a missing desktop extension never sends its internal slash command to the model', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bridge-check-'));
  const rpc = new PiRpc();
  t.after(async () => {
    await rpc.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'control.json'), JSON.stringify({ noBridge: true }));
  rpc.start({ command: process.execPath, args: [path.resolve('tests/support/fixture-pi.mjs')] }, dir, [], {
    PI_CODING_AGENT_DIR: dir,
  });
  await assert.rejects(rpc.bridge('options'), /扩展未加载/);
  const commands = (await fs.readFile(path.join(dir, 'commands.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map((command) => command.type),
    ['get_commands'],
  );
});

test('regular connections and model probes allow unverified Pi but reject an unrecognized entry', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-probe-version-'));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  Object.assign(store.state.settings, {
    agentDir: dir,
    nodePath: process.execPath,
    piPath: path.resolve('tests/support/versioned-pi.mjs'),
    provider: 'fixture',
    modelId: 'test',
  });
  await store.save();
  await fs.writeFile(path.join(dir, 'fixture-version.txt'), '1.2.0');
  const service = new AgentService(store, new Workspace(dir));
  t.after(async () => {
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await service.connect(session.id);
  assert.equal(service.runtime.connected, true);
  await service.disconnect();
  const result = await service.testConnection(session.id);
  assert.match(result.text, /完成/);
  const commands = await fs.readFile(path.join(dir, 'commands.jsonl'), 'utf8');
  assert.ok(commands.split('\n').some((line) => line && JSON.parse(line).message === 'Reply with only OK.'));
  await fs.writeFile(path.join(dir, 'fixture-version.txt'), 'no version');
  // This fixture reads its version from data rather than from its executable.
  // An explicit check refreshes the same cache that a changed CLI file invalidates.
  await detectEnvironment(store.state.settings);
  await assert.rejects(service.connect(session.id), /未检测到可识别的 Pi 版本/);
  await assert.rejects(service.testConnection(session.id), /未检测到可识别的 Pi 版本/);
  assert.equal(await fs.readFile(path.join(dir, 'commands.jsonl'), 'utf8'), commands);
});

test('a process exit during optional session statistics cannot become a successful connection', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bind-exit-'));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  Object.assign(store.state.settings, {
    agentDir: dir,
    nodePath: process.execPath,
    piPath: path.resolve('tests/support/fixture-pi.mjs'),
    provider: 'fixture',
    modelId: 'test',
  });
  await fs.writeFile(
    path.join(dir, 'control.json'),
    JSON.stringify({ sessionName: session.title, exitOnStats: true }),
  );
  const service = new AgentService(store, new Workspace(dir));
  t.after(async () => {
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(service.connect(session.id), /Pi 在加载会话时已退出/);
  assert.equal(service.runtime.connected, false);
  assert.equal(service.runtime.status, 'interrupted');
  assert.equal(service.runtime.crash?.code, 9);
  assert.equal(service.lastSwitch, undefined);
});
