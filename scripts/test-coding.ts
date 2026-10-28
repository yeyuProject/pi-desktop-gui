import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { Configuration } from '../electron/configuration';
import { busy } from '../shared/types';
process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'coding');
await fs.mkdir(path.join(f.agentDir, 'prompts'), { recursive: true });
await fs.writeFile(
  path.join(f.agentDir, 'prompts', 'review.md'),
  '---\ndescription: 审查指定文件\nargument-hint: "<文件> [重点]"\n---\n请审查 $1，重点关注 ${2:-可读性}。\n',
);
const workspace = new Workspace(f.dataDir);
const s = new AgentService(f.store, workspace);
const project = f.store.project(f.projectId);
await fs.writeFile(
  path.join(f.agentDir, 'extensions', 'settings-tool.js'),
  `export default function (pi) {
    pi.registerTool({
      name: 'settings_fixture', label: 'Settings fixture', description: 'Verify extension tool preservation',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'OK' }], details: {} }),
    });
  }`,
);
async function until(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 20000) throw new Error('Timeout ' + s.runtime.status + ' ' + s.runtime.error);
    await new Promise((r) => setTimeout(r, 40));
  }
}
try {
  await s.connect(f.sessionId);
  const review = s.runtime.commands.find((c) => c.name === 'review');
  assert.equal(review?.source, 'prompt');
  assert.equal(review?.argumentHint, '<文件> [重点]');
  console.log('PASS prompt template argument hints are read from frontmatter');

  await s.send(f.sessionId, 'E2E_FILES', [], 'steer');
  await until(() => !busy(s.runtime.status));
  assert.equal(s.runtime.status, 'completed', s.runtime.error ?? '');
  const reply = s.runtime.messages.findLast((m) => m.role === 'assistant')!;
  assert.equal(reply.model, 'local-e2e');
  assert.ok((reply.usage as any)?.totalTokens >= 0);
  const bash = s.runtime.tools.find((t) => t.name === 'bash' || t.name === 'powershell');
  assert.ok(bash, 'shell tool card present');
  console.log('PASS reply metadata and tool activity');

  await s.send(f.sessionId, 'E2E_EDIT', [], 'steer');
  await until(() => !busy(s.runtime.status));
  const edit = s.runtime.tools.find((t) => t.name === 'edit')!;
  assert.equal(edit.status, 'done', edit.output);
  assert.ok(edit.patch?.includes('-这是 E2E 测试的输入文件。'), String(edit.patch));
  assert.ok(edit.patch?.includes('+这是 E2E 测试的已编辑文件。'), String(edit.patch));
  await s.disconnect();
  await s.connect(f.sessionId);
  assert.ok(s.runtime.tools.find((t) => t.name === 'edit')?.patch, 'patch restored from history');
  console.log('PASS edit tool cards carry the unified patch, live and from history');

  // The E2E_EDIT turn re-captured the baseline, so only its edit counts as "this run".
  const output = path.join(f.projectDir, '输出结果.txt');
  const editRun = await workspace.changes(project, 'run', { sessionId: f.sessionId });
  assert.deepEqual(
    editRun.files.map((x) => x.path),
    ['输入 文件.txt'],
  );
  await assert.rejects(
    () => workspace.revert(project, ['输出结果.txt'], undefined, { sessionId: f.sessionId }),
    /不在本轮变更/,
  );
  const one = await workspace.revert(project, ['输入 文件.txt'], undefined, { sessionId: f.sessionId });
  assert.deepEqual(one, ['输入 文件.txt']);
  assert.equal(
    await fs.readFile(path.join(f.projectDir, '输入 文件.txt'), 'utf8'),
    '这是 E2E 测试的输入文件。\n',
  );
  assert.equal(await fs.readFile(output, 'utf8'), '真实 Pi 工具执行成功\n', 'earlier runs untouched');

  await s.send(f.sessionId, 'E2E_FILES', [], 'steer');
  await until(() => !busy(s.runtime.status));
  await fs.rm(output);
  await workspace.capture(project);
  await fs.writeFile(output, '新建\n');
  await fs.writeFile(path.join(f.projectDir, '输入 文件.txt'), '改动\n');
  const removed: string[] = [];
  const all = await workspace.revert(project, null, async (file) => {
    removed.push(path.basename(file));
    await fs.rm(file);
  });
  assert.deepEqual(all.sort(), ['输入 文件.txt', '输出结果.txt']);
  assert.deepEqual(removed, ['输出结果.txt']);
  await assert.rejects(() => fs.stat(output));
  assert.equal(await fs.readFile(path.join(f.projectDir, '已有修改.txt'), 'utf8'), 'before agent run\n');
  assert.equal((await workspace.changes(project, 'run')).files.length, 0);
  console.log('PASS revert one file, then the whole run; pre-existing edits and new files handled');

  const tree = await s.tree(f.sessionId);
  const user = tree.find((e) => e.role === 'user')!;
  await s.admin(f.sessionId, 'set_label', { entryId: user.id, label: '  回滚点  ' });
  assert.equal((await s.tree(f.sessionId)).find((e) => e.id === user.id)?.label, '回滚点');
  await s.admin(f.sessionId, 'set_label', { entryId: user.id, label: '' });
  assert.equal((await s.tree(f.sessionId)).find((e) => e.id === user.id)?.label, undefined);
  console.log('PASS session tree labels set and cleared through Pi');

  const config = new Configuration(f.store);
  const doc = await config.read(f.sessionId, 'settings', false);
  const next = JSON.parse(doc.text);
  next.retry = { ...next.retry, maxRetries: 5 };
  await config.save(f.sessionId, 'settings', false, { ...doc, text: JSON.stringify(next) });
  const saved = JSON.parse(await fs.readFile(path.join(f.agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.retry.maxRetries, 5);
  assert.equal(saved.defaultModel, 'local-e2e', 'unrelated settings preserved');
  console.log('PASS settings form writes only edited keys');

  const builtins = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
  const assertTools = async (expected: string[]) => {
    const resources = await s.admin(f.sessionId, 'resources');
    assert.deepEqual(
      resources.activeTools.filter((name: string) => builtins.includes(name)),
      expected,
    );
    assert.ok(resources.activeTools.includes('settings_fixture'), 'extension tools remain active');
  };
  for (const tools of [['grep'], []]) {
    const document = await config.read(f.sessionId, 'settings', false);
    await config.save(f.sessionId, 'settings', false, {
      ...document,
      text: JSON.stringify({ ...JSON.parse(document.text), defaultTools: tools }),
    });
    await s.scheduleReload();
    await assertTools(tools);
  }
  await s.disconnect();
  await s.connect(f.sessionId);
  await assertTools([]);
  const projectDocument = await config.read(f.sessionId, 'settings', true);
  await config.save(f.sessionId, 'settings', true, {
    ...projectDocument,
    text: JSON.stringify({ ...JSON.parse(projectDocument.text), defaultTools: ['grep'] }),
  });
  await s.scheduleReload();
  await assertTools(['grep']);
  console.log(
    'PASS saved tool settings override recorded history on reload/reconnect while preserving extension tools',
  );
} finally {
  await s.dispose().catch(() => {});
  await provider.close();
}
