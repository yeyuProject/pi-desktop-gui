import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { PiRpc } from '../electron/rpc';
import { Workspace } from '../electron/workspace';

process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'recovery');
await fs.writeFile(
  path.join(f.agentDir, 'extensions', 'recovery-startup.js'),
  `export default (pi) => pi.on('session_start', (_event, ctx) => ctx.ui.notify('RECOVERY_STARTUP_NOTICE'));`,
);
await fs.mkdir(path.join(f.agentDir, 'prompts'), { recursive: true });
await fs.writeFile(path.join(f.agentDir, 'prompts/review-queue.md'), 'EXPANDED_TEMPLATE $ARGUMENTS');
await fs.writeFile(path.join(f.projectDir, 'queued-context.txt'), 'CRASH_ATTACHMENT_BODY');
const service = new AgentService(f.store, new Workspace(f.dataDir));
const until = async (check: () => boolean, timeout = 25000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout)
      throw new Error('Recovery timed out: ' + JSON.stringify(service.runtime));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
const internals = service as unknown as { rpc: PiRpc; crashTimes: Map<string, number> };
async function crash(queue = false) {
  await service.send(f.sessionId, 'E2E_CRASH', [], 'steer');
  await until(() => service.runtime.tools.some((tool) => tool.output.includes('WAITING_FOR_STOP')));
  if (queue) {
    const session = f.store.session(f.sessionId);
    session.draft = 'UNSENT_STEERING';
    session.attachments = ['queued-context.txt'];
    await service.send(f.sessionId, session.draft, session.attachments, 'steer');
    const images = [
      {
        id: 'queued-image',
        name: 'icon.png',
        data: (await fs.readFile('build/icon.png')).toString('base64'),
        mimeType: 'image/png',
      },
    ];
    session.draft = '/review-queue UNSENT_FOLLOWUP';
    session.images = images;
    await service.send(f.sessionId, session.draft, [], 'followUp', images);
  }
  const requests = provider.requests.length;
  await internals.rpc.killTree();
  await until(() => Boolean(service.runtime.crash), 5000);
  await until(() => service.runtime.crash?.cleanup === 'confirmed', 5000);
  assert.equal(service.runtime.status, 'interrupted');
  assert.equal(service.runtime.connected, false);
  assert.ok(service.runtime.crash!.code !== null || service.runtime.crash!.signal !== null);
  assert.ok(['bash', 'powershell'].includes(service.runtime.crash!.lastTool!.name));
  assert.match(service.runtime.crash!.lastTool!.target, /crash-partial/);
  assert.equal(
    service.runtime.tools.some((tool) => tool.status === 'running'),
    false,
  );
  assert.ok(
    (
      await service.workspace.changes(f.store.project(f.projectId), 'run', { sessionId: f.sessionId })
    ).files.some((file) => file.path === 'crash-partial.txt'),
  );
  assert.equal(provider.requests.length, requests, 'a crash must never resend a prompt');
  return requests;
}
try {
  await service.connect(f.sessionId);
  const requests = await crash(true);
  await service.recover(f.sessionId);
  assert.deepEqual(service.runtime.notices, ['RECOVERY_STARTUP_NOTICE']);
  assert.equal(service.runtime.crash, undefined);
  assert.equal(provider.requests.length, requests, 'reconnect alone must not send anything to the model');
  assert.match(f.store.session(f.sessionId).draft, /UNSENT_STEERING\n\n\/review-queue UNSENT_FOLLOWUP/);
  assert.equal(f.store.session(f.sessionId).images?.[0].id, 'queued-image');
  assert.deepEqual(f.store.session(f.sessionId).attachments, ['queued-context.txt']);
  assert.doesNotMatch(f.store.session(f.sessionId).draft, /CRASH_ATTACHMENT_BODY|EXPANDED_TEMPLATE/);
  await f.store.flush();
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.sessions.find((s: any) => s.id === f.sessionId).images[0].id, 'queued-image');
  console.log('PASS real Pi crash records the exit and last tool; reconnect never replays the request');
  await fs.unlink(path.join(f.projectDir, 'crash-partial.txt'));
  internals.crashTimes.set(f.sessionId, Date.now());
  await crash();
  assert.equal(service.runtime.crash!.repeated, true);
  const prompt = 'RESUME_AFTER_CRASH：先检查已经写入的文件，再继续任务。';
  await service.recover(f.sessionId, prompt);
  assert.deepEqual(service.runtime.notices, ['RECOVERY_STARTUP_NOTICE']);
  await until(() => service.runtime.status === 'completed');
  assert.ok(
    provider.requests
      .at(-1)
      .messages.some(
        (message: any) => message.role === 'user' && JSON.stringify(message.content).includes(prompt),
      ),
  );
  assert.equal(service.runtime.crash, undefined);
  console.log(
    'PASS repeated exits are identified and recovery sends only the explicitly edited continuation',
  );
  for (const stop of [() => service.stop(), () => service.forceStop()]) {
    await service.send(f.sessionId, 'E2E_STOP', [], 'steer');
    await until(() => service.runtime.tools.some((tool) => tool.output.includes('WAITING_FOR_STOP')));
    await stop();
    assert.equal(service.runtime.crash, undefined);
  }
  console.log('PASS deliberate stop and force stop never show a crash card');
  const flush = f.store.flush.bind(f.store);
  let release!: () => void, waiting!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  f.store.flush = async () => {
    await flush();
    if (service.runtime.status === 'running') {
      waiting();
      await held;
    }
  };
  try {
    const send = service.send(f.sessionId, '!echo SHOULD_NOT_EXECUTE > stop-race.txt', [], 'steer');
    const rejected = assert.rejects(send, /任务已取消/);
    await entered;
    const stopping = service.stop();
    await until(() => service.runtime.status === 'stopped');
    release();
    await Promise.all([rejected, stopping]);
    assert.equal(
      service.runtime.tools.some((tool) => tool.status === 'running'),
      false,
    );
    await assert.rejects(fs.access(path.join(f.projectDir, 'stop-race.txt')));
    console.log('PASS stopping during pre-command persistence prevents the delayed command from executing');
  } finally {
    release();
    f.store.flush = flush;
  }
  await service.send(f.sessionId, 'E2E_CRASH E2E_ORPHAN', [], 'steer');
  await until(() => service.runtime.tools.some((tool) => tool.output.includes('WAITING_FOR_STOP')));
  internals.rpc.child!.kill('SIGKILL');
  await until(() => service.runtime.crash?.cleanup === 'unconfirmed', 5000);
  await assert.rejects(service.recover(f.sessionId), /无法确认/);
  await assert.rejects(service.connect(f.sessionId), /无法确认/);
  assert.throws(() => service.assertCommandsStopped(), /无法确认/);
  await assert.rejects(service.send(f.sessionId, 'MUST_NOT_REPLAY', [], 'steer'), /无法确认/);
  // This fixture deliberately finishes after Pi is killed: recovery must remain blocked even then.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(
    await fs.readFile(path.join(f.projectDir, 'should-not-exist.txt'), 'utf8').then((text) => text.trim()),
    'NOT_STOPPED',
  );
  assert.throws(() => service.assertCommandsStopped(), /无法确认/);
  console.log('PASS killing only Pi leaves an orphan tool; all service recovery paths stay blocked');

  const diskFixture = await prepareRealPiFixture(provider.baseUrl, 'recovery-readonly');
  const diskService = new AgentService(diskFixture.store, new Workspace(diskFixture.dataDir));
  try {
    await diskService.connect(diskFixture.sessionId);
    await diskFixture.store.flush();
    await fs.mkdir(path.join(diskFixture.dataDir, 'state.json.tmp'));
    const count = provider.requests.length;
    diskFixture.store.session(diskFixture.sessionId).draft = 'DISK_FAILURE_DRAFT';
    await assert.rejects(
      diskService.send(diskFixture.sessionId, 'DISK_FAILURE_DRAFT', [], 'steer'),
      /发送与保存已暂停/,
    );
    assert.equal(diskFixture.store.storage.writable, false);
    assert.equal(provider.requests.length, count);
    assert.equal(diskFixture.store.session(diskFixture.sessionId).draft, 'DISK_FAILURE_DRAFT');
    console.log('PASS a newly failing disk write blocks the model request and preserves the draft');
  } finally {
    await diskService.dispose();
  }
} finally {
  await service.dispose();
  await provider.close();
}
