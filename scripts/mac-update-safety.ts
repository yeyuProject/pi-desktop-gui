import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { extractFile } from '@electron/asar';
import { stageMacUpdate, startMacInstaller, runMacInstaller } from '../electron/mac-update';

const exec = promisify(execFile);
export async function testMacUpdateSafety(root: string, source: string, archive: string) {
  const directory = path.join(root, 'safety');
  await fs.mkdir(directory);
  const target = path.join(directory, path.basename(source));
  await exec('/usr/bin/ditto', [source, target]);
  const options = {
    archive,
    target,
    currentVersion: '0.9.0',
    targetVersion: '0.9.1',
    arch: process.arch,
    helperDirectory: path.resolve('dist-electron'),
    receiptDirectory: path.join(root, 'safety-receipts'),
  };
  await fs.mkdir(options.receiptDirectory);
  const contents = (app = target) => fs.readFile(path.join(app, 'Contents/Resources/app.asar'));
  const original = await contents();
  const unchanged = async () => assert.deepEqual(await contents(), original);
  const discard = (plan: { directory: string }) => fs.rm(plan.directory, { recursive: true, force: true });

  await assert.rejects(stageMacUpdate({ ...options, targetVersion: '0.9.2' }), /版本不匹配/);
  await unchanged();
  await assert.rejects(
    stageMacUpdate({ ...options, arch: process.arch === 'arm64' ? 'x64' : 'arm64' }),
    /架构不匹配/,
  );
  await unchanged();
  const linked = path.join(directory, 'Linked.app');
  await fs.symlink(target, linked);
  await assert.rejects(stageMacUpdate({ ...options, target: linked }), /符号链接/);
  await fs.unlink(linked);
  console.log('PASS wrong version, wrong architecture and symlink installation reject before replacement');

  const cancelled = await stageMacUpdate(options);
  await assert.rejects(
    startMacInstaller(cancelled, false, () => false),
    /退出状态已变化/,
  );
  await unchanged();
  await discard(cancelled);
  console.log('PASS a cancelled shutdown cannot commit an acknowledged installer');

  const damaged = await stageMacUpdate(options);
  await fs.appendFile(path.join(damaged.candidate, 'Contents/Resources/app.asar'), 'damage');
  await assert.rejects(startMacInstaller(damaged, false), /签名校验失败/);
  await unchanged();
  await discard(damaged);
  console.log(
    'PASS modification after download is detected by the detached helper, original application unchanged',
  );

  const changed = await stageMacUpdate(options);
  const moved = target + '.moved';
  await fs.rename(target, moved);
  await exec('/usr/bin/ditto', [source, target]);
  await assert.rejects(startMacInstaller(changed, false), /其他更新替换/);
  await unchanged();
  await fs.rm(target, { recursive: true });
  await fs.rename(moved, target);
  await discard(changed);
  console.log(
    'PASS concurrent replacement cancels a stale installer instead of overwriting the changed application',
  );

  const rollback = await stageMacUpdate(options);
  const swap = path.join(rollback.directory, 'mac-update-swap');
  const realSwap = swap + '-real';
  await fs.rename(swap, realSwap);
  // Damage the exchanged candidate once; the second exchange must recover the exact original.
  await fs.writeFile(
    swap,
    `#!/bin/sh\n"${realSwap}" "$@" || exit 1\nif [ ! -f "${swap}.once" ]; then\n touch "${swap}.once"\n printf damage >> "$1/Contents/Resources/app.asar"\nfi\n`,
    { mode: 0o700 },
  );
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => exited.once('exit', resolve));
  await assert.rejects(runMacInstaller(rollback, exited.pid!, false), /签名校验失败/);
  await unchanged();
  await discard(rollback);
  console.log('PASS failed post-exchange validation atomically restores the exact previous application');

  const success = await stageMacUpdate(options);
  const held = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const installing = runMacInstaller(success, held.pid!, false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await unchanged();
    const stopped = new Promise((resolve) => held.once('exit', resolve));
    held.kill();
    await stopped;
    await installing;
    const version = (app: string) =>
      JSON.parse(extractFile(path.join(app, 'Contents/Resources/app.asar'), 'package.json').toString())
        .version;
    assert.equal(version(target), '0.9.1');
    assert.equal(version(success.candidate), '0.9.0');
    assert.deepEqual(await contents(success.candidate), original);
    console.log(
      'PASS running process prevents exchange, clean exit permits it, recoverable backup is byte-identical',
    );
  } finally {
    held.kill();
  }
}
