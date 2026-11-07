import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PiRpc } from '../electron/rpc';
import { SessionAgents } from '../electron/session-agents';
import { Workspace } from '../electron/workspace';
import { prepareRealPiFixture } from '../tests/support/local-provider';
import { createTeamProvider } from '../tests/support/team-provider';
import { validateTeamResult } from '../shared/team';
process.env.PI_OFFLINE = '1';
const provider = await createTeamProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'team');
const service = new SessionAgents(fixture.store, new Workspace(fixture.dataDir));
const id = fixture.sessionId;
const lead = service.get(id);
const until = async (condition: () => boolean, label: string) => {
  const end = Date.now() + 45_000;
  while (!condition()) {
    if (Date.now() > end)
      throw new Error(
        `${label}: ${JSON.stringify({ diagnostics: service.diagnostics(), requests: provider.requests.length, pending: provider.pending, errors: lead.runtime.diagnostic })}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
try {
  await lead.connect(id);
  let resources = await lead.admin(id, 'resources');
  assert.ok(!resources.activeTools.includes('desktop_team_dispatch'));
  await service.team.setEnabled(id, true);
  await lead.setTeamEnabled(id, true);
  fixture.store.state.settings.team.concurrency = 2;
  resources = await lead.admin(id, 'resources');
  assert.ok(resources.activeTools.includes('desktop_team_dispatch'));
  await lead.send(id, '验证团队协作', [], 'steer');
  await until(() => provider.pending.length === 1, 'leader request');
  provider.reply(provider.pending[0], {
    name: 'desktop_plan',
    args: {
      steps: [
        { text: '并行调研', status: 'in_progress' },
        { text: '核对汇报', status: 'pending' },
      ],
    },
  });
  await until(() => provider.pending.length === 1, 'plan before dispatch');
  const planTurn = lead.runtime.plan?.turnId;
  assert.ok(planTurn);
  const requestsBeforeMembers = provider.requests.length;
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: {
      members: [
        { name: '调研甲', role: 'scout', task: '读取输入 文件.txt，汇报甲' },
        { name: '调研乙', role: 'scout', task: '读取输入 文件.txt，汇报乙' },
        { name: '调研丙', role: 'scout', task: '读取输入 文件.txt，汇报丙' },
      ],
    },
  });
  await until(() => provider.pending.length === 2, 'two concurrent members');
  const members = fixture.store.state.sessions.filter((s) => s.team?.leadId === id);
  assert.equal(members.length, 3);
  assert.equal(service.requiresStopConfirmation, true);
  assert.equal(service.hasPendingWork, true);
  assert.equal(members.filter((m) => m.team?.status === 'queued').length, 1);
  assert.equal(fixture.store.state.selectedSessionId, id);
  for (const index of provider.pending) {
    const names = provider.requests[index].tools.map((t: any) => t.function.name);
    assert.ok(!names.includes('desktop_team_dispatch'));
    assert.ok(!names.includes('desktop_ask_user'));
    assert.ok(!names.includes('desktop_goal_get'));
    assert.ok(!names.includes('bash'));
    assert.ok(names.includes('desktop_plan'));
  }
  const first = provider.pending[0];
  provider.reply(first, { name: 'read', args: { path: '输入 文件.txt' } });
  await until(
    () => provider.pending.some((index) => index >= requestsBeforeMembers + 2),
    'member read result',
  );
  const afterRead = provider.pending.find((index) => index >= requestsBeforeMembers + 2)!;
  provider.reply(afterRead, '汇报甲：读取已完成。');
  await until(
    () => provider.pending.length === 2 && members.every((m) => m.team?.status !== 'queued'),
    'queued member started',
  );
  for (const index of provider.pending) provider.reply(index, '成员汇报：已完成调研。');
  await until(
    () =>
      provider.pending.length === 1 &&
      provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'),
    'leader continues',
  );
  const resultMessage = lead.runtime.messages.findLast(
    (m) => m.role === 'toolResult' && m.toolName === 'desktop_team_dispatch',
  );
  validateTeamResult(resultMessage?.details);
  assert.ok(resultMessage.details.members.every((m) => m.status === 'completed'));
  assert.equal(lead.runtime.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(lead.runtime.plan?.turnId, planTurn);
  assert.equal(lead.runtime.plan?.steps[0].text, '并行调研');
  for (const session of members) {
    assert.ok(session.file);
    await fs.access(session.file!);
  }
  provider.reply(provider.pending[0], '负责人已核对所有汇报。');
  await until(() => !service.hasPendingWork, 'team settled');
  console.log(
    'PASS real Pi managed members, hidden tools, global concurrency, native session files, same-turn results',
  );
  await lead.send(id, '验证单写者与停止全部', [], 'steer');
  await until(() => provider.pending.length === 1, 'writer leader request');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: {
      members: [
        { name: '写甲', task: '等待要求再修改' },
        { name: '写乙', task: '等待要求再修改' },
      ],
    },
  });
  await until(
    () => provider.pending.length === 1 && fixture.store.state.sessions.some((s) => s.team?.name === '写乙'),
    'writer started',
  );
  const writers = fixture.store.state.sessions.filter((s) => s.team?.name.startsWith('写'));
  await until(() => writers.some((s) => s.team?.status === 'running'), 'writer running');
  assert.equal(writers.filter((s) => s.team?.status === 'queued').length, 1);
  const count = provider.requests.length;
  await service.team.stopLead(id, false);
  await until(
    () => provider.pending.length === 1 && provider.requests.length > count,
    'leader continues after stopping members',
  );
  const stopped = lead.runtime.messages.findLast((m) => m.toolName === 'desktop_team_dispatch');
  validateTeamResult(stopped?.details);
  assert.ok(stopped.details.members.every((m) => m.status === 'stopped'));
  assert.ok(!stopped.details.cancelled);
  provider.reply(provider.pending[0], '成员停止，负责人继续汇总。');
  await until(() => !service.hasPendingWork, 'stop-all settled');
  await lead.send(id, '验证停止负责人', [], 'steer');
  await until(() => provider.pending.length === 1, 'cancel leader request');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: {
      members: [
        { name: '停甲', role: 'scout', task: '等待并汇报' },
        { name: '停乙', role: 'scout', task: '等待并汇报' },
      ],
    },
  });
  await until(() => provider.pending.length === 2, 'cancel members running');
  provider.reply(provider.pending[0], '取消前已完成的汇报。');
  await until(
    () =>
      provider.pending.length === 1 &&
      fixture.store.state.sessions.some(
        (s) => s.team?.name.startsWith('停') && s.team.status === 'completed',
      ),
    'completed report before cancel',
  );
  await lead.stop();
  await until(() => !service.hasPendingWork, 'leader stop propagated');
  assert.equal(provider.pending.length, 0);
  assert.ok(
    fixture.store.state.sessions
      .filter((s) => s.team?.name.startsWith('停'))
      .every((s) => ['completed', 'stopped'].includes(s.team!.status)),
  );
  const cancelled = lead.runtime.messages.findLast((m) => m.toolName === 'desktop_team_dispatch');
  validateTeamResult(cancelled?.details);
  assert.equal(cancelled.details.cancelled, true);
  assert.equal(cancelled.details.members.filter((m) => m.status === 'completed').length, 1);
  assert.ok(cancelled.details.members.some((m) => m.report === '取消前已完成的汇报。'));
  console.log('PASS single writer, queued cancellation, stop-all continues leader, leader stop propagates');
  await lead.setApprovalMode(id, 'confirm');
  await lead.send(id, '验证成员审批及团队检查点', [], 'steer');
  await until(() => provider.pending.length === 1, 'approval leader');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '实现检查点', task: '写入 team-output.txt 并汇报' }] },
  });
  await until(
    () =>
      provider.pending.length === 1 &&
      fixture.store.state.sessions.some((s) => s.team?.name === '实现检查点'),
    'approval member',
  );
  const writer = fixture.store.state.sessions.find((s) => s.team?.name === '实现检查点')!;
  provider.reply(provider.pending[0], {
    name: 'write',
    args: { path: 'team-output.txt', content: '团队修改\n' },
  });
  await until(() => service.get(writer.id).runtime.dialogs.some((d) => d.approval), 'member approval');
  assert.equal(lead.runtime.dialogs.length, 0);
  const dialog = service.get(writer.id).runtime.dialogs.find((d) => d.approval)!;
  await service.get(writer.id).respond(dialog.id, { value: '允许一次' });
  await until(() => provider.pending.length === 1, 'writer report request');
  provider.reply(provider.pending[0], {
    name: 'bash',
    args: { command: 'echo shell-change > team-shell.txt' },
  });
  await until(() => service.get(writer.id).runtime.dialogs.some((d) => d.approval), 'shell approval');
  await service
    .get(writer.id)
    .respond(service.get(writer.id).runtime.dialogs.find((d) => d.approval)!.id, { value: '允许一次' });
  await until(() => provider.pending.length === 1, 'shell report');
  provider.reply(provider.pending[0], '已写入 team-output.txt 和 team-shell.txt。');
  await until(
    () =>
      provider.pending.length === 1 &&
      provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'),
    'checkpoint leader continuation',
  );
  provider.reply(provider.pending[0], '已核对修改。');
  await until(() => !service.hasPendingWork, 'checkpoint settled');
  const project = fixture.store.project(fixture.store.session(id).projectId!);
  const checkpoints = await lead.workspace.listCheckpoints(project, id);
  const preview = await lead.workspace.checkpointPreview(project, id, checkpoints.at(-1)!.id);
  assert.ok(
    preview.files.some((f) => f.path === 'team-output.txt' && !f.manual),
    JSON.stringify(preview),
  );
  const memberCheckpoints = await lead.workspace.listCheckpoints(project, writer.id);
  assert.ok(memberCheckpoints.length);
  const memberPreview = await lead.workspace.checkpointPreview(
    project,
    writer.id,
    memberCheckpoints.at(-1)!.id,
  );
  const changed = lead.runtime.messages.findLast((m) => m.toolName === 'desktop_team_dispatch');
  validateTeamResult(changed?.details);
  assert.deepEqual(changed.details.members[0].files.sort(), ['team-output.txt', 'team-shell.txt']);
  assert.equal(changed.details.members[0].added, 2);
  await lead.workspace.revert(project, ['team-output.txt', 'team-shell.txt'], undefined, {
    sessionId: id,
    checkpointId: preview.id,
    revision: preview.revision,
  });
  await assert.rejects(
    lead.workspace.revert(project, ['team-output.txt'], undefined, {
      sessionId: writer.id,
      checkpointId: memberPreview.id,
      revision: memberPreview.revision,
    }),
  );
  console.log(
    'PASS member approvals, shell change statistics, team checkpoint restore and revision protection',
  );

  const dispatchTask = async (name: string, role = 'scout') => {
    await lead.send(id, '验证 ' + name, [], 'steer');
    await until(() => provider.pending.length === 1, name + ' leader');
    provider.reply(provider.pending[0], {
      name: 'desktop_team_dispatch',
      args: { members: [{ name, role, task: '独立验证并汇报' }] },
    });
  };
  const memberReady = async (name: string) => {
    await until(
      () => provider.pending.length === 1 && fixture.store.state.sessions.some((s) => s.team?.name === name),
      name + ' member',
    );
    return fixture.store.state.sessions.find((s) => s.team?.name === name)!;
  };
  const finishLead = async () => {
    await until(
      () =>
        provider.pending.length === 1 &&
        provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'),
      'leader continuation',
    );
    const message = lead.runtime.messages.findLast((m) => m.toolName === 'desktop_team_dispatch');
    validateTeamResult(message?.details);
    provider.reply(provider.pending[0], '负责人已核对。');
    await until(() => !service.hasPendingWork, 'leader settled');
    return message.details;
  };
  await lead.setApprovalMode(id, 'readonly');
  const beforeReadonly = fixture.store.state.sessions.length;
  await dispatchTask('拒绝可写', 'worker');
  await until(() => provider.pending.length === 1, 'readonly rejection');
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /只读负责人只能分派只读角色/);
  assert.equal(fixture.store.state.sessions.length, beforeReadonly);
  provider.reply(provider.pending[0], '保持只读。');
  await until(() => !service.hasPendingWork, 'readonly settled');
  await dispatchTask('只读限制');
  await memberReady('只读限制');
  provider.reply(provider.pending[0], {
    name: 'bash',
    args: { command: 'echo forbidden > should-not-exist' },
  });
  await until(() => provider.pending.length === 1, 'readonly tool rejected');
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /not found|不允许|只读/i);
  await assert.rejects(fs.access(path.join(project.path, 'should-not-exist')));
  provider.reply(provider.pending[0], '只读汇报。');
  await finishLead();
  await lead.setApprovalMode(id, 'confirm');

  const roleFile = path.join(project.path, '.pi/agents/custom.md');
  const roleText = (body: string) =>
    `---\nname: custom\ndescription: 项目验证角色\ntools: read, grep, find, ls\nmodel: unavailable/model\n---\n${body}\n`;
  await fs.mkdir(path.dirname(roleFile), { recursive: true });
  await fs.writeFile(roleFile, roleText('原始冻结角色'));
  await dispatchTask('确认项目角色', 'custom');
  await until(
    () => lead.runtime.dialogs.some((d) => d.approval?.toolName === '项目角色'),
    'project role confirmation',
  );
  await lead.respond(lead.runtime.dialogs[0].id, { value: '允许一次' });
  const custom = await memberReady('确认项目角色');
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /原始冻结角色/);
  provider.reply(provider.pending[0], '项目角色汇报。');
  const fallback = await finishLead();
  assert.match(fallback.members[0].warning!, /角色指定的模型不可用/);
  await fs.writeFile(roleFile, roleText('更新后的角色'));
  assert.match(custom.team!.roleSnapshot.body, /原始冻结角色/);
  await dispatchTask('更新项目角色', 'custom');
  await until(
    () => lead.runtime.dialogs.some((d) => d.approval?.toolName === '项目角色'),
    'changed role reconfirmation',
  );
  await lead.respond(lead.runtime.dialogs[0].id, { value: '允许一次' });
  await memberReady('更新项目角色');
  provider.reply(provider.pending[0], '中文🙂'.repeat(12000));
  const truncated = await finishLead();
  assert.equal(truncated.members[0].reportTruncated, true);
  assert.ok(Buffer.byteLength(truncated.members[0].report!) <= 50 * 1024);
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /完整汇报见成员会话/);
  console.log(
    'PASS read-only enforcement, project role revision approval, frozen role, model fallback and report cap',
  );

  await dispatchTask('成员崩溃');
  const crashed = await memberReady('成员崩溃');
  const crashAgent = service.get(crashed.id) as unknown as { rpc: PiRpc };
  await crashAgent.rpc.killTree();
  const failure = await finishLead();
  assert.equal(failure.members[0].status, 'failed');
  assert.ok(failure.members[0].error);
  await dispatchTask('负责人崩溃');
  const interrupted = await memberReady('负责人崩溃');
  await (lead as unknown as { rpc: PiRpc }).rpc.killTree();
  await until(() => !service.hasPendingWork, 'crash cleanup');
  assert.equal(interrupted.team!.status, 'interrupted');
  assert.equal(provider.pending.length, 0);
  console.log('PASS member crash returns failure and leader crash interrupts managed members');

  await lead.send(id, '验证同回合最多分派三次', [], 'steer');
  for (let count = 1; count <= 3; count++) {
    await until(() => provider.pending.length === 1, 'dispatch limit leader');
    provider.reply(provider.pending[0], {
      name: 'desktop_team_dispatch',
      args: { members: [{ name: `次数${count}`, role: 'scout', task: '汇报' }] },
    });
    await memberReady(`次数${count}`);
    provider.reply(provider.pending[0], `第 ${count} 次完成`);
    await until(
      () =>
        provider.pending.length === 1 &&
        provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'),
      'dispatch limit continuation',
    );
  }
  const beforeLimit = fixture.store.state.sessions.length;
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '次数4', role: 'scout', task: '不应启动' }] },
  });
  await until(() => provider.pending.length === 1, 'fourth dispatch rejected');
  assert.equal(fixture.store.state.sessions.length, beforeLimit);
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /同一用户回合最多分派 3 次/);
  provider.reply(provider.pending[0], '汇总三次分派。');
  await until(() => !service.hasPendingWork, 'limit settled');
  console.log('PASS fourth dispatch rejected without creating a member');
  fixture.store.state.settings.team.memberTokenBudget = 100;
  await lead.send(id, '验证成员预算收尾', [], 'steer');
  await until(() => provider.pending.length === 1, 'budget leader');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '预算成员', role: 'scout', task: '读取文件并汇报' }] },
  });
  await until(
    () =>
      provider.pending.length === 1 && fixture.store.state.sessions.some((s) => s.team?.name === '预算成员'),
    'budget member',
  );
  provider.reply(provider.pending[0], { name: 'read', args: { path: '输入 文件.txt' } });
  await until(() => provider.pending.length === 1, 'budget wind-down');
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /成员用量已达到上限/);
  provider.reply(provider.pending[0], '达到上限，已完成读取。');
  await until(
    () =>
      provider.pending.length === 1 &&
      provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'),
    'budget result',
  );
  const limited = lead.runtime.messages.findLast((m) => m.toolName === 'desktop_team_dispatch');
  validateTeamResult(limited?.details);
  assert.equal(limited.details.members[0].status, 'budget_limited');
  provider.reply(provider.pending[0], '已收到收尾结果。');
  await until(() => !service.hasPendingWork, 'budget settled');
  await dispatchTask('超额请求');
  const capped = await memberReady('超额请求');
  for (let request = 0; request < 4; request++) {
    await until(() => provider.pending.length === 1, 'wind-down request');
    provider.reply(provider.pending[0], { name: 'read', args: { path: '输入 文件.txt' } });
  }
  const capResult = await finishLead();
  assert.equal(capResult.members[0].status, 'budget_limited');
  assert.equal(capResult.members[0].tokens, 480);
  await service.get(capped.id).send(capped.id, '之后的独立追问', [], 'steer');
  await until(() => provider.pending.length === 1, 'member follow-up');
  provider.reply(provider.pending[0], { name: 'read', args: { path: '输入 文件.txt' } });
  await until(() => provider.pending.length === 1, 'member follow-up report');
  provider.reply(provider.pending[0], '独立追问完成。');
  await until(() => !service.hasPendingWork, 'follow-up settled');
  assert.equal(service.get(capped.id).runtime.status, 'completed');
  assert.equal(capped.team!.status, 'budget_limited', 'follow-up never changes the returned dispatch');
  fixture.store.state.settings.team.memberTokenBudget = null;
  await lead.goalAction(id, { action: 'start', objective: '验证团队 Goal 预算', tokenBudget: 200 });
  await until(() => provider.pending.length === 1, 'goal leader');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '目标成员', role: 'scout', task: '读取文件并汇报' }] },
  });
  await until(
    () =>
      provider.pending.length === 1 && fixture.store.state.sessions.some((s) => s.team?.name === '目标成员'),
    'goal member',
  );
  provider.reply(provider.pending[0], { name: 'read', args: { path: '输入 文件.txt' } });
  await until(() => provider.pending.length === 1, 'goal wind-down');
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /成员用量已达到上限/);
  provider.reply(provider.pending[0], '团队额度用尽，汇报读取结果。');
  await until(
    () =>
      provider.pending.length === 1 &&
      provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'),
    'goal result',
  );
  assert.equal(lead.runtime.goal?.status, 'budget_limited');
  assert.ok(lead.runtime.goal!.tokensUsed >= 360);
  provider.reply(provider.pending[0], '已汇总 Goal 结果。');
  await until(() => !service.hasPendingWork, 'goal settled');
  console.log('PASS member budget, three-request hard limit, independent follow-up and Goal team accounting');
  await lead.goalAction(id, { action: 'clear', goalId: lead.runtime.goal!.id });
  await lead.goalAction(id, { action: 'start', objective: '验证暂停团队 Goal', tokenBudget: 10000 });
  await until(() => provider.pending.length === 1, 'pause goal leader');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '暂停成员', role: 'scout', task: '等待' }] },
  });
  await memberReady('暂停成员');
  await lead.goalAction(id, { action: 'pause', goalId: lead.runtime.goal!.id });
  await until(() => !service.hasPendingWork, 'goal pause stops members');
  assert.equal(provider.pending.length, 0);
  assert.equal(lead.runtime.goal!.status, 'paused');
  console.log('PASS Goal pause propagates to managed members');
  await lead.goalAction(id, { action: 'clear', goalId: lead.runtime.goal!.id });
  await lead.goalAction(id, {
    action: 'start',
    objective: '验证负责人已经耗尽额度时不启动成员',
    tokenBudget: 100,
  });
  await until(() => provider.pending.length === 1, 'exhausted goal');
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '零预算成员', role: 'scout', task: '不能启动' }] },
  });
  await until(() => provider.pending.length === 1, 'zero budget result');
  assert.ok(provider.requests.at(-1).tools.some((t: any) => t.function.name === 'desktop_team_dispatch'));
  const zeroBudget = lead.runtime.messages.findLast((m) => m.toolName === 'desktop_team_dispatch');
  validateTeamResult(zeroBudget?.details);
  assert.equal(zeroBudget.details.members[0].status, 'budget_limited');
  assert.equal(zeroBudget.details.members[0].tokens, 0);
  provider.reply(provider.pending[0], '额度已经耗尽，未启动成员。');
  await until(() => !service.hasPendingWork, 'zero budget settled');
  console.log('PASS exhausted leader Goal cannot start new member requests');
} finally {
  await service.dispose();
  await provider.close();
}
