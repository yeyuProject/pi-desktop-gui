import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, type Environment, type RunStatus } from '../shared/types';
import { configSaveNotice, piFeatureAvailability } from '../src/lib/pi-features';

const environment: Environment = {
  piPath: '/pi',
  supported: true,
  compatibility: 'verified',
  version: '1.1.0',
  agentDir: '/agent',
  authExists: false,
  modelsExist: false,
  errors: [],
};
const available = {
  runtime: emptyRuntime(),
  environment,
  storage: { writable: true },
  pending: false,
  projectEnabled: true,
};

test('Pi settings are actionable after idle, completion, stop, and recoverable errors', () => {
  for (const status of ['idle', 'completed', 'stopped', 'error', 'interrupted'] as RunStatus[]) {
    const state = piFeatureAvailability({ ...available, runtime: { ...available.runtime, status } });
    assert.equal(state.operationReason, '', status);
    assert.equal(state.engineReason, '', status);
  }
});

test('running work allows reading and saving; only conflicting history actions require idle', () => {
  for (const status of [
    'starting',
    'running',
    'waiting',
    'retrying',
    'compacting',
    'stopping',
  ] as RunStatus[]) {
    const state = piFeatureAvailability({ ...available, runtime: { ...available.runtime, status } });
    assert.equal(state.operationReason, '');
    assert.equal(state.engineReason, '');
    assert.match(state.idleReason, /停止本会话/);
  }
  assert.match(piFeatureAvailability({ ...available, pending: true }).operationReason, /上一项操作/);
  assert.match(piFeatureAvailability({ ...available, storage: { writable: false } }).operationReason, /只读/);
});

test('missing Pi and project trust block engine actions but allow saving personal configuration', () => {
  const missing = piFeatureAvailability({ ...available, environment: { ...environment, supported: false } });
  assert.equal(missing.operationReason, '');
  assert.match(missing.engineReason, /运行环境/);
  const untrusted = piFeatureAvailability({ ...available, projectEnabled: false });
  assert.equal(untrusted.operationReason, '');
  assert.match(untrusted.engineReason, /启用项目/);
  assert.equal(
    piFeatureAvailability({
      ...available,
      environment: { ...environment, compatibility: 'unverified', version: '2.0.0' },
    }).engineReason,
    '',
  );
});

test('save notices distinguish disk persistence from application to Pi', () => {
  assert.match(configSaveNotice({ applied: true }), /已保存并重新连接/);
  const notice = configSaveNotice({ applied: false, warning: '请检查 Pi 入口' });
  assert.match(notice, /配置已保存/);
  assert.match(notice, /尚未应用/);
  assert.match(notice, /检查 Pi 入口/);
});

test('unconfirmed cleanup keeps configuration repair available and blocks conflicting operations', () => {
  for (const cleanup of ['checking', 'unconfirmed'] as const) {
    const state = piFeatureAvailability({
      ...available,
      runtime: {
        ...available.runtime,
        crash: { cleanup, code: 1, signal: null, at: Date.now(), log: [], repeated: false },
      },
    });
    assert.equal(state.operationReason, '');
    assert.match(state.idleReason, /进程恢复/);
  }
});
