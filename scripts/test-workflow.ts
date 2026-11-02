import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { listPiSessions, searchSessionContents } from '../electron/history';
import { pathKey } from '../electron/platform';
import { messageText, busy } from '../shared/types';
process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'workflow');
const nativeSettings = JSON.parse(await fs.readFile(path.join(f.agentDir, 'settings.json'), 'utf8'));
const models = JSON.parse(await fs.readFile(path.join(f.agentDir, 'models.json'), 'utf8'));
models.providers['local-e2e'].models.push({
  ...models.providers['local-e2e'].models[0],
  id: 'local-e2e-reasoning',
  name: '本地推理模型',
  reasoning: true,
  thinkingLevelMap: { max: 'max' },
});
await fs.writeFile(path.join(f.agentDir, 'models.json'), JSON.stringify(models));
const s = new AgentService(f.store, new Workspace(f.dataDir));
async function until(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 20000) throw new Error('Timeout ' + s.runtime.status + ' ' + s.runtime.error);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const userTexts = () => s.runtime.messages.filter((m) => m.role === 'user').map((m) => messageText(m));
try {
  await s.connect(f.sessionId);
  const initialModel = s.runtime.model!.id;
  const initialThinking = s.runtime.thinking;
  await s.send(f.sessionId, 'WORKFLOW_FIRST', [], 'steer');
  await until(() => !busy(s.runtime.status));
  await s.send(f.sessionId, 'WORKFLOW_SECOND', [], 'steer');
  await until(() => !busy(s.runtime.status));
  assert.deepEqual(userTexts(), ['WORKFLOW_FIRST', 'WORKFLOW_SECOND']);

  const alternate = f.store.createSession(f.projectId);
  await s.setModel(alternate.id, 'local-e2e', 'local-e2e-reasoning');
  await s.connect(alternate.id);
  const alternateThinking = s.runtime.thinkingLevels.find((level) => level !== initialThinking)!;
  await s.setThinking(alternate.id, alternateThinking);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.agentDir, 'settings.json'), 'utf8')).defaultThinkingLevel,
    nativeSettings.defaultThinkingLevel,
    'a session choice must not change the shared Pi default',
  );
  await s.connect(f.sessionId);
  assert.equal(s.runtime.model?.id, initialModel, 'default model must be remembered by the session');
  assert.equal(s.runtime.thinking, initialThinking);

  await s.disconnect();
  delete f.store.session(f.sessionId).model;
  delete f.store.session(f.sessionId).thinking;
  await f.store.save();
  await s.connect(f.sessionId);
  assert.equal(s.runtime.model?.id, initialModel, 'existing Pi history must retain its model');
  assert.equal(s.runtime.thinking, initialThinking);
  const fresh = f.store.createSession(f.projectId);
  await s.connect(fresh.id);
  assert.equal(s.runtime.model?.id, 'local-e2e-reasoning', 'new sessions use the latest default');
  assert.equal(
    s.runtime.thinking,
    'off',
    'new sessions use the native Pi default, not another session choice',
  );
  await s.connect(f.sessionId);
  console.log('PASS default session choices, existing history and new-session defaults stay separate');

  const preferences = () =>
    structuredClone({
      model: f.store.session(f.sessionId).model,
      thinking: f.store.session(f.sessionId).thinking,
      settings: f.store.state.settings,
    });
  const beforeRejectedSwitch = preferences();
  await assert.rejects(s.setModel(f.sessionId, 'local-e2e', 'missing-model'), /模型当前不可用/);
  await assert.rejects(s.setThinking(f.sessionId, 'unsupported-level'), /不支持这个推理级别/);
  await assert.rejects(s.setThinking(f.sessionId, 'high'), /不支持这个推理级别/);
  assert.deepEqual(preferences(), beforeRejectedSwitch);
  const rpc = (s as any).rpc;
  const request = rpc.request.bind(rpc);
  rpc.request = async (type: string, ...args: any[]) => {
    if (type !== 'set_model') return request(type, ...args);
    alternate.draft = 'B_DRAFT_SAVED_DURING_MODEL_SWITCH';
    await f.store.save();
    throw new Error('TEST_SWITCH_REJECTED');
  };
  try {
    await assert.rejects(s.setModel(f.sessionId, 'local-e2e', 'local-e2e-reasoning'), /TEST_SWITCH_REJECTED/);
  } finally {
    rpc.request = request;
  }
  assert.deepEqual(preferences(), beforeRejectedSwitch);
  await f.store.flush();
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.settings, beforeRejectedSwitch.settings);
  assert.deepEqual(
    persisted.sessions.find((session: { id: string }) => session.id === f.sessionId).model,
    beforeRejectedSwitch.model,
  );
  assert.equal(
    persisted.sessions.find((session: { id: string }) => session.id === alternate.id).draft,
    'B_DRAFT_SAVED_DURING_MODEL_SWITCH',
  );
  console.log('PASS rejected model/thinking changes leave saved preferences unchanged');

  const rpcBefore = (s as any).rpc;
  await s.setModel(f.sessionId, 'local-e2e', 'local-e2e-reasoning');
  assert.equal((s as any).rpc, rpcBefore, 'model switch must not restart Pi');
  assert.equal(s.runtime.model?.id, 'local-e2e-reasoning');
  assert.ok(s.runtime.thinkingLevels.length > 1);
  const level = 'max';
  assert.ok(s.runtime.thinkingLevels.includes(level), 'real Pi must report max for the selected model');
  const beforeRejectedThinking = preferences();
  rpc.request = async (type: string, ...args: any[]) => {
    if (type !== 'set_thinking_level') return request(type, ...args);
    alternate.draft = 'B_DRAFT_SAVED_DURING_THINKING_SWITCH';
    await f.store.save();
    throw new Error('TEST_THINKING_REJECTED');
  };
  try {
    await assert.rejects(s.setThinking(f.sessionId, level), /TEST_THINKING_REJECTED/);
  } finally {
    rpc.request = request;
  }
  assert.deepEqual(preferences(), beforeRejectedThinking);
  assert.equal(s.runtime.nextTask, undefined, 'rejected choices must not remain pending');
  await f.store.flush();
  const afterRejectedThinking = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(
    afterRejectedThinking.sessions.find((session: { id: string }) => session.id === f.sessionId).thinking,
    beforeRejectedThinking.thinking,
  );
  assert.equal(
    afterRejectedThinking.sessions.find((session: { id: string }) => session.id === alternate.id).draft,
    'B_DRAFT_SAVED_DURING_THINKING_SWITCH',
  );
  await s.setThinking(f.sessionId, level);
  assert.equal(s.runtime.thinking, level);
  assert.deepEqual(f.store.session(f.sessionId).model, { provider: 'local-e2e', id: 'local-e2e-reasoning' });
  assert.equal(f.store.session(f.sessionId).thinking, level);
  await s.send(f.sessionId, 'WORKFLOW_AFTER_SWITCH', [], 'steer');
  await until(() => !busy(s.runtime.status));
  assert.equal(provider.requests.at(-1).model, 'local-e2e-reasoning');
  await s.disconnect();
  await s.connect(f.sessionId);
  assert.equal(s.runtime.model?.id, 'local-e2e-reasoning', 'per-session model restored on reconnect');
  assert.equal(s.runtime.thinking, level);
  console.log('PASS live model and thinking switch without restart, remembered per session');

  const last = s.runtime.messages.findLast((m) => m.role === 'assistant')!;
  const requestsBefore = provider.requests.length;
  await s.messageAction(f.sessionId, 'regenerate', 'assistant', last.timestamp!);
  await until(() => !busy(s.runtime.status));
  assert.equal(provider.requests.length, requestsBefore + 1);
  assert.deepEqual(userTexts(), ['WORKFLOW_FIRST', 'WORKFLOW_SECOND', 'WORKFLOW_AFTER_SWITCH']);
  console.log('PASS regenerate replaces the last reply on a new branch');

  const second = s.runtime.messages.find((m) => messageText(m) === 'WORKFLOW_SECOND')!;
  await s.messageAction(f.sessionId, 'edit', 'user', second.timestamp!);
  assert.equal(f.store.session(f.sessionId).draft, 'WORKFLOW_SECOND');
  assert.deepEqual(userTexts(), ['WORKFLOW_FIRST']);
  await s.send(f.sessionId, 'WORKFLOW_EDITED', [], 'steer');
  await until(() => !busy(s.runtime.status));
  assert.deepEqual(userTexts(), ['WORKFLOW_FIRST', 'WORKFLOW_EDITED']);
  const tree = await s.tree(f.sessionId);
  assert.ok(
    tree.some((e) => e.text.includes('WORKFLOW_SECOND') && !e.active),
    'original kept in tree',
  );
  console.log('PASS edit-and-resend rewinds to before the message and keeps the old branch');

  const original = f.sessionId;
  const first = s.runtime.messages.find((m) => messageText(m) === 'WORKFLOW_FIRST')!;
  await s.messageAction(original, 'fork', 'user', first.timestamp!);
  const forked = f.store.state.selectedSessionId!;
  assert.notEqual(forked, original);
  assert.equal(s.runtime.sessionId, original, 'fork must leave the source process untouched');
  assert.equal(f.store.session(forked).draft, 'WORKFLOW_FIRST');
  assert.notEqual(f.store.session(forked).file, f.store.session(original).file);
  console.log('PASS fork from a message creates a new session and keeps the original');

  const matches = await searchSessionContents(f.store.state.sessions, 'workflow_edited');
  assert.ok(matches.some((m) => m.sessionId === original && m.snippet.includes('WORKFLOW_EDITED')));
  const roots = [path.join(f.agentDir, 'sessions'), path.join(f.dataDir, 'sessions')];
  const known = new Set<string>();
  const listed = await listPiSessions(roots, known);
  assert.ok(listed.some((x) => x.preview.includes('WORKFLOW_FIRST')));
  const hidden = await listPiSessions(
    roots,
    new Set(f.store.state.sessions.filter((x) => x.file).map((x) => pathKey(x.file!))),
  );
  assert.equal(hidden.length, 0, 'sessions already in the app are not listed again');
  console.log('PASS content search and Pi session discovery');

  s.runtime.notifications = [];
  (s as any).extension({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'warn me',
    notifyType: 'warning',
  });
  (s as any).onEvent({ type: 'extension_error', extensionPath: 'x', event: 'e', error: 'boom' });
  assert.deepEqual(
    s.runtime.notifications!.map((n) => n.level),
    ['warning', 'error'],
  );
  console.log('PASS notification levels reach the UI');

  await s.connect(f.sessionId);
  const stablePid = (s as any).rpc.child.pid;
  const switches: number[] = [];
  for (let i = 0; i < 10; i++) {
    const id = i % 2 ? f.sessionId : alternate.id;
    await s.connect(id);
    assert.equal((s as any).rpc.child.pid, stablePid);
    assert.equal(s.runtime.sessionId, id);
    assert.equal(s.lastSwitch?.mode, 'reuse');
    assert.equal(s.runtime.model?.id, f.store.session(id).model?.id);
    assert.equal(s.runtime.thinking, f.store.session(id).thinking);
    switches.push(s.lastSwitch!.elapsedMs);
  }
  console.log(
    'PASS same-directory reuse, unchanged PID and target settings; milliseconds:',
    JSON.stringify(switches),
  );
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    `test-results/session-switch-${process.platform}.json`,
    JSON.stringify({ switches, pid: stablePid }),
  );

  f.store.session(f.sessionId).draft = 'A_DRAFT';
  alternate.draft = 'B_DRAFT';
  await fs.writeFile(path.join(f.agentDir, 'switch-events'), 'enabled');
  await s.connect(alternate.id);
  assert.equal(
    f.store.session(f.sessionId).draft,
    'OUTGOING_DRAFT',
    'old extension edits stay with the outgoing session',
  );
  assert.equal(alternate.draft, 'B_DRAFT', 'target draft must not be overwritten by an old hook');
  assert.deepEqual(
    s.runtime.widgets['target-widget'],
    ['TARGET_WIDGET'],
    'target startup events are retained',
  );
  await fs.unlink(path.join(f.agentDir, 'switch-events'));

  await fs.writeFile(path.join(f.agentDir, 'slow-switch'), 'enabled');
  const switching = s.connect(f.sessionId);
  await until(() => s.runtime.notices.includes('SWITCH_WAITING'));
  await assert.rejects(s.disconnect(), /会话正忙/);
  await switching;
  await fs.unlink(path.join(f.agentDir, 'slow-switch'));
  console.log(
    'PASS outgoing/target extension events remain separate, and configuration cannot disconnect an active switch',
  );

  const previousStatus = s.runtime.status;
  await fs.writeFile(path.join(f.agentDir, 'confirm-switch'), 'enabled');
  const confirmed = s.connect(alternate.id);
  await until(() => s.runtime.dialogs.some((dialog) => dialog.title === '切换确认'));
  await s.respond(s.runtime.dialogs[0].id, { confirmed: true });
  await confirmed;
  assert.equal(f.store.session(f.sessionId).lastStatus, previousStatus);
  assert.equal(s.runtime.dialogs.length, 0);
  assert.equal(s.lastSwitch?.mode, 'reuse');
  await fs.unlink(path.join(f.agentDir, 'confirm-switch'));
  await s.connect(f.sessionId);
  console.log('PASS extension confirmation does not leave the previous session stuck in starting');

  const failedRpc = (s as any).rpc;
  const originalRequest = failedRpc.request.bind(failedRpc);
  failedRpc.request = (type: string, ...args: any[]) =>
    type === 'switch_session'
      ? Promise.reject(new Error('TEST_SWITCH_FAILURE'))
      : originalRequest(type, ...args);
  await s.connect(alternate.id);
  assert.notEqual((s as any).rpc.child.pid, stablePid);
  assert.equal(s.lastSwitch?.mode, 'restart');
  assert.match(s.lastSwitch!.reason!, /会话切换没有完成/);
  assert.ok(s.runtime.diagnostic.some((entry) => entry.includes('TEST_SWITCH_FAILURE')));
  assert.equal(s.runtime.error, undefined);
  console.log('PASS failed reuse restarts cleanly and records the reason without an error banner');

  const crashedPid = (s as any).rpc.child.pid;
  await (s as any).rpc.killTree();
  await until(() => !s.runtime.connected);
  await s.connect(f.sessionId);
  assert.notEqual((s as any).rpc.child.pid, crashedPid);
  assert.equal(s.lastSwitch?.mode, 'restart');
  assert.equal(s.runtime.connected, true);
  assert.deepEqual(userTexts(), ['WORKFLOW_FIRST', 'WORKFLOW_EDITED']);
  console.log('PASS the first switch after a process exit restarts and restores target history');
} finally {
  await s.dispose().catch(() => {});
  await provider.close();
}
