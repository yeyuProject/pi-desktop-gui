import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { installDesktopBridge } from './support/bridge-fixture';
import { classifyReadTarget } from '../electron/approval-paths';
import {
  APPROVAL_ALLOW,
  APPROVAL_ALWAYS,
  APPROVAL_DENY,
  APPROVAL_PREFIX,
  decide,
  describe,
  grantForRequest,
  matchesGrant,
  type ApprovalMode,
  type ApprovalRequest,
} from '../shared/approval';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-read-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  await fs.mkdir(project);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(project, 'source.txt'), 'project source');
  await fs.writeFile(path.join(outside, 'id_rsa'), 'temporary test credential');
  await fs.symlink(outside, path.join(project, 'linked'), 'junction');
  await fs.link(path.join(outside, 'id_rsa'), path.join(project, 'hardlink.txt'));
  return { project, outside };
}

function bridge(mode: ApprovalMode, cwd: string, choice = APPROVAL_ALLOW) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const requests: { request: ApprovalRequest; options: string[] }[] = [];
  installDesktopBridge(
    {
      on: (name: string, handler: any) => {
        const previous = handlers.get(name);
        handlers.set(name, async (...args: any[]) => {
          const result = await previous?.(...args);
          return result?.block ? result : ((await handler(...args)) ?? result);
        });
      },
      registerCommand: () => {},
      registerTool: () => {},
    } as never,
    { PI_DESKTOP_APPROVAL: mode },
  );
  const ctx = {
    cwd,
    ui: {
      notify: () => {},
      select: async (title: string, options: string[]) => {
        requests.push({ request: JSON.parse(title.slice(APPROVAL_PREFIX.length)), options });
        return choice;
      },
    },
  };
  return {
    requests,
    call: (toolName: string, input: object) => handlers.get('tool_call')!({ toolName, input }, ctx),
  };
}

test('read policy fails closed without a verified project path', () => {
  for (const tool of ['read', 'grep', 'find', 'ls']) {
    assert.equal(decide('confirm', tool), 'ask');
    assert.equal(decide('readonly', tool), 'deny');
    assert.equal(decide('confirm', tool, 'project'), 'allow');
    assert.equal(decide('readonly', tool, 'project'), 'allow');
    assert.equal(decide('auto', tool, 'outside'), 'allow');
    const request = { ...describe(tool, { path: '../outside' }), readTarget: 'outside' as const };
    assert.equal(grantForRequest(request), undefined);
    assert.equal(matchesGrant({ id: 'legacy', kind: 'tool', toolName: tool }, request), false);
  }
  assert.equal(decide('readonly', 'tool_search'), 'allow');
});

test('read boundaries resolve native path aliases, links, hardlinks and missing paths', async (t) => {
  const { project, outside } = await fixture(t);
  for (const target of [
    '.',
    'source.txt',
    '@source.txt',
    pathToFileURL(path.join(project, 'source.txt')).href,
  ])
    assert.equal(await classifyReadTarget(project, target), 'project', target);
  for (const target of [
    outside,
    '../outside/id_rsa',
    '@../outside/id_rsa',
    'linked/id_rsa',
    'linked',
    'hardlink.txt',
    pathToFileURL(path.join(outside, 'id_rsa')).href,
    '~/missing-approval-file',
    'missing.txt',
    '',
    'invalid\0path',
  ])
    assert.equal(await classifyReadTarget(project, target), 'outside', target);
  // Pi tries curly-quote variants for missing read paths. The existing variant
  // points outside; the originally requested, nonexistent spelling must not pass.
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'id_rsa'), path.join(project, 'capture’s.txt'));
    assert.equal(await classifyReadTarget(project, "capture's.txt"), 'outside');
  }
});

test('all built-in reads require a separate approval outside the project, and readonly blocks them', async (t) => {
  const { project, outside } = await fixture(t);
  for (const tool of ['read', 'grep', 'find', 'ls']) {
    const input = { path: tool === 'read' ? path.join(outside, 'id_rsa') : outside, pattern: '*' };
    const confirm = bridge('confirm', project);
    assert.equal(await confirm.call(tool, input), undefined);
    assert.equal(await confirm.call(tool, input), undefined);
    assert.equal(confirm.requests.length, 2, tool);
    for (const { request, options } of confirm.requests) {
      assert.equal(request.kind, 'read');
      assert.equal(request.readTarget, 'outside');
      assert.equal(request.grant, undefined);
      assert.deepEqual(options, [APPROVAL_ALLOW, APPROVAL_DENY]);
    }
    assert.equal((await bridge('confirm', project, APPROVAL_ALWAYS).call(tool, input))?.block, true);
    assert.equal((await bridge('confirm', project, APPROVAL_DENY).call(tool, input))?.block, true);
    const readonly = bridge('readonly', project);
    assert.equal((await readonly.call(tool, input))?.block, true);
    assert.equal(readonly.requests.length, 0);
    assert.equal(
      await readonly.call(tool, { path: tool === 'read' ? 'source.txt' : '.', pattern: '*' }),
      undefined,
    );
    if (tool !== 'read') assert.equal(await readonly.call(tool, { pattern: '*' }), undefined);
  }
});

test('blocked direct and linked reads never reach the real Pi read tool', async (t) => {
  const { project, outside } = await fixture(t);
  const readonly = bridge('readonly', project);
  const tool = createReadTool(project);
  const execute = async (file: string) => {
    const blocked = await readonly.call('read', { path: file });
    return blocked ?? tool.execute('read', { path: file });
  };
  const allowed = await execute('source.txt');
  assert.ok(allowed.content.some((part: any) => part.type === 'text' && part.text === 'project source'));
  for (const file of [path.join(outside, 'id_rsa'), 'linked/id_rsa', 'hardlink.txt']) {
    const result = await execute(file);
    assert.equal(result.block, true);
    assert.equal(JSON.stringify(result).includes('temporary test credential'), false);
  }
});

test('project write grants never cover execution configuration, including aliases', async (t) => {
  const { project } = await fixture(t);
  await fs.mkdir(path.join(project, '.git'));
  await fs.mkdir(path.join(project, '.pi'));
  await fs.symlink(path.join(project, '.pi'), path.join(project, 'pi-link'), 'junction');
  const confirm = bridge('confirm', project, APPROVAL_ALWAYS);
  assert.equal(await confirm.call('write', { path: 'ordinary.txt', content: 'ok' }), undefined);
  assert.equal(await confirm.call('edit', { path: 'source.txt', edits: [] }), undefined);
  assert.equal(confirm.requests.length, 1);
  for (const file of [
    '.git/config',
    '.pi/extensions/injected.ts',
    'pi-link/extensions/injected.ts',
    '.gitattributes',
    '.gitmodules',
  ]) {
    const blocked = await confirm.call('write', { path: file, content: 'test' });
    assert.equal(blocked?.block, true, 'an unsupported always-allow response must fail closed');
    assert.deepEqual(confirm.requests.at(-1)!.options, [APPROVAL_ALLOW, APPROVAL_DENY]);
  }
  assert.equal(confirm.requests.length, 6);
});
