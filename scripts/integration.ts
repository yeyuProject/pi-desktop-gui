import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Store, readSessionFile } from '../electron/store';
import { Workspace } from '../electron/workspace';
import { messageText } from '../shared/types';
import { detectEnvironment } from '../electron/environment';
process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'integration');
const { store, sessionId, projectId, dataDir, projectDir } = fixture;
const workspace = new Workspace(dataDir);
let service = new AgentService(store, workspace);
const events: any[] = [];
let activeLog = '';
function listen() {
  service.on('runtime', (r) => {
    const line = `${r.status} ${r.messages.length} messages ${r.tools.map((t: any) => t.name + ':' + t.status).join(',')}`;
    if (line !== activeLog) {
      console.log(line);
      activeLog = line;
      events.push({ time: Date.now(), line });
    }
  });
}
async function waitFor(condition: () => boolean, ms = 25000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms)
      throw new Error(
        'Timed out: ' +
          JSON.stringify({
            status: service.runtime.status,
            error: service.runtime.error,
            diagnostic: service.runtime.diagnostic,
          }),
      );
    await new Promise((r) => setTimeout(r, 50));
  }
}
try {
  listen();
  await service.connect(sessionId);
  assert.equal(service.runtime.model?.id, 'local-e2e');
  const probe = await service.testConnection(sessionId);
  assert.equal(probe.text, 'OK');
  console.log('PASS actual Pi model probe');
  const usageSession = store.createSession(projectId);
  await service.connect(usageSession.id);
  for (const turn of [1, 2]) {
    await service.send(usageSession.id, `E2E_USAGE turn ${turn}`, [], 'steer');
    await waitFor(
      () => service.runtime.status === 'completed' && service.runtime.stats?.tokens === 120 * turn,
    );
    assert.deepEqual(service.runtime.stats, {
      tokens: 120 * turn,
      inputTokens: 30 * turn,
      outputTokens: 20 * turn,
      cacheReadTokens: 60 * turn,
      cacheWriteTokens: 10 * turn,
      cost: 0,
      contextTokens: 120,
      contextWindow: 32768,
      contextPercent: (120 / 32768) * 100,
    });
  }
  console.log('PASS actual Pi cumulative input/output/cache usage stays separate from current context');
  const liveUsageSession = store.createSession(projectId);
  await service.connect(liveUsageSession.id);
  await service.send(liveUsageSession.id, 'E2E_USAGE_LIVE', [], 'steer');
  await waitFor(
    () =>
      provider.heldInitialUsageResponseCount === 1 &&
      service.runtime.status === 'running' &&
      (service.runtime.liveUsage?.outputTokens ?? 0) > 0,
  );
  assert.equal(store.session(liveUsageSession.id).stats?.tokens, 0, 'stream estimates are not persisted');
  const firstEstimate = service.runtime.liveUsage!.outputTokens;
  provider.advanceInitialUsageResponses();
  await waitFor(() => (service.runtime.liveUsage?.outputTokens ?? 0) > firstEstimate);
  provider.finishInitialUsageResponses();
  await waitFor(
    () =>
      provider.heldUsageResponseCount === 1 &&
      service.runtime.status === 'running' &&
      service.runtime.stats?.tokens === 120 &&
      (service.runtime.liveUsage?.outputTokens ?? 0) > 0,
  );
  assert.equal(store.session(liveUsageSession.id).stats?.tokens, 120, 'completed request usage is saved');
  provider.releaseUsageResponses();
  await waitFor(
    () =>
      service.runtime.status === 'completed' &&
      service.runtime.stats?.tokens === 240 &&
      !service.runtime.liveUsage,
  );
  console.log('PASS live output estimates and completed request usage during a real multi-step Pi run');
  await service.connect(sessionId);
  await service.send(sessionId, 'E2E_FILES：读取输入、写入输出并运行验证命令。', ['输入 文件.txt'], 'steer');
  await waitFor(() => ['completed', 'error'].includes(service.runtime.status));
  assert.equal(service.runtime.status, 'completed', service.runtime.error ?? '');
  assert.equal(await fs.readFile(path.join(projectDir, '输出结果.txt'), 'utf8'), '真实 Pi 工具执行成功\n');
  assert.equal(service.runtime.tools.length, 3);
  assert.ok(service.runtime.tools.every((t) => t.status === 'done'));
  assert.match(service.runtime.tools[2].output, /PI_TOOL_TEST_PASS/);
  assert.match(messageText(service.runtime.messages.find((m) => m.role === 'user')!), /project_file/);
  console.log('PASS actual Pi read, write and shell tools');
  const changes = await workspace.changes(store.project(projectId), 'all', { sessionId });
  assert.ok(changes.files.find((f) => f.path === '已有修改.txt')?.existedBeforeRun);
  assert.equal(
    (await workspace.diff(store.project(projectId), '输出结果.txt', 'run', { sessionId })).after,
    '真实 Pi 工具执行成功\n',
  );
  const file = store.session(sessionId).file;
  assert.ok(file);
  assert.equal(path.relative(fixture.agentDir, file).split(path.sep)[0], 'sessions');
  assert.notEqual(path.dirname(file), path.join(dataDir, 'sessions'));
  await waitFor(() => Boolean(store.session(sessionId).file));
  await service.dispose();
  assert.ok((await readSessionFile(file)).messages.some((m) => m.role === 'toolResult'));
  const restored = new Store(dataDir);
  await restored.load();
  const legacyFile = path.join(dataDir, 'sessions', path.basename(file));
  service = new AgentService(restored, new Workspace(dataDir));
  listen();
  await service.connect(sessionId);
  assert.ok(service.runtime.messages.some((m) => m.role === 'toolResult'));
  console.log('PASS persisted Pi JSONL and resumed history');
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    const sent = service.send(sessionId, '/gui-' + method, [], 'steer');
    await waitFor(() => service.runtime.dialogs.length === 1);
    await service.respond(
      service.runtime.dialogs[0].id,
      method === 'select'
        ? { value: 'B' }
        : method === 'confirm'
          ? { confirmed: false }
          : method === 'input'
            ? { value: '中文回复' }
            : { cancelled: true },
    );
    await sent;
    assert.equal(service.runtime.status, 'idle');
    assert.ok(service.runtime.notices.some((n) => n.includes('GUI_REPLY:' + method)));
  }
  await service.send(sessionId, '/gui-timeout', [], 'steer');
  // Pi's timeout starts before the desktop receives the dialog request over RPC.
  await waitFor(() => service.runtime.dialogs.length === 0, 2000);
  assert.equal(service.runtime.status, 'idle');
  assert.equal(service.runtime.dialogs.length, 0);
  assert.ok(service.runtime.notices.some((n) => n.includes('GUI_REPLY:timeout:undefined')));
  const other = randomUUID();
  restored.state.sessions.push({
    id: other,
    projectId,
    title: '被取消的切换',
    draft: '',
    attachments: [],
    lastStatus: 'idle',
    updatedAt: Date.now(),
  });
  await fs.writeFile(path.join(fixture.agentDir, 'cancel-switch'), 'cancel');
  await assert.rejects(service.connect(other), /取消了会话切换/);
  assert.equal(service.runtime.sessionId, sessionId);
  await fs.unlink(path.join(fixture.agentDir, 'cancel-switch'));
  console.log('PASS actual Pi extension dialogs, timeout, handled commands and cancelled switch');
  await service.send(sessionId, 'E2E_STOP：执行一个可中断的长命令。', [], 'steer');
  await waitFor(() => service.runtime.tools.some((t) => t.status === 'running'));
  await service.send(sessionId, '队列中的补充要求', [], 'steer');
  await service.send(sessionId, '队列中的后续任务', [], 'followUp');
  await waitFor(() => service.runtime.steering.length === 1 && service.runtime.followUp.length === 1);
  await service.stop();
  assert.equal(service.runtime.status, 'stopped');
  assert.equal(service.runtime.steering.length + service.runtime.followUp.length, 0);
  assert.match(restored.session(sessionId).draft, /队列中的后续任务/);
  await assert.rejects(fs.access(path.join(projectDir, 'should-not-exist.txt')));
  console.log('PASS actual Pi stop clears queues and interrupts shell');
  await service.send(sessionId, 'E2E_401', [], 'steer');
  await waitFor(() => service.runtime.status === 'error');
  assert.match(service.runtime.error ?? '', /401|Invalid API key/);
  console.log('PASS provider failure reaches visible error state');
  const chat = restored.createSession();
  await restored.save();
  await service.connect(chat.id);
  assert.equal((await service.testConnection(chat.id)).text, 'OK');
  const requestStart = provider.requests.length;
  await service.send(chat.id, 'E2E_CHAT：不打开项目也能对话。', [], 'steer');
  await waitFor(() => ['completed', 'error'].includes(service.runtime.status));
  assert.equal(service.runtime.status, 'completed', service.runtime.error ?? '');
  assert.equal(service.runtime.dialogs.length, 0);
  assert.equal(service.runtime.tools.length, 0);
  assert.ok(provider.requests.length > requestStart);
  for (const request of provider.requests.slice(requestStart)) assert.ok(request.tools?.length > 0);
  assert.ok(service.runtime.commands.some((c) => c.name === 'gui-select'));
  await assert.rejects(service.send(chat.id, '不能附加项目文件', ['输入 文件.txt'], 'steer'), /项目会话/);
  const chatFile = chat.file;
  assert.ok(chatFile);
  assert.equal(path.relative(fixture.agentDir, chatFile).split(path.sep)[0], 'sessions');
  assert.equal((await readSessionFile(chatFile)).cwd, await restored.sessionDirectory(chat.id));
  await service.connect(sessionId);
  assert.ok(service.runtime.messages.some((m) => m.role === 'toolResult'));
  await service.connect(chat.id);
  assert.ok(service.runtime.messages.some((m) => messageText(m).includes('E2E_CHAT')));
  assert.equal(service.runtime.tools.length, 0);
  console.log('PASS standalone chat, model probe, tools/extensions and project/chat history switching');
  await service.disconnect();
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  await fs.copyFile(restored.session(sessionId).file!, legacyFile);
  restored.session(sessionId).file = legacyFile;
  await restored.save();
  await service.connect(sessionId);
  assert.equal(restored.session(sessionId).file, legacyFile);
  const nativeChat = restored.createSession(projectId);
  await restored.save();
  await service.connect(nativeChat.id);
  assert.ok(nativeChat.file);
  assert.equal(path.relative(fixture.agentDir, nativeChat.file).split(path.sep)[0], 'sessions');
  await service.send(nativeChat.id, 'E2E_CHAT：原生目录会话。', [], 'steer');
  await waitFor(() => ['completed', 'error'].includes(service.runtime.status));
  assert.equal(service.runtime.status, 'completed', service.runtime.error ?? '');
  assert.ok((await readSessionFile(nativeChat.file)).messages.some((m) => m.role === 'assistant'));
  console.log('PASS new project/chat histories use Pi native directories after resuming legacy files');
  await service.disconnect();
  const settingsFile = path.join(fixture.agentDir, 'settings.json');
  const piSettings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  const customDir = path.join(fixture.dir, 'custom-pi-sessions');
  await fs.writeFile(settingsFile, JSON.stringify({ ...piSettings, sessionDir: customDir }));
  const customChat = restored.createSession(projectId);
  await restored.save();
  await service.connect(customChat.id);
  assert.ok(customChat.file);
  assert.equal(path.dirname(customChat.file), customDir);
  console.log('PASS Pi sessionDir configuration remains effective');
  await fs.writeFile(
    path.join(fixture.dir, 'result.json'),
    JSON.stringify(
      {
        result: 'PASS',
        engine: `Pi ${(await detectEnvironment(store.state.settings)).version} (unmodified)`,
        provider: 'deterministic localhost HTTP server',
        checks: [
          'connection probe',
          'read/write/command in Chinese path',
          'file attachment',
          'preexisting Git edits',
          'JSONL restore',
          'real extension select/confirm/input/editor and timeout',
          'cancelled session switch',
          'steer/follow_up queue',
          'stop process tree',
          '401 error',
          'standalone chat and connection probe',
          'standalone tools/extensions and project attachment boundary',
          'project/chat switching preserves separate histories',
          'native per-cwd directories and legacy resume without directory inheritance',
          'Pi sessionDir override is respected',
        ],
        events,
      },
      null,
      2,
    ),
  );
  console.log('Integration PASS:', fixture.dir);
} finally {
  await service.dispose();
  await provider.close();
}
