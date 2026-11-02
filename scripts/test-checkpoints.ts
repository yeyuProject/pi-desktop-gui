import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { busy } from '../shared/types';

process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'checkpoints');
const workspace = new Workspace(fixture.dataDir);
const service = new AgentService(fixture.store, workspace);
const project = fixture.store.project(fixture.projectId);
const context = { sessionId: fixture.sessionId };
const until = async (condition: () => boolean, timeout = 25000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(`Checkpoint timeout: ${service.runtime.status} ${service.runtime.error ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const send = async (message: string) => {
  await service.send(fixture.sessionId, message, [], 'steer');
  await until(() => !busy(service.runtime.status));
  assert.equal(service.runtime.status, 'completed', service.runtime.error ?? '');
};

try {
  await service.connect(fixture.sessionId);
  await send('E2E_FILES');
  const first = (await workspace.listCheckpoints(project, fixture.sessionId))[0];
  assert.equal(first.turn, 1);
  assert.equal(
    first.timestamp,
    service.runtime.messages.find((message) => message.role === 'user')?.timestamp,
  );
  await fs.writeFile(path.join(project.path, '已有修改.txt'), 'manual after first turn\n');
  await send('E2E_EDIT');
  const checkpoints = await workspace.listCheckpoints(project, fixture.sessionId);
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(
    (await workspace.changes(project, 'run', context)).files.map((file) => file.path),
    ['输入 文件.txt'],
  );
  const preview = await workspace.checkpointPreview(project, fixture.sessionId, first.id);
  const manual = preview.files.find((file) => file.path === '已有修改.txt');
  assert.ok(manual?.manual);
  assert.equal(manual.selected, false);
  assert.ok(preview.files.some((file) => file.path === '输出结果.txt' && file.selected));
  assert.ok(preview.files.some((file) => file.path === '输入 文件.txt' && file.selected));
  await workspace.revert(
    project,
    preview.files.filter((file) => file.selected).map((file) => file.path),
    (file) => fs.unlink(file),
    { ...context, checkpointId: first.id, revision: preview.revision },
  );
  assert.equal(
    await fs.readFile(path.join(project.path, '已有修改.txt'), 'utf8'),
    'manual after first turn\n',
  );
  assert.equal(
    await fs.readFile(path.join(project.path, '输入 文件.txt'), 'utf8'),
    '这是 E2E 测试的输入文件。\n',
  );
  await assert.rejects(fs.access(path.join(project.path, '输出结果.txt')));
  console.log(
    'PASS real Pi binds checkpoints to user messages and attributes tool writes; cumulative restore preserves manual edits',
  );

  const capture = workspace.captureCheckpoint.bind(workspace);
  let queuedCaptureRequests = -1;
  workspace.captureCheckpoint = async (...args) => {
    if (args[2] === 4) queuedCaptureRequests = provider.requests.length;
    return capture(...args);
  };
  await service.send(fixture.sessionId, 'E2E_FILES queued boundary test', [], 'steer');
  await until(() =>
    service.runtime.tools.some((tool) => tool.status === 'running' || tool.status === 'done'),
  );
  await service.send(fixture.sessionId, 'QUEUED_BOUNDARY', [], 'followUp');
  await until(() => !busy(service.runtime.status));
  assert.equal(service.runtime.status, 'completed', service.runtime.error ?? '');
  const queued = (await workspace.listCheckpoints(project, fixture.sessionId)).find(
    (checkpoint) => checkpoint.turn === 4,
  );
  assert.ok(queued?.timestamp);
  assert.ok(queuedCaptureRequests >= 0);
  assert.equal(
    provider.requests.length,
    queuedCaptureRequests + 1,
    'queued checkpoint finishes before its model request',
  );
  const queuedPreview = await workspace.checkpointPreview(project, fixture.sessionId, queued.id);
  assert.equal(queuedPreview.files.length, 0, 'queued turn baseline includes the previous turn writes');
  console.log('PASS a queued turn is captured after earlier tools finish and before its own model request');

  workspace.captureCheckpoint = async () => {
    throw new Error('SIMULATED_CHECKPOINT_DISK_FAILURE');
  };
  const previousRequests = provider.requests.length;
  fixture.store.session(fixture.sessionId).draft = 'MUST_NOT_EXECUTE';
  await assert.rejects(
    service.send(fixture.sessionId, 'MUST_NOT_EXECUTE', [], 'steer'),
    /无法为这一轮建立检查点/,
  );
  assert.ok(service.runtime.diagnostic.some((entry) => entry.includes('SIMULATED_CHECKPOINT_DISK_FAILURE')));
  assert.equal(provider.requests.length, previousRequests);
  assert.equal(fixture.store.session(fixture.sessionId).draft, 'MUST_NOT_EXECUTE');
  workspace.captureCheckpoint = capture;
  console.log('PASS checkpoint failure stops execution before the model request and preserves the draft');
} finally {
  await service.dispose();
  await provider.close();
}
