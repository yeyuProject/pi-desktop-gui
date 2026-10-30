import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isWindows } from '../electron/platform';
import { normalizePiToolPath } from '../electron/pi/tool-path';
import {
  grantForRequest,
  matchesGrant,
  describe,
  APPROVAL_ALLOW,
  APPROVAL_ALWAYS,
  APPROVAL_DENY,
} from '../shared/approval';
import { classifyWriteTarget } from '../electron/approval-paths';
import { installDesktopBridge } from './support/bridge-fixture';
import { DESKTOP_BRIDGE_COMMAND } from '../shared/pi-bridge';

test('tool path normalization follows Pi 1.1 native aliases before checking boundaries', () => {
  const cwd = path.join(os.tmpdir(), 'pi-tool-path');
  assert.equal(normalizePiToolPath(cwd, '@../outside.txt'), path.resolve(cwd, '../outside.txt'));
  assert.equal(normalizePiToolPath(cwd, 'with\u00a0space.txt'), path.join(cwd, 'with space.txt'));
  assert.equal(normalizePiToolPath(cwd, '~/x.txt'), path.join(os.homedir(), 'x.txt'));
  assert.equal(
    normalizePiToolPath(cwd, pathToFileURL(path.join(cwd, 'x.txt')).href),
    path.join(cwd, 'x.txt'),
  );
  if (isWindows) {
    for (const value of ['/c/tools/x.txt', '/mnt/c/tools/x.txt', '/cygdrive/c/tools/x.txt'])
      assert.equal(normalizePiToolPath(cwd, value), 'C:\\tools\\x.txt');
    assert.equal(normalizePiToolPath(cwd, '~\\x.txt'), path.join(os.homedir(), 'x.txt'));
  }
});

test('shell grants match only the reviewed full command, including arguments and tool', () => {
  const grant = grantForRequest(describe('bash', { command: 'npm test tests/a.test.ts' }))!;
  assert.equal(grant.kind, 'shell-exact');
  assert.equal(matchesGrant(grant, describe('bash', { command: 'npm test tests/a.test.ts' })), true);
  for (const command of [
    'npm test tests/b.test.ts',
    'npm publish',
    'npm test-other',
    'npm test && rm -rf build',
    'npm run test',
  ])
    assert.equal(matchesGrant(grant, describe('bash', { command })), false, command);
  assert.equal(matchesGrant(grant, describe('powershell', { command: 'npm test tests/a.test.ts' })), false);
});

test('shell operators, expansions, quotes and wrappers receive exact grants only', () => {
  const commands = [
    'npm test && echo injected',
    'npm test || echo injected',
    'npm test; echo injected',
    'npm test | cat',
    'npm test > out',
    'npm test >> out',
    'npm test < input',
    'npm test 2>&1',
    'npm test & echo injected',
    'npm test\necho injected',
    'npm test\r\necho injected',
    'npm test\recho injected',
    'npm test `id`',
    'npm test $(id)',
    'npm test ${SHELL}',
    'npm test $PATH',
    'npm test %PATH%',
    'npm test @args',
    'npm test !PATH!',
    'npm test "$(id)"',
    "npm test 'a; b'",
    'npm test \\"; echo injected',
    'npm test \\\necho injected',
    'npm test (id)',
    'npm test {a,b}',
    'npm test <(id)',
    'npm test >(cat)',
    'npm test # hidden',
    'npm test\0echo injected',
    'npm test\u2028echo injected',
    'npm test\\; echo injected',
    'VAR=value npm test',
    'env PATH=/evil npm test',
    'command npm test',
    'bash -c npm',
    'pwsh -Command Write-Output',
    'git -c alias.test=command test',
    'npm exec arbitrary',
    'npx arbitrary',
    'node -e code',
    'python3.11 -c code',
    'Invoke-Expression something',
    './npm test',
    'npm.exe test',
  ];
  assert.ok(commands.length >= 25);
  for (const command of commands) {
    const request = describe('bash', { command });
    const grant = grantForRequest(request)!;
    assert.equal(grant.kind, 'shell-exact', command);
    assert.equal(matchesGrant(grant, request), true);
    assert.equal(matchesGrant(grant, describe('bash', { command: command + ' other' })), false);
  }
});

test('argument-based execution and writes cannot reuse approvals for the same executable', () => {
  for (const [command, changed] of [
    ['rg TODO', 'rg --pre=sh TODO'],
    ['sed -n 1p README.md', 'sed -i s/a/b/ config.txt'],
    ['git log', 'git log --output=config.txt'],
    ['git grep TODO', 'git grep --open-files-in-pager=sh TODO'],
    ['git diff', 'git diff --ext-diff'],
    ['npm test', 'npm test --script-shell=sh'],
    ['pytest tests/a.py', 'pytest -p arbitrary'],
  ]) {
    const request = describe('bash', { command });
    assert.equal(matchesGrant(grantForRequest(request)!, describe('bash', { command: changed })), false);
    const legacy = {
      id: 'legacy',
      kind: 'shell-prefix' as const,
      toolName: 'bash',
      command: command.split(' ')[0],
    };
    assert.equal(matchesGrant(legacy, request), false, 'legacy grants must fail closed');
    assert.equal(matchesGrant(legacy, describe('bash', { command: changed })), false);
  }
});

test('write grants resolve links, missing children, sibling boundaries and sensitive targets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-approval-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const outside = path.join(dir, 'project-other');
  await fs.mkdir(project);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(project, 'linked'), 'junction');
  await fs.symlink(project, path.join(dir, 'project-link'), 'junction');
  await fs.writeFile(path.join(outside, 'linked-file.txt'), 'outside');
  await fs.link(path.join(outside, 'linked-file.txt'), path.join(project, 'hard-link.txt'));
  await fs.mkdir(path.join(project, '.git'));
  await fs.mkdir(path.join(project, '.pi'));
  await fs.symlink(path.join(project, '.git'), path.join(project, 'git-alias'), 'junction');
  await fs.symlink(path.join(project, '.pi'), path.join(project, 'pi-alias'), 'junction');
  for (const target of ['src/new.ts', path.join(project, 'plain.txt')])
    assert.equal(await classifyWriteTarget(project, target), 'project', target);
  for (const target of [
    '../project-other/file.txt',
    '@../project-other/file.txt',
    pathToFileURL(path.join(outside, 'file.txt')).href,
    'linked/new/file.txt',
    'hard-link.txt',
    outside,
    '',
    'bad\0path',
    '.git',
    '.git/config',
    '.git/hooks/pre-commit',
    '.pi/extensions/injected.ts',
    '.pi/settings.json',
    '.gitattributes',
    'src/.gitattributes',
    '.gitmodules',
    '.GIT/config',
    'nested/.PI/extensions/injected.ts',
    'git-alias/config',
    'pi-alias/extensions/injected.ts',
    pathToFileURL(path.join(project, '.git/config')).href,
  ])
    assert.equal(await classifyWriteTarget(project, target), 'outside', target);
  for (const target of [
    '.env',
    '.env.production',
    'auth.json',
    'credentials.json',
    'id_rsa',
    'x.pem',
    'linked/auth.json',
    '@.env',
    pathToFileURL(path.join(project, '.env')).href,
  ])
    assert.equal(await classifyWriteTarget(project, target), 'sensitive', target);
  assert.equal(await classifyWriteTarget(path.join(dir, 'project-link'), 'file.ts'), 'project');
  if (isWindows) {
    assert.equal(await classifyWriteTarget(project, '.env.'), 'sensitive');
    assert.equal(await classifyWriteTarget(project, 'plain.txt:stream'), 'outside');
    assert.equal(await classifyWriteTarget(project, 'NUL'), 'outside');
    const msys = outside
      .replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase())
      .replaceAll('\\', '/');
    assert.equal(await classifyWriteTarget(project, msys + '/file.txt'), 'outside');
  }
  const request = { ...describe('write', { path: 'src/a.ts' }), writeTarget: 'project' as const };
  const grant = grantForRequest(request)!;
  assert.equal(matchesGrant(grant, { ...request, toolName: 'edit' }), true);
  for (const writeTarget of ['outside', 'sensitive'] as const) {
    assert.equal(grantForRequest({ ...request, writeTarget }), undefined);
    assert.equal(matchesGrant(grant, { ...request, writeTarget }), false);
  }
});

test('bridge publishes scoped grants, revokes them and resets them on session start and mode exit', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-approval-bridge-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = new Map<string, (...args: any[]) => any>();
  let handler: (...args: any[]) => Promise<any>;
  installDesktopBridge(
    {
      on: (name: string, hook: any) => {
        const previous = hooks.get(name);
        hooks.set(name, async (...args: any[]) => {
          const result = await previous?.(...args);
          return result?.block ? result : ((await hook(...args)) ?? result);
        });
      },
      registerCommand: (name: string, command: any) => {
        if (name === DESKTOP_BRIDGE_COMMAND) handler = command.handler;
      },
      registerTool: () => {},
      getActiveTools: () => ['desktop_plan'],
      setActiveTools: () => {},
    } as any,
    { PI_DESKTOP_APPROVAL: 'confirm' },
  );
  const requests: any[] = [],
    events: any[] = [];
  let choice = APPROVAL_ALWAYS;
  const ctx: any = {
    cwd: dir,
    sessionManager: { getBranch: () => [], getSessionId: () => 'approval-v014-test' },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      select: async (title: string, options: string[]) => {
        requests.push({ title, options });
        return choice;
      },
      notify: (message: string) => events.push(JSON.parse(message.slice('__PI_DESKTOP__'.length))),
    },
  };
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx);
  const bridge = (method: string, params = {}) =>
    handler!(Buffer.from(JSON.stringify({ id: 'test', method, params })).toString('base64'), ctx);
  await call('npm test a.ts');
  await call('npm test a.ts');
  assert.equal(requests.length, 1);
  const grant = events.at(-1).grants[0];
  assert.equal(grant.command, 'npm test a.ts');
  assert.equal(grant.kind, 'shell-exact');
  await bridge('revoke_approval', { id: grant.id });
  await call('npm test a.ts');
  assert.equal(requests.length, 2);
  await call('npm test && echo other');
  assert.equal(requests.length, 3);
  await hooks.get('tool_call')!({ toolName: 'write', input: { path: 'normal.txt', content: 'x' } }, ctx);
  choice = APPROVAL_ALLOW;
  await hooks.get('tool_call')!({ toolName: 'write', input: { path: '.env', content: 'secret' } }, ctx);
  assert.deepEqual(requests.at(-1).options, [APPROVAL_ALLOW, APPROVAL_DENY]);
  await hooks.get('session_start')!({}, ctx);
  assert.ok(events.some((event) => event.type === 'desktop_session_start'));
  assert.deepEqual(events.findLast((event) => event.type === 'desktop_approval_grants').grants, []);
  choice = APPROVAL_ALWAYS;
  await call('npm test a.ts');
  await bridge('approval_mode', { mode: 'auto' });
  assert.deepEqual(events.at(-1).data.approvalGrants, []);
  await bridge('approval_mode', { mode: 'confirm' });
  await call('npm test a.ts');
  await bridge('revoke_approval');
  assert.deepEqual(events.at(-1).data.approvalGrants, []);
});
