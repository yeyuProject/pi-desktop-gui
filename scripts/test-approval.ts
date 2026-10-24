import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { APPROVAL_ALLOW, APPROVAL_ALWAYS, decide, describe } from '../shared/approval';
process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'approval');
const s = new AgentService(f.store, new Workspace(f.dataDir));
const output = path.join(f.projectDir, '输出结果.txt');
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
const settled = () => ['completed', 'error', 'stopped'].includes(s.runtime.status);
async function until(fn: () => boolean, ms = 25000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('Timeout ' + s.runtime.status + ' ' + s.runtime.error);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const nextDialog = () => until(() => s.runtime.dialogs.length > 0 || settled());
try {
  assert.equal(decide('auto', 'bash'), 'allow');
  assert.equal(decide('confirm', 'read', 'project'), 'allow');
  assert.equal(decide('confirm', 'read', 'outside'), 'ask');
  assert.equal(decide('readonly', 'read', 'outside'), 'deny');
  assert.equal(decide('confirm', 'write'), 'ask');
  assert.equal(decide('confirm', 'mcp__x'), 'ask');
  assert.equal(decide('readonly', 'bash'), 'deny');
  assert.equal(decide('readonly', 'mcp__x'), 'deny');
  assert.match(describe('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] }).detail!, /-x\n\+y/);
  console.log('PASS approval policy table');

  await s.connect(f.sessionId);
  assert.equal(s.runtime.approvalMode, 'auto');
  await s.setApprovalMode(f.sessionId, 'confirm');
  assert.equal(s.runtime.approvalMode, 'confirm');

  await s.send(f.sessionId, 'E2E_FILES', [], 'steer');
  await nextDialog();
  const write = s.runtime.dialogs[0];
  assert.equal(write?.approval?.toolName, 'write');
  assert.equal(write.approval!.path, '输出结果.txt');
  assert.match(write.approval!.detail!, /真实 Pi 工具执行成功/);
  assert.equal(s.runtime.status, 'waiting');
  await s.respond(write.id, { value: '拒绝：先别写文件' });
  await nextDialog();
  assert.equal(await exists(output), false, 'denied write must not touch the disk');
  assert.match(s.runtime.tools.find((t) => t.name === 'write')!.output, /先别写文件/);
  const shell = s.runtime.dialogs[0];
  assert.ok(['bash', 'powershell'].includes(shell?.approval?.toolName ?? ''));
  assert.equal(shell.approval!.kind, 'shell');
  await s.respond(shell.id, { value: APPROVAL_ALLOW });
  await until(settled);
  assert.equal(s.runtime.status, 'completed', s.runtime.error ?? '');
  console.log('PASS confirm mode: denial with reason reaches the model, allow once runs the command');

  await s.send(f.sessionId, 'E2E_FILES', [], 'steer');
  await nextDialog();
  await s.respond(s.runtime.dialogs[0].id, { value: APPROVAL_ALWAYS });
  await nextDialog();
  await s.respond(s.runtime.dialogs[0].id, { value: APPROVAL_ALLOW });
  await until(settled);
  assert.equal(await exists(output), true);
  await fs.rm(output);
  await s.send(f.sessionId, 'E2E_FILES', [], 'steer');
  await nextDialog();
  assert.notEqual(
    s.runtime.dialogs[0]?.approval?.toolName,
    'write',
    '"always allow write" must skip the prompt',
  );
  assert.equal(await exists(output), true);
  await s.respond(s.runtime.dialogs[0].id, { value: APPROVAL_ALLOW });
  await until(settled);
  console.log('PASS always-allow applies for the rest of the session');

  const switched = f.store.createSession(f.projectId);
  await s.setApprovalMode(switched.id, 'confirm');
  const pid = s.lastSwitch?.pid;
  for (const id of [switched.id, f.sessionId]) {
    await s.connect(id);
    assert.equal(s.lastSwitch?.mode, 'reuse');
    assert.equal(s.lastSwitch?.pid, pid);
    assert.equal(s.runtime.approvalMode, 'confirm');
    await s.send(id, 'E2E_FILES', [], 'steer');
    await nextDialog();
    assert.equal(
      s.runtime.dialogs[0]?.approval?.toolName,
      'write',
      'switching must clear the old always-allow grant',
    );
    await s.respond(s.runtime.dialogs[0].id, { value: APPROVAL_ALLOW });
    await nextDialog();
    await s.respond(s.runtime.dialogs[0].id, { value: APPROVAL_ALLOW });
    await until(settled);
  }
  console.log('PASS reused sessions never inherit or restore always-allow grants');

  await fs.rm(output);
  await s.setApprovalMode(f.sessionId, 'readonly');
  await s.send(f.sessionId, 'E2E_FILES', [], 'steer');
  await until(settled);
  assert.equal(s.runtime.dialogs.length, 0, 'read-only never asks');
  assert.equal(await exists(output), false);
  assert.match(s.runtime.tools.find((t) => t.name === 'write')!.output, /只读模式/);
  assert.equal(s.runtime.tools.find((t) => t.name === 'read')?.status, 'done');
  console.log('PASS read-only mode blocks writes and commands without prompting');

  const manual = path.join(f.projectDir, 'manual-denied.txt');
  await s.send(f.sessionId, '!printf blocked > manual-denied.txt', [], 'steer');
  assert.equal(await exists(manual), false, 'manual commands must not bypass read-only');
  assert.match(s.runtime.tools[0].output, /只读/);
  await s.setApprovalMode(f.sessionId, 'confirm');
  const manualSend = s.send(f.sessionId, '!printf blocked > manual-denied.txt', [], 'steer');
  void manualSend.catch(() => {});
  await until(() => s.runtime.dialogs.some((d) => d.approval?.kind === 'shell'));
  await s.respond(s.runtime.dialogs[0].id, { value: '拒绝：不运行手动命令' });
  await manualSend;
  assert.equal(await exists(manual), false);
  console.log('PASS manual ! commands obey read-only and confirmation modes');
  await s.setApprovalMode(f.sessionId, 'readonly');

  await s.disconnect();
  await s.connect(f.sessionId);
  assert.equal(s.runtime.approvalMode, 'readonly', 'mode is remembered per session');
  await s.setApprovalMode(f.sessionId, 'confirm');
  await s.send(f.sessionId, 'E2E_STOP', [], 'steer');
  await nextDialog();
  assert.ok(s.runtime.dialogs[0]?.approval);
  await s.setApprovalMode(f.sessionId, 'readonly');
  await s.stop();
  assert.equal(s.runtime.dialogs.length, 0, 'stop rejects pending approvals');
  assert.equal(await exists(path.join(f.projectDir, 'should-not-exist.txt')), false);
  assert.equal(s.runtime.approvalMode, 'readonly', 'a deferred mode takes effect after stopping');
  console.log('PASS mode survives reconnect; stopping rejects pending approvals');

  const second = f.store.createSession(f.projectId);
  await s.connect(second.id);
  await s.send(second.id, 'A separate session', [], 'steer');
  await until(settled);
  assert.equal(s.runtime.approvalMode, 'auto');
  assert.equal(f.store.session(second.id).approvalMode ?? 'auto', 'auto');
  console.log('PASS a stopped session cannot change the next session approval mode');

  const capture = s.workspace.captureCheckpoint.bind(s.workspace);
  s.workspace.captureCheckpoint = async () => {
    throw new Error('snapshot unavailable');
  };
  try {
    await assert.rejects(s.send(second.id, 'Must not start', [], 'steer'), /snapshot unavailable/);
    assert.equal(s.runtime.status, 'error', 'snapshot failure must not leave the task stuck in starting');
  } finally {
    s.workspace.captureCheckpoint = capture;
  }
  console.log('PASS snapshot failure leaves a recoverable error before any task starts');
} finally {
  await s.dispose().catch(() => {});
  await provider.close();
}
