import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrMacAcceptanceHook } from '../scripts/pr-mac-acceptance.mjs';

const pr = { directoryOnly: true, hostPlatform: 'darwin', event: 'pull_request' };
async function fixture(t) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-adhoc-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  for (const dir of ['mac', 'mac-arm64'])
    await fs.mkdir(path.join(outDir, dir, 'Pi Desktop.app'), { recursive: true });
  return {
    outDir,
    artifactPaths: [],
    platformToTargets: new Map([[{ nodeName: 'darwin' }, new Map()]]),
    configuration: { mac: { identity: '-', hardenedRuntime: false } },
  };
}

test('PR acceptance fallback is absent for releases, installers and other platforms', () => {
  for (const override of [
    { directoryOnly: false },
    { hostPlatform: 'win32' },
    { hostPlatform: 'linux' },
    { event: undefined },
    { event: 'push' },
    { event: 'workflow_dispatch' },
    { event: 'pull_request_target' },
  ])
    assert.equal(createPrMacAcceptanceHook({ ...pr, ...override }), undefined);
});

test('PR directory apps use only ad-hoc signing then the existing verification', async (t) => {
  const result = await fixture(t);
  const calls = [];
  const environment = { ...process.env };
  const hook = createPrMacAcceptanceHook(pr, {
    sign: async (options) => {
      calls.push(options.app);
      assert.equal(options.identity, '-');
      assert.equal(options.identityValidation, false);
      assert.equal(options.preAutoEntitlements, false);
      assert.equal(options.preEmbedProvisioningProfile, false);
      assert.equal(options.strictVerify, true);
      assert.equal(options.keychain, undefined);
      assert.deepEqual(options.optionsForFile(), { hardenedRuntime: false, timestamp: 'none' });
    },
    verify: async (value) => {
      assert.equal(value, result);
      assert.equal(calls.length, 2);
      calls.push('strict verification');
      return [];
    },
  });
  assert.deepEqual(await hook(result), []);
  assert.deepEqual(calls, [
    path.join(result.outDir, 'mac', 'Pi Desktop.app'),
    path.join(result.outDir, 'mac-arm64', 'Pi Desktop.app'),
    'strict verification',
  ]);
  assert.deepEqual({ ...process.env }, environment, 'PR markers and signing environment stay unchanged');
});

test('non-ad-hoc configurations and installer artifacts fail before signing', async (t) => {
  const base = await fixture(t);
  const hook = createPrMacAcceptanceHook(pr, {
    sign: async () => assert.fail('must not sign'),
    verify: async () => assert.fail('must not accept'),
  });
  for (const override of [
    { configuration: { mac: { identity: 'Developer ID Application: example', hardenedRuntime: false } } },
    { configuration: { mac: { identity: null, hardenedRuntime: false } } },
    { configuration: { mac: { identity: '-', hardenedRuntime: true } } },
    { artifactPaths: ['Pi Desktop.dmg'] },
    { platformToTargets: new Map([[{ nodeName: 'win32' }, new Map()]]) },
  ])
    await assert.rejects(hook({ ...base, ...override }), /requires an ad-hoc macOS directory build/);
});

for (const failing of ['sign', 'verify']) {
  test(`${failing} errors fail the PR acceptance build`, async (t) => {
    const result = await fixture(t);
    const failure = new Error(`${failing} failed`);
    const hook = createPrMacAcceptanceHook(pr, {
      sign: async () => {
        if (failing === 'sign') throw failure;
      },
      verify: async () => {
        throw failure;
      },
    });
    await assert.rejects(hook(result), (error) => error === failure);
  });
}

test('missing output apps fail rather than bypass strict verification', async (t) => {
  const result = await fixture(t);
  await fs.rm(path.join(result.outDir, 'mac'), { recursive: true });
  await fs.rm(path.join(result.outDir, 'mac-arm64'), { recursive: true });
  const hook = createPrMacAcceptanceHook(pr, { sign: async () => assert.fail('no app') });
  await assert.rejects(hook(result), /produced no macOS application/);
});
