import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminateProcessTree } from '../electron/platform';
import { checkPiUpdate, piUpdateBlockedReason, piUpdateFailure, runPiUpdate } from '../electron/pi-update';
import type { Environment } from '../shared/types';

const environment: Environment = {
  piPath: '/pi/cli.js',
  version: '1.4.0',
  supported: true,
  compatibility: 'verified',
  agentDir: '/agent',
  authExists: false,
  modelsExist: false,
  errors: [],
};

test('Pi update check compares stable, prerelease and unrecognized versions', async (t) => {
  const previous = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    if (previous !== undefined) process.env.PI_OFFLINE = previous;
  });
  for (const [latest, newer] of [
    ['1.4.0', false],
    ['1.3.9', false],
    ['1.5.0', true],
    ['1.4.0-rc.1', false],
    ['1.5.0-rc.1', true],
    ['1.4.0+other', false],
    ['nightly', true],
  ] as const) {
    const result = await checkPiUpdate('1.4.0', '0.14.82', async (url, options) => {
      assert.equal(url, 'https://pi.dev/api/latest-version');
      assert.deepEqual(options.headers, {
        accept: 'application/json',
        'User-Agent': 'pi-desktop/0.14.82 pi/1.4.0',
      });
      return Response.json({ version: latest, packageName: 'pi', note: '说明' });
    });
    assert.equal(result?.latest, latest);
    assert.equal(result?.newer, newer);
    assert.equal(result?.note, '说明');
  }
  assert.equal(
    (await checkPiUpdate('nightly', '0.14.82', async () => Response.json({ version: '1.4.0' })))?.newer,
    true,
  );
  await assert.rejects(
    checkPiUpdate('1.4.0', '0.14.82', async () => new Response('<html>')),
    /JSON/,
  );
  await assert.rejects(
    checkPiUpdate('1.4.0', '0.14.82', async () => Response.json(null)),
    /未返回 Pi 版本号/,
  );
  await assert.rejects(
    checkPiUpdate('1.4.0', '0.14.82', async () => new Response(null, { status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    checkPiUpdate('1.4.0', '0.14.82', async () => {
      throw new TypeError('fetch failed');
    }),
    /无法连接/,
  );
  await assert.rejects(
    checkPiUpdate(
      '1.4.0',
      '0.14.82',
      async (_url, { signal }) => {
        return await new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('signal did not time out')), 1000);
          signal!.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal!.reason);
            },
            { once: true },
          );
        });
      },
      20,
    ),
    /超时/,
  );
  process.env.PI_OFFLINE = '1';
  assert.equal(
    await checkPiUpdate('1.4.0', '0.14.82', async () => assert.fail('offline check made a request')),
    undefined,
  );
});

test('Pi update preconditions are checked in the specified order', () => {
  const dev = { ...environment, piUpdateRestriction: 'development' as const };
  assert.match(piUpdateBlockedReason(true, true, dev), /等待所有任务/);
  assert.match(piUpdateBlockedReason(false, true, dev), /桌面端正在更新或退出/);
  assert.match(piUpdateBlockedReason(false, false, dev), /开发环境/);
  assert.match(
    piUpdateBlockedReason(false, false, { ...environment, piUpdateRestriction: 'standalone' }),
    /不支持自动更新/,
  );
});

test('Pi must exit cleanly and the newly detected version must reach the target', () => {
  const updated = { ...environment, version: '1.5.1' };
  assert.equal(piUpdateFailure(0, '1.4.0', '1.5.0', updated), '');
  assert.match(piUpdateFailure(1, '1.4.0', '1.5.0', updated), /退出（代码 1）/);
  assert.match(piUpdateFailure(1, '1.4.0', '1.5.0', environment), /退出（代码 1）/);
  assert.match(piUpdateFailure(0, '1.4.0', '1.5.0', environment), /多个 Pi 安装.*\/pi\/cli\.js/);
  assert.match(piUpdateFailure(0, '1.4.0', '1.5.0', { ...updated, version: '1.5.0-rc.1' }), /低于目标版本/);
  assert.match(piUpdateFailure(0, '1.4.0', '1.5.0', { ...updated, version: undefined }), /未检测到/);
});

test('Pi update timeout stops the process before rejecting', async () => {
  const lines: string[] = [];
  const command = {
    command: process.execPath,
    args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)', '--'],
  };
  await assert.rejects(
    runPiUpdate(
      command,
      process.env,
      (line) => lines.push(line),
      (error) => assert.fail(String(error)),
      1500,
    ),
    /已停止更新/,
  );
  assert.equal(lines.length, 1);
  assert.throws(() => process.kill(Number(lines[0]), 0), { code: 'ESRCH' });
});

test('a failed stop is reported while the real update process is alive and can be retried', async () => {
  const lines: string[] = [];
  let notifyFailure!: (retry: () => void) => void;
  const failed = new Promise<() => void>((resolve) => {
    notifyFailure = resolve;
  });
  let attempts = 0;
  const running = runPiUpdate(
    {
      command: process.execPath,
      args: ['-e', 'console.log(process.pid); setTimeout(() => {}, 10000)', '--'],
    },
    process.env,
    (line) => lines.push(line),
    (_cause, retry) => {
      assert.ok(retry);
      notifyFailure(retry);
    },
    1000,
    async (pid) => {
      if (++attempts === 1) throw new Error('stop denied for this attempt');
      await terminateProcessTree(pid);
    },
  );
  const stopped = assert.rejects(running, /更新 Pi 超时/);
  const retry = await failed;
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => process.kill(Number(lines[0]), 0));
  retry();
  await stopped;
  assert.equal(attempts, 2);
  assert.throws(() => process.kill(Number(lines[0]), 0), { code: 'ESRCH' });
});

test('update output hides private key blocks independently on stdout and stderr', async () => {
  const lines: string[] = [];
  const script = `
    console.log('starting -----BEGIN RSA PRIVATE KEY-----');
    console.log('stdout key body');
    setTimeout(() => {
      console.error('visible stderr');
      console.error('-----BEGIN PRIVATE KEY-----');
      console.error('stderr key body');
      setTimeout(() => {
        console.log('-----END RSA PRIVATE KEY-----');
        console.log('visible stdout');
        console.error('unterminated stderr key body');
      }, 50);
    }, 50);
  `;
  const code = await runPiUpdate(
    { command: process.execPath, args: ['-e', script, '--'] },
    process.env,
    (line) => lines.push(line),
    (error) => assert.fail(String(error)),
  );
  assert.equal(code, 0);
  assert.deepEqual(lines.sort(), ['[已隐藏]', '[已隐藏]', 'visible stderr', 'visible stdout'].sort());
});
