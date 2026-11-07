import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type ApprovalMode } from '../shared/approval';
import { parseState } from '../electron/store-state';
import { builtinTeamRoles } from '../electron/team-roles';
import {
  DEFAULT_TEAM_SETTINGS,
  formatTeamResult,
  isTeamSettings,
  roleApprovalCeiling,
  stricterApprovalMode,
  truncateTeamReport,
  validateDispatchRequest,
  validateTeamResult,
  type TeamResult,
} from '../shared/team';

const member = { name: '调研', task: '找出入口并汇报' };
test('team dispatch accepts 1–8 independent tasks and rejects malformed/escaping references', () => {
  validateDispatchRequest({
    members: [
      member,
      { ...member, name: '实现', role: 'worker', files: ['src/a.ts:2-4'], include_changes: true },
    ],
  });
  for (const input of [
    null,
    {},
    { members: [] },
    { members: Array(9).fill(member) },
    { members: [member, member] },
    { members: [{ ...member, task: ' ' }] },
    { members: [{ ...member, name: 'x'.repeat(25) }] },
    { members: [{ ...member, task: 'x'.repeat(8001) }] },
    ...['../a', '/tmp/a', 'C:\\a', 'a/../b', 'a#L0', 'a:2-1', 'a\0b'].map((file) => ({
      members: [{ ...member, files: [file] }],
    })),
    { members: [{ ...member, files: Array(21).fill('a') }] },
    { members: [{ ...member, include_changes: 'yes' }] },
  ])
    assert.throws(() => validateDispatchRequest(input));
});
test('approval ceilings never relax a read-only leader or role; team tools themselves do not write', () => {
  const modes: ApprovalMode[] = ['readonly', 'confirm', 'auto'];
  for (let a = 0; a < modes.length; a++)
    for (let b = 0; b < modes.length; b++)
      assert.equal(stricterApprovalMode(modes[a], modes[b]), modes[Math.min(a, b)]);
  for (const mode of modes)
    for (const tool of ['desktop_team_dispatch', 'desktop_team_roles'])
      assert.equal(decide(mode, tool), 'allow');
  assert.equal(roleApprovalCeiling({ tools: ['read', 'grep', 'ls', 'find'] }), 'readonly');
  assert.equal(roleApprovalCeiling({ tools: [] }), 'readonly');
  assert.equal(roleApprovalCeiling({ tools: ['read', 'bash'] }), 'auto');
  assert.equal(roleApprovalCeiling({}), 'auto');
  for (const tool of ['bash', 'powershell', 'write', 'edit', 'custom_tool'])
    assert.equal(decide('readonly', tool), 'deny');
});
test('report truncation caps UTF-8 bytes without broken code points and records where to find the rest', () => {
  for (const text of ['x'.repeat(100_000), '中文🙂'.repeat(30_000)]) {
    const result = truncateTeamReport(text);
    assert.equal(result.reportTruncated, true);
    assert.ok(Buffer.byteLength(result.report) <= 50 * 1024);
    assert.ok(!result.report.includes('\uFFFD'));
    assert.ok(text.startsWith(result.report));
  }
  assert.deepEqual(truncateTeamReport('短汇报'), { report: '短汇报', reportTruncated: false });
  const result: TeamResult = {
    version: 1,
    leadId: 'lead',
    dispatchId: 'dispatch',
    toolCallId: 'call',
    startedAt: 1,
    endedAt: 2,
    members: [
      {
        sessionId: 'member',
        name: '调研',
        role: 'scout',
        task: '调查入口',
        writable: false,
        status: 'completed',
        tokens: 5,
        billedTokens: 10,
        cost: 0,
        added: 0,
        removed: 0,
        files: [],
        recent: [],
        report: '结论',
        reportTruncated: true,
      },
    ],
  };
  validateTeamResult(result);
  assert.match(formatTeamResult(result), /完整汇报见成员会话/);
  assert.throws(() =>
    validateTeamResult({ ...result, members: [{ ...result.members[0], status: 'running' }] }),
  );
  assert.throws(() => validateTeamResult({ ...result, members: [{ ...result.members[0], tokens: -1 }] }));
});
test('team index recovery interrupts members without losing unrelated sessions', () => {
  const base = { id: 'lead', title: '负责人', updatedAt: 1, lastStatus: 'running', teamEnabled: true };
  const role = builtinTeamRoles[0];
  const link = {
    leadId: 'lead',
    dispatchId: 'dispatch',
    toolCallId: 'call',
    name: '调研',
    role: role.name,
    roleSnapshot: role,
    task: '找入口',
    approvalMode: 'readonly',
    status: 'running',
  };
  const parsed = parseState({
    version: 1,
    projects: [],
    settings: { team: { ...DEFAULT_TEAM_SETTINGS, concurrency: 20 } },
    sessions: [
      base,
      { ...base, id: 'member', team: link, unread: true },
      { ...base, id: 'invalid', team: { ...link, roleSnapshot: {} } },
    ],
  });
  assert.equal(parsed.discardedSessions, 1);
  assert.equal(parsed.repairedSettings, 1);
  assert.equal(parsed.state.sessions[1].team?.status, 'interrupted');
  assert.equal(parsed.state.sessions[1].unread, false);
  assert.equal(parsed.state.sessions[1].teamEnabled, false);
  assert.equal(parsed.state.sessions[0].teamEnabled, true);
  assert.deepEqual(parsed.state.settings.team, DEFAULT_TEAM_SETTINGS);
  assert.ok(isTeamSettings({ ...DEFAULT_TEAM_SETTINGS, memberTokenBudget: null }));
  assert.equal(isTeamSettings({ ...DEFAULT_TEAM_SETTINGS, memberTokenBudget: 0 }), false);
});
