import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  listTeamRoles,
  parseTeamRole,
  readTeamRole,
  saveTeamRole,
  deleteTeamRole,
} from '../electron/team-roles';
const raw = (name: string, tools = 'read, grep, find, ls', body = '只读调研') =>
  `---\nname: ${name}\ndescription: 测试角色\ntools: ${tools}\n---\n${body}\n`;
test('role frontmatter accepts Pi string/array spellings, preserves models and rejects unsafe fields', () => {
  assert.deepEqual(parseTeamRole(raw('scout'), 'user').tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(parseTeamRole(raw('scout', '[read, ls]'), 'user').tools, ['read', 'ls']);
  assert.notEqual(
    parseTeamRole(raw('scout'), 'project').revision,
    parseTeamRole(raw('scout', 'read', 'changed'), 'project').revision,
  );
  for (const text of [
    '',
    '---\n[]\n---\nbody',
    raw('../a'),
    raw('a', '[read, 2]'),
    raw('a', 'desktop_team_dispatch'),
    raw('a', 'desktop_ask_user'),
    raw('a', 'desktop_goal_get'),
  ])
    assert.throws(() => parseTeamRole(text, 'user'));
});
test('role priority, project trust, revisions and immutable snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-team-roles-'));
  try {
    const context = { agentDir: path.join(root, 'agent'), cwd: path.join(root, 'project'), trusted: true };
    await fs.mkdir(context.cwd, { recursive: true });
    let roles = await listTeamRoles(context);
    assert.equal(roles.length, 4);
    assert.ok(roles.every((r) => r.source === 'builtin' && !r.editable));
    const user = await saveTeamRole(context, { name: 'scout', source: 'user', text: raw('scout') });
    const project = await saveTeamRole(context, {
      name: 'scout',
      source: 'project',
      text: raw('scout', 'read', '项目'),
    });
    roles = await listTeamRoles(context);
    assert.equal(roles.find((r) => r.name === 'scout')?.revision, project.revision);
    assert.equal(
      (await listTeamRoles({ ...context, trusted: false })).find((r) => r.name === 'scout')?.revision,
      user.revision,
    );
    const frozen = structuredClone(project);
    const updated = await saveTeamRole(context, {
      name: 'scout',
      source: 'project',
      text: raw('scout', 'read', '更新'),
      revision: project.revision,
    });
    assert.notEqual(updated.revision, frozen.revision);
    assert.match(frozen.body, /项目/);
    await assert.rejects(
      saveTeamRole(context, {
        name: 'scout',
        source: 'project',
        text: raw('scout'),
        revision: frozen.revision,
      }),
      /重新读取/,
    );
    await assert.rejects(deleteTeamRole(context, 'project', 'scout', frozen.revision), /重新读取/);
    const document = await readTeamRole(context, 'project', 'scout');
    assert.equal(document.role.revision, updated.revision);
    await deleteTeamRole(context, 'project', 'scout', updated.revision);
    assert.equal((await listTeamRoles(context)).find((r) => r.name === 'scout')?.source, 'user');
    await fs.writeFile(path.join(context.agentDir, 'agents', 'bad.md'), '---\nname: [\n---');
    assert.equal((await listTeamRoles(context)).length, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('role editor refuses linked files/directories and project escapes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires extra privileges');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-team-role-paths-'));
  try {
    const context = { agentDir: path.join(root, 'agent'), cwd: path.join(root, 'project'), trusted: true };
    await fs.mkdir(path.join(context.agentDir, 'agents'), { recursive: true });
    await fs.mkdir(context.cwd, { recursive: true });
    const outside = path.join(root, 'outside.md');
    await fs.writeFile(outside, raw('linked'));
    await fs.symlink(outside, path.join(context.agentDir, 'agents', 'linked.md'));
    const role = (await listTeamRoles(context)).find((r) => r.name === 'linked')!;
    assert.equal(role.editable, false);
    await assert.rejects(
      saveTeamRole(context, { name: 'linked', source: 'user', text: raw('linked'), revision: role.revision }),
      /链接/,
    );
    await fs.symlink(context.agentDir, path.join(context.cwd, '.pi'));
    await assert.rejects(
      saveTeamRole(context, { name: 'new', source: 'project', text: raw('new') }),
      /项目外/,
    );
    assert.equal(await fs.readFile(outside, 'utf8'), raw('linked'));
    await fs.rm(path.join(context.agentDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(context.agentDir, 'linked-agents'));
    await fs.symlink(path.join(context.agentDir, 'linked-agents'), path.join(context.agentDir, 'agents'));
    await assert.rejects(saveTeamRole(context, { name: 'new', source: 'user', text: raw('new') }), /链接/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
