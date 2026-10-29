import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { readSessionFile } from '../electron/store';
import { prepareRealPiFixture } from '../tests/support/local-provider';
import { createPlanProvider, planSteps, nextPlanSteps } from '../tests/support/plan-provider';

process.env.PI_OFFLINE = '1';
const provider = await createPlanProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'plan');
let service = new AgentService(fixture.store, new Workspace(fixture.dataDir));
const id = fixture.sessionId;
const session = fixture.store.session(id);
session.approvalMode = 'confirm';
const until = async (condition: () => boolean, label: string) => {
  const end = Date.now() + 30000;
  while (!condition()) {
    if (Date.now() > end)
      throw new Error(
        `${label}: ${JSON.stringify({ status: service.runtime.status, error: service.runtime.error, dialogs: service.runtime.dialogs, requests: provider.requests.length })}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
const settled = () => until(() => !service.hasPendingWork, 'Pi did not settle');
const rows = async () =>
  (await fs.readFile(session.file!, 'utf8'))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
try {
  await service.connect(id);
  const resources = await service.admin(id, 'resources');
  assert.ok(resources.activeTools.includes('desktop_plan'));
  provider.respond(planSteps);
  await service.send(id, '检查登录输入，修复问题，运行测试并核对结果', [], 'steer');
  await until(() => Boolean(service.runtime.plan) && provider.waiting > 0, 'Plan did not arrive');
  const first = structuredClone(service.runtime.plan!);
  assert.deepEqual(first.steps, planSteps);
  assert.equal(first.turnId, service.runtime.messages.find((m) => m.role === 'user')!.timestamp);
  assert.equal(service.runtime.dialogs.length, 0);
  const system = JSON.stringify(provider.requests[0].messages.filter((m) => m.role === 'system'));
  assert.ok(
    system.includes('Use desktop_plan only when the task clearly needs three or more distinct steps.'),
  );
  assert.ok(system.includes('Updating the plan is not progress by itself'));
  assert.ok(provider.requests[0].tools?.some((tool) => tool.function?.name === 'desktop_plan'));
  await service.send(id, '补充：还要核对空输入', [], 'steer');
  provider.respond(nextPlanSteps);
  await until(
    () => service.runtime.plan?.steps[1].status === 'in_progress' && provider.waiting > 0,
    'Plan update did not arrive',
  );
  assert.equal(service.runtime.plan?.turnId, first.turnId, 'steering keeps the original task identity');
  provider.respond('本轮结束，仍有验证步骤未完成。');
  await settled();
  const saved = structuredClone(service.runtime.plan);
  assert.deepEqual((await readSessionFile(session.file!)).plan, saved);
  const records = await rows();
  const firstEntry = records.find(
    (row) => row.customType === 'desktop-plan' && row.data?.steps[0].status === 'in_progress',
  );
  const noPlanEntry = records.find((row) => row.type === 'message' && row.message.role === 'user');
  const lastEntry = records.at(-1);
  console.log(
    'PASS real Pi tool registration, prompt guidelines, confirm approval, streaming updates, steering identity, persistence',
  );

  await service.dispose();
  service = new AgentService(fixture.store, new Workspace(fixture.dataDir));
  await service.history(id);
  assert.deepEqual(service.runtime.plan, saved, 'offline history restores the plan');
  await service.connect(id);
  assert.deepEqual(service.runtime.plan, saved, 'Pi restart restores the same current branch');
  await service.branch(id, 'navigate', firstEntry.id);
  assert.deepEqual(service.runtime.plan?.steps, planSteps);
  await service.branch(id, 'navigate', noPlanEntry.id);
  assert.equal(service.runtime.plan, null);
  await service.branch(id, 'navigate', lastEntry.id);
  assert.deepEqual(service.runtime.plan, saved);
  console.log('PASS offline/restart and earlier/empty branch restoration');

  await service.send(id, '新的简单问答', [], 'steer');
  await until(() => service.runtime.plan === null && provider.waiting > 0, 'New task did not clear plan');
  provider.respond('简单问答无需计划。');
  await settled();
  assert.equal((await readSessionFile(session.file!)).plan, null);
  assert.equal((await rows()).findLast((row) => row.customType === 'desktop-plan').data, null);

  provider.respond(planSteps);
  await service.send(id, '/goal 检查普通计划工具与 Goal 互斥', [], 'steer');
  await until(
    () => service.runtime.tools.some((tool) => tool.name === 'desktop_plan' && tool.status === 'error'),
    'Active Goal did not reject desktop_plan',
  );
  assert.equal(service.runtime.plan, null);
  assert.match(
    service.runtime.tools.findLast((tool) => tool.name === 'desktop_plan')!.output,
    /desktop_goal_plan/,
  );
  await service.stop();
  await settled();
  console.log('PASS new task clears persisted state and active Goal rejects ordinary plans');
} finally {
  await service.dispose().catch(() => {});
  await provider.close();
}
