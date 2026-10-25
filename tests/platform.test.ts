import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { PiRpc } from '../electron/rpc';
import {
  openTerminal,
  pathKey,
  samePath,
  terminalOpen,
  terminalScript,
  validEditor,
} from '../electron/platform';
const exec = promisify(execFile);

async function sandbox() {
  const root = path.resolve('work/tests');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "terminal 中文 ' space-"));
}

async function until(condition: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for test process');
}

async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32')
    await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else process.kill(-child.pid, 'SIGKILL');
  await exited;
}

test('path comparison follows the platform file system', () => {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  assert.equal(samePath('/tmp/Project', '/tmp/project'), caseInsensitive);
  assert.equal(samePath('/tmp/a/../b', '/tmp/b'), true);
  assert.equal(pathKey('/tmp/X') === pathKey('/tmp/x'), caseInsensitive);
});

test('editor validation matches the platform', () => {
  assert.equal(validEditor('relative/editor'), false);
  if (process.platform === 'win32') assert.equal(validEditor('C:\\Tools\\code.exe'), true);
  else if (process.platform === 'darwin')
    assert.equal(validEditor('/Applications/Visual Studio Code.app'), true);
  else assert.equal(validEditor('/usr/bin/code'), true);
});

test('terminal lock follows process lifetime and only expires unacknowledged startup', async () => {
  const lock = path.join(await sandbox(), 'terminal.lock');
  assert.equal(await terminalOpen(lock), false);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(lock, old, old);
  assert.equal(await terminalOpen(lock), true, 'a live terminal must stay locked after 24 hours');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, launch: 'pending-test' }));
  await fs.utimes(lock, new Date(), new Date());
  assert.equal(await terminalOpen(lock), true);
  await fs.utimes(lock, old, old);
  assert.equal(await terminalOpen(lock), false);
  await assert.rejects(fs.stat(lock));
});

test('terminal launch errors release the hand-off lock', async () => {
  const dir = await sandbox();
  const lock = path.join(dir, 'terminal.lock');
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const previous = process.env[key];
  try {
    process.env[key] = dir;
    await assert.rejects(
      openTerminal([process.execPath, '-e', 'process.exit(0)'], dir, {}, lock),
      /无法打开 Pi 终端/,
    );
  } finally {
    process.env[key] = previous;
  }
  assert.equal(await terminalOpen(lock), false);
  await assert.rejects(fs.stat(lock));
});

test('terminal runner records its PID and recovers after being killed without cleanup', async () => {
  const dir = await sandbox();
  const lock = path.join(dir, 'terminal.lock');
  const proof = path.join(dir, 'started.json');
  const pending = JSON.stringify({ pid: process.pid, launch: 'runner-test' });
  await fs.writeFile(lock, pending);
  const program =
    "require('node:fs').writeFileSync('started.json', JSON.stringify({cwd:process.cwd(), value:process.env.PI_LOCK_TEST}));setInterval(()=>{},1000)";
  const script = terminalScript(
    [process.execPath, '-e', program],
    dir,
    { PI_LOCK_TEST: "中文 ' value" },
    lock,
    pending,
  );
  const child =
    process.platform === 'win32'
      ? spawn(
          'powershell.exe',
          ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: 'ignore' },
        )
      : spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  try {
    // Cold PowerShell startup on shared Windows runners can exceed five seconds.
    await until(async () => Boolean(await fs.stat(proof).catch(() => false)), 15000);
    assert.deepEqual(JSON.parse(await fs.readFile(proof, 'utf8')), { cwd: dir, value: "中文 ' value" });
    assert.deepEqual(JSON.parse(await fs.readFile(lock, 'utf8')), { pid: child.pid });
    assert.equal(await terminalOpen(lock), true);
    await stopChild(child);
    assert.equal(await terminalOpen(lock), false, 'a dead runner must not block reconnecting');
    await assert.rejects(fs.stat(lock));
  } finally {
    await stopChild(child);
  }
});

test('a late terminal runner cannot take over a replaced lock', async () => {
  const dir = await sandbox();
  const lock = path.join(dir, 'terminal.lock');
  const proof = path.join(dir, 'should-not-start.txt');
  const pending = JSON.stringify({ pid: process.pid, launch: 'cancelled-launch' });
  const current = JSON.stringify({ pid: process.pid });
  await fs.writeFile(lock, current);
  const script = terminalScript(
    [process.execPath, '-e', "require('node:fs').writeFileSync('should-not-start.txt','started')"],
    dir,
    {},
    lock,
    pending,
  );
  if (process.platform === 'win32')
    await exec(
      'powershell.exe',
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true },
    );
  else await assert.rejects(exec('bash', ['-c', script]));
  await assert.rejects(fs.stat(proof), { code: 'ENOENT' });
  assert.equal(await fs.readFile(lock, 'utf8'), current);
});

test(
  'Linux terminal hand-off waits for its runner and rejects a second launch',
  { skip: process.platform !== 'linux' },
  async () => {
    const dir = await sandbox();
    const lock = path.join(dir, 'terminal.lock');
    const launcher = path.join(dir, 'x-terminal-emulator');
    await fs.writeFile(launcher, '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
    const previous = process.env.PATH;
    let pid: number | undefined;
    try {
      process.env.PATH = dir + path.delimiter + previous;
      await openTerminal([process.execPath, '-e', 'setTimeout(()=>{},5000)'], dir, {}, lock);
      const running = JSON.parse(await fs.readFile(lock, 'utf8'));
      assert.equal(running.launch, undefined);
      assert.notEqual(running.pid, process.pid);
      pid = running.pid;
      assert.equal(await terminalOpen(lock), true);
      await assert.rejects(openTerminal([process.execPath], dir, {}, lock), /正在打开或运行/);
    } finally {
      process.env.PATH = previous;
      if (pid && pid !== process.pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
    }
    await until(async () => !(await terminalOpen(lock)));
  },
);

test(
  'killTree stops detached tool groups and their descendants without affecting other processes',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await sandbox();
    const proof = path.join(dir, 'should-not-exist.txt');
    const leaf =
      "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1], 'still running'),1000);setInterval(()=>{},1000)";
    const tool = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)},${JSON.stringify(proof)}],{stdio:'ignore'});console.log(JSON.stringify({type:'ready',tool:process.pid,child:child.pid}));setInterval(()=>{},1000)`;
    const parent = `const {spawn}=require('node:child_process');const tool=spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:['ignore','pipe','ignore']});tool.stdout.pipe(process.stdout);setInterval(()=>{},1000)`;
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const rpc = new PiRpc();
    let toolPid: number | undefined;
    try {
      const ready = new Promise<{ tool: number; child: number }>((resolve, reject) => {
        rpc.once('event', resolve);
        rpc.once('fault', reject);
        rpc.once('protocolError', reject);
      });
      rpc.start({ command: process.execPath, args: ['-e', parent] }, dir, []);
      const ids = await ready;
      toolPid = ids.tool;
      process.kill(ids.child, 0);
      await rpc.killTree();
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await assert.rejects(fs.stat(proof), { code: 'ENOENT' });
      assert.equal(rpc.closed, true);
      process.kill(other.pid!, 0);
    } finally {
      await rpc.close();
      if (toolPid) {
        try {
          process.kill(-toolPid, 'SIGKILL');
        } catch {}
      }
      await stopChild(other);
    }
  },
);

test('a normally exiting terminal command removes its lock without a later cleanup probe', async () => {
  const dir = await sandbox();
  const lock = path.join(dir, 'terminal.lock');
  const pending = JSON.stringify({ pid: process.pid, launch: 'normal-exit' });
  await fs.writeFile(lock, pending);
  const script = terminalScript([process.execPath, '-e', 'process.exit(0)'], dir, {}, lock, pending);
  if (process.platform === 'win32')
    await exec('powershell.exe', [
      '-NoProfile',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
  else await exec('bash', ['-c', script]);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});
