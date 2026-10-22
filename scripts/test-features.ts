import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { Configuration } from '../electron/configuration';
import { messageText, busy } from '../shared/types';
process.env.PI_OFFLINE = '1';
process.env.OPENAI_API_KEY = '';
process.env.MINIMAX_API_KEY = 'local-env-test-only';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'features');
const s = new AgentService(f.store, new Workspace(f.dataDir));
const config = new Configuration(f.store);
const png = (await fs.readFile(path.resolve('build/icon.png'))).toString('base64');
async function until(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 20000) throw new Error('Timeout ' + s.runtime.status + ' ' + s.runtime.error);
    await new Promise((r) => setTimeout(r, 40));
  }
}
async function assertEmptyExport(id: string) {
  for (const format of ['html', 'jsonl'] as const)
    await assert.rejects(s.captureExport(id, format, path.join(f.dir, 'empty.' + format)), {
      message: '会话尚未产生可导出的内容',
    });
}
try {
  const originalSession = f.store.session(f.sessionId);
  originalSession.updatedAt = 1;
  await assertEmptyExport(f.sessionId);
  await s.connect(f.sessionId);
  assert.equal(originalSession.updatedAt, 1, 'connecting is not conversation activity');
  assert.ok(originalSession.file, 'Pi allocates a path before the first message');
  await assert.rejects(fs.stat(originalSession.file), { code: 'ENOENT' });
  assert.equal(s.runtime.messages.length, 0);
  await assertEmptyExport(f.sessionId);
  assert.equal(provider.requests.length, 0, 'empty exports must not send a model request');
  console.log('PASS real Pi empty exports before and after explicit connection');
  await s.send(f.sessionId, 'IMAGE_E2E', [], 'steer', [
    { id: 'image', name: 'image.png', data: png, mimeType: 'image/png' },
  ]);
  await until(() => !busy(s.runtime.status));
  assert.equal(s.runtime.status, 'completed', s.runtime.error ?? '');
  assert.ok(originalSession.updatedAt > 1, 'messages advance conversation activity');
  assert.ok(
    provider.requests
      .at(-1)
      .messages.some(
        (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'image_url'),
      ),
  );
  assert.ok(
    s.runtime.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image')),
  );
  const exported = (await s.captureExport(f.sessionId, 'jsonl', path.join(f.dir, 'session.jsonl')))
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(exported.some((entry) => entry.message?.role === 'user'));
  assert.ok(exported.some((entry) => entry.message?.role === 'assistant'));
  console.log('PASS real Pi image delivery and history');
  await s.send(f.sessionId, 'SECOND_MESSAGE', [], 'steer');
  await until(() => !busy(s.runtime.status));
  const beforeTree = originalSession.updatedAt;
  const tree = await s.tree(f.sessionId);
  assert.equal(originalSession.updatedAt, beforeTree, 'reading the tree preserves recency');
  const user = tree.find((e) => e.role === 'user')!;
  assert.ok(user);
  const original = f.store.session(f.sessionId).file;
  await s.branch(f.sessionId, 'clone');
  const cloned = f.store.state.selectedSessionId!;
  assert.notEqual(cloned, f.sessionId);
  assert.notEqual(f.store.session(cloned).file, original);
  assert.ok(f.store.session(cloned).updatedAt >= beforeTree);
  assert.equal(originalSession.updatedAt, beforeTree, 'cloning does not modify the original');
  assert.equal(s.runtime.sessionId, f.sessionId, 'clone must leave the source process untouched');
  await s.connect(cloned);
  assert.ok(s.runtime.messages.some((m) => messageText(m).includes('SECOND_MESSAGE')));
  await s.connect(f.sessionId);
  assert.equal(originalSession.updatedAt, beforeTree, 'reopening history preserves recency');
  assert.equal(originalSession.unread, false, 'reopening history does not fabricate unread content');
  await s.branch(f.sessionId, 'fork', user.id);
  const forked = f.store.state.selectedSessionId!;
  assert.notEqual(forked, cloned);
  assert.equal(s.runtime.sessionId, f.sessionId, 'fork must leave the source process untouched');
  assert.equal(f.store.session(forked).draft, 'IMAGE_E2E');
  assert.equal(f.store.session(forked).images?.length, 1);
  assert.equal(f.store.session(f.sessionId).file, original);
  assert.ok(f.store.session(forked).updatedAt >= beforeTree);
  assert.equal(originalSession.updatedAt, beforeTree, 'forking does not modify the original');
  await s.connect(f.sessionId);
  const assistant = tree.find((e) => e.role === 'assistant')!;
  originalSession.updatedAt = 1;
  await s.branch(f.sessionId, 'navigate', assistant.id);
  assert.ok(originalSession.updatedAt > 1, 'changing the active branch is content activity');
  assert.ok(!s.runtime.messages.some((m) => messageText(m).includes('SECOND_MESSAGE')));
  await s.send(f.sessionId, 'BRANCHED_MESSAGE', [], 'steer');
  await until(() => !busy(s.runtime.status));
  const branches = await s.tree(f.sessionId);
  assert.ok(branches.some((e) => e.text.includes('SECOND_MESSAGE') && !e.active));
  assert.ok(branches.some((e) => e.text.includes('BRANCHED_MESSAGE') && e.active));
  console.log('PASS real tree navigation, fork and clone preserve original branches');
  console.log('PASS real Pi browsing preserves recency while messages and branches advance it');
  await s.option(f.sessionId, 'autoCompaction', true);
  assert.equal(s.runtime.autoCompaction, true);
  await s.option(f.sessionId, 'autoRetry', true);
  assert.equal(s.runtime.autoRetry, true);
  await s.option(f.sessionId, 'steeringMode', 'all');
  assert.equal(s.runtime.steeringMode, 'all');
  await s.option(f.sessionId, 'followUpMode', 'all');
  assert.equal(s.runtime.followUpMode, 'all');
  await s.send(f.sessionId, '!printf DESKTOP_BASH_TEST', [], 'steer');
  assert.ok(
    s.runtime.messages.some(
      (m) => m.role === 'bashExecution' && String(m.output).includes('DESKTOP_BASH_TEST'),
    ),
  );
  await s.send(f.sessionId, '!!printf DESKTOP_EXCLUDED', [], 'steer');
  assert.ok(s.runtime.messages.some((m) => m.role === 'bashExecution' && m.excludeFromContext === true));
  console.log('PASS native settings and direct shell with context inclusion/exclusion');
  const providers = await s.admin(f.sessionId, 'providers');
  assert.ok(providers.some((p: any) => p.id === 'openai' && p.apiKey));
  assert.equal(providers.find((p: any) => p.id === 'openai').authSource, undefined);
  assert.equal(providers.find((p: any) => p.id === 'minimax').authSource, 'environment');
  assert.equal(providers.find((p: any) => p.id === 'local-e2e').authSource, 'models_json_key');
  const login = s.admin(f.sessionId, 'login', { provider: 'openai', type: 'api_key' });
  await until(() => s.runtime.dialogs.length > 0);
  assert.ok(s.runtime.dialogs[0].title.startsWith('[密钥]'));
  await s.respond(s.runtime.dialogs[0].id, { value: 'local-test-credential' });
  await login;
  const authFile = path.join(f.agentDir, 'auth.json');
  assert.ok(JSON.parse(await fs.readFile(authFile, 'utf8')).openai);
  assert.equal(
    (await s.admin(f.sessionId, 'providers')).find((p: any) => p.id === 'openai').authSource,
    'stored',
  );
  assert.ok(!JSON.stringify(s.runtime).includes('local-test-credential'));
  await s.admin(f.sessionId, 'logout', { provider: 'openai' });
  assert.ok(!JSON.parse(await fs.readFile(authFile, 'utf8')).openai);
  const afterLogout = (await s.admin(f.sessionId, 'providers')).find((p: any) => p.id === 'openai');
  assert.equal(afterLogout.configured, false);
  assert.equal(afterLogout.authSource, undefined);
  console.log('PASS native API key login/logout without credential exposure');
  const minimaxLogin = s.admin(f.sessionId, 'login', { provider: 'minimax', type: 'api_key' });
  await until(() => s.runtime.dialogs.length > 0);
  await s.respond(s.runtime.dialogs[0].id, { value: 'local-minimax-test-key' });
  await minimaxLogin;
  assert.equal(
    (await s.admin(f.sessionId, 'providers')).find((p: any) => p.id === 'minimax').authSource,
    'stored',
  );
  await s.admin(f.sessionId, 'logout', { provider: 'minimax' });
  assert.ok(!JSON.parse(await fs.readFile(authFile, 'utf8')).minimax);
  const minimaxAfterLogout = (await s.admin(f.sessionId, 'providers')).find((p: any) => p.id === 'minimax');
  assert.equal(minimaxAfterLogout.configured, true);
  assert.equal(minimaxAfterLogout.authSource, 'environment');
  await s.admin(f.sessionId, 'logout', { provider: 'local-e2e' });
  assert.equal(
    (await s.admin(f.sessionId, 'providers')).find((p: any) => p.id === 'local-e2e').authSource,
    'models_json_key',
  );
  assert.ok(!JSON.stringify(minimaxAfterLogout).includes('local-env-test-only'));
  console.log('PASS logout reports remaining environment/models.json credentials without exposing keys');
  const resources = await s.admin(f.sessionId, 'resources');
  const extension = resources.resources.find((r: any) => r.path.endsWith('gui-e2e.js'));
  assert.ok(extension);
  await s.admin(f.sessionId, 'toggle_resource', { resource: extension, enabled: false });
  assert.ok(!s.runtime.commands.some((c) => c.name === 'gui-select'));
  await s.admin(f.sessionId, 'toggle_resource', { resource: extension, enabled: true });
  assert.ok(s.runtime.commands.some((c) => c.name === 'gui-select'));
  console.log('PASS actual extension disable/re-enable and reload');
  assert.match(
    (await s.captureExport(f.sessionId, 'html', path.join(f.dir, 'session.html'))).toString(),
    /<!DOCTYPE html>/i,
  );
  const settings = await config.read(f.sessionId, 'settings', false);
  const value = JSON.parse(settings.text);
  value.compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 };
  await s.disconnect();
  await config.save(f.sessionId, 'settings', false, { ...settings, text: JSON.stringify(value) });
  await s.connect(f.sessionId);
  await s.send(f.sessionId, 'LONG_MESSAGE ' + '保留上下文记录。'.repeat(2000), [], 'steer');
  await until(() => !busy(s.runtime.status));
  const result = await s.compact(f.sessionId, '保留重要内容');
  assert.ok(result.summary);
  assert.ok(result.tokensBefore > 0);
  assert.ok(
    s.runtime.messages.some((m) => messageText(m).includes('BRANCHED_MESSAGE')),
    'compaction must preserve the complete visible conversation',
  );
  await s.send(f.sessionId, 'AFTER_COMPACTION_FINAL_SUMMARY', [], 'steer');
  await until(() => !s.hasPendingWork);
  assert.equal(messageText(s.runtime.messages.findLast((m) => m.role === 'assistant')!), 'OK');
  assert.ok(s.runtime.messages.some((m) => messageText(m).includes('BRANCHED_MESSAGE')));
  console.log('PASS real HTML export and model-backed manual compaction');
  const chat = f.store.createSession();
  const beforeEmptyExport = provider.requests.length;
  await assertEmptyExport(chat.id);
  await s.connect(chat.id);
  assert.ok(chat.file);
  await assert.rejects(fs.stat(chat.file), { code: 'ENOENT' });
  await assertEmptyExport(chat.id);
  assert.equal(provider.requests.length, beforeEmptyExport);
  console.log('PASS real Pi standalone empty exports after explicit connection');
  await s.send(chat.id, '!printf STANDALONE_TOOLS', [], 'steer');
  assert.ok(s.runtime.messages.some((m) => String(m.output).includes('STANDALONE_TOOLS')));
  assert.ok(s.runtime.commands.some((c) => c.name === 'gui-select'));
  const cmd = s.send(chat.id, '/gui-select', [], 'steer');
  await until(() => s.runtime.dialogs.length > 0);
  await s.respond(s.runtime.dialogs[0].id, { value: 'A' });
  await cmd;
  console.log('PASS standalone shell tools and extension dialogs');
  await s.send(chat.id, 'E2E_SLOW', [], 'steer');
  await until(() => s.runtime.status === 'running');
  await s.send(chat.id, 'QUEUED_IMAGE', [], 'followUp', [
    { id: 'queued-image', name: 'image.png', data: png, mimeType: 'image/png' },
  ]);
  await s.stop();
  assert.equal(f.store.session(chat.id).images?.[0]?.id, 'queued-image');
  assert.match(f.store.session(chat.id).draft, /QUEUED_IMAGE/);
  console.log('PASS stop restores queued image with its text');
  console.log('Features integration PASS:', f.dir);
} finally {
  await s.dispose();
  await provider.close();
}
