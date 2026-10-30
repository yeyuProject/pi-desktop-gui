import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadSummary, formatBytes, formatRemaining, type UpdateState } from '../shared/app-update';

test('byte sizes retain one decimal and use the total quantity unit for progress pairs', () => {
  for (const [bytes, expected] of [
    [0, '0.0 KB'],
    [1023, '1.0 KB'],
    [1024, '1.0 KB'],
    [0.99 * 1024 ** 2, '1013.8 KB'],
    [1024 ** 2, '1.0 MB'],
    [100 * 1024 ** 2, '100.0 MB'],
    [122183449, '116.5 MB'],
    [1024 ** 3, '1.0 GB'],
  ] as const)
    assert.equal(formatBytes(bytes), expected);
  assert.equal(formatBytes(980 * 1024, 1.1 * 1024 ** 2), '1.0 MB');
  assert.equal(formatBytes(500 * 1024 ** 2, 2 * 1024 ** 3), '0.5 GB');
});

test('ETA uses five-second ceilings below a minute, then minutes and hours', () => {
  for (const [ms, expected] of [
    [0, '剩余不到 5 秒'],
    [4999, '剩余不到 5 秒'],
    [5000, '剩余约 5 秒'],
    [18000, '剩余约 20 秒'],
    [59999, '剩余约 60 秒'],
    [60000, '剩余约 1 分钟'],
    [61000, '剩余约 2 分钟'],
    [3599999, '剩余约 60 分钟'],
    [3600000, '剩余约 1 小时 0 分'],
    [3660001, '剩余约 1 小时 2 分'],
  ] as const)
    assert.equal(formatRemaining(ms), expected);
});

test('download badge omits unknown or stalled ETA and distinguishes connection and verification', () => {
  const update: UpdateState = {
    state: 'downloading',
    currentVersion: '0.14.58',
    installation: 'nsis',
    mode: 'auto',
    enabled: true,
    installing: false,
    progress: 42.9,
    download: { transferred: 429, total: 1000, phase: 'transferring', differential: false, stalled: false },
  };
  assert.equal(downloadSummary(update), '正在下载更新 42%');
  update.download!.remainingMs = 18000;
  assert.equal(downloadSummary(update), '正在下载更新 42% · 剩余约 20 秒');
  update.download!.stalled = true;
  assert.equal(downloadSummary(update), '等待网络响应…');
  update.download!.stalled = false;
  update.download!.phase = 'connecting';
  assert.equal(downloadSummary(update), '正在连接…');
  update.download!.phase = 'verifying';
  assert.equal(downloadSummary({ ...update, installation: 'mac' }), '正在校验更新…');
});
