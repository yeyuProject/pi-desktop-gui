import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { prepareRealPiFixture } from '../tests/support/local-provider';
import { createGoalProvider } from '../tests/support/goal-provider';

process.env.PI_OFFLINE = '1';
const provider = await createGoalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'goal');
let service = new AgentService(fixture.store, new Workspace(fixture.dataDir));

interface GoalState {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'budget_limited' | 'usage_limited' | 'completed';
  revision: number;
  billedTokensUsed: number;
  timeUsedMs: number | null;
  tokenBudget?: number;
  tokensUsed: number;
  continuations: number;
  reason?: string;
  summary?: string;
  evidence?: string;
}

async function goalState(): Promise<GoalState | null | undefined> {
  const file = fixture.store.session(fixture.sessionId).file;
  if (!file) return undefined;
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const completeLines = text.endsWith('\n') ? text.trimEnd().split('\n') : text.split('\n').slice(0, -1);
  return completeLines
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .findLast((entry) => entry.type === 'custom' && entry.customType === 'desktop-goal')?.data;
}

async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 30000)
      throw new Error(
        `${message}: ${JSON.stringify({ requests: provider.count, runtime: service.runtime.status, error: service.runtime.error, goal: await goalState(), providerErrors: provider.errors })}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const send = (text: string) => service.send(fixture.sessionId, text, [], 'steer');
const settled = () => until(() => !service.hasPendingWork, 'Pi did not settle');

try {
  await service.connect(fixture.sessionId);
  assert.ok(service.runtime.commands.some((command) => command.name === 'goal'));
  const resources = await service.admin(fixture.sessionId, 'resources');
  assert.ok(resources.activeTools.includes('desktop_goal_update'));
  assert.ok(resources.activeTools.includes('desktop_goal_plan'));

  provider.reset('continue');
  await send('/goal Complete the deterministic integration verification.');
  await until(async () => (await goalState())?.status === 'completed', 'Goal did not complete');
  await settled();
  const completed = (await goalState())!;
  assert.equal(
    provider.count,
    2,
    'a partial text response must continue once, and completion must not start a third request',
  );
  assert.equal(completed.continuations, 1);
  assert.ok(completed.summary);
  assert.equal(service.runtime.tools.findLast((tool) => tool.name === 'desktop_goal_update')?.status, 'done');
  await send('/goal status');
  await settled();
  assert.equal(provider.count, 2, 'reading Goal status must not call the model');
  console.log(
    'PASS real Pi continues incomplete work once and completion terminates without another model call',
  );

  await send('/goal clear');
  provider.reset('mixed');
  await send('/goal Reject completion in a mixed tool batch, then complete in a separate response.');
  await until(async () => (await goalState())?.status === 'completed', 'Mixed-batch Goal did not finish');
  await settled();
  assert.equal(
    provider.count,
    2,
    'a rejected mixed completion must be followed by one standalone completion',
  );
  const completionTools = service.runtime.tools.filter((tool) => tool.name === 'desktop_goal_update');
  assert.deepEqual(
    completionTools.map((tool) => tool.status),
    ['error', 'done'],
  );
  assert.match(completionTools[0].output, /Goal 结果工具必须是本次回复唯一的直接工具调用/);
  assert.equal(service.runtime.tools.find((tool) => tool.name === 'read')?.status, 'done');
  assert.equal(
    (await goalState())!.tokensUsed,
    240,
    'completion must not allow a third model request after its terminal state',
  );
  console.log('PASS real Pi rejects mixed-batch completion and stops on the next standalone completion');

  await send('/goal clear');
  provider.reset('pause');
  await send('/goal Preserve progress across a user pause and explicit resume.');
  await until(() => provider.count === 2, 'Goal did not reach the held continuation');
  await send('/goal pause');
  await settled();
  await until(
    () => provider.requests.at(-1)?.closed === true,
    'Pause did not close the active provider stream',
  );
  const paused = (await goalState())!;
  assert.equal(paused.status, 'paused');
  assert.ok(paused.tokensUsed >= 120, 'usage from completed work must survive the pause');
  assert.equal(provider.count, 2);
  provider.reset('complete');
  await send('/goal resume');
  await until(async () => (await goalState())?.status === 'completed', 'Resumed Goal did not complete');
  await settled();
  assert.equal(provider.count, 1);
  assert.ok((await goalState())!.tokensUsed >= paused.tokensUsed, 'resume must preserve cumulative usage');
  console.log(
    'PASS real Pi pause cancels the active request and explicit resume preserves accumulated usage',
  );

  await send('/goal clear');
  provider.reset('hold');
  await send('/goal Restore this unfinished goal without starting background work.');
  await until(() => provider.count === 1, 'Goal did not start before reconnect');
  const unfinished = (await goalState())!;
  assert.equal(unfinished.status, 'active');
  const internal = service as unknown as { rpc: { killTree(): Promise<unknown> } };
  await internal.rpc.killTree();
  await until(
    () => service.runtime.status === 'interrupted' && service.runtime.crash?.cleanup === 'confirmed',
    'Pi process cleanup did not finish after interruption',
  );
  assert.equal(
    (await goalState())?.status,
    'active',
    'a killed process leaves its last persisted Goal state',
  );
  await service.dispose();
  service = new AgentService(fixture.store, new Workspace(fixture.dataDir));
  await service.connect(fixture.sessionId);
  await settled();
  const restored = (await goalState())!;
  assert.equal(restored.id, unfinished.id);
  assert.equal(restored.status, 'paused');
  assert.equal(provider.count, 1, 'reopening a session must not resume the old goal automatically');
  await send('/goal status');
  await settled();
  assert.equal(provider.count, 1);
  provider.reset('complete');
  await send('/goal resume');
  await until(async () => (await goalState())?.status === 'completed', 'Restored Goal did not resume');
  await settled();
  assert.equal(provider.count, 1);
  console.log(
    'PASS persisted Goal restores as paused and needs explicit resume before another model request',
  );

  await send('/goal clear');
  provider.reset('budget');
  await send('/goal --tokens 100 Stop this goal when the first response exhausts its token allowance.');
  await until(
    async () => (await goalState())?.status === 'budget_limited',
    'Token limit did not limit the Goal',
  );
  await settled();
  const limited = (await goalState())!;
  assert.equal(limited.tokenBudget, 100);
  assert.equal(
    limited.tokensUsed,
    240,
    'use authoritative Pi-reported tokens, including the response that crossed the limit',
  );
  assert.ok(limited.reason, 'the budget stop must explain why work stopped');
  assert.equal(provider.count, 2, 'budget exhaustion allows one wrap-up request');
  assert.equal(service.runtime.tools.findLast((tool) => tool.name === 'read')?.status, 'done');
  assert.ok(JSON.stringify(provider.requests.at(-1)?.body).includes('Goal 已达到用量上限。'));
  await send('/goal status');
  await settled();
  assert.equal(provider.count, 2);
  assert.deepEqual(provider.errors, []);
  console.log('PASS real Pi budget exhaustion finishes current tools and sends one wrap-up request');
  await send('/goal clear');
  provider.reset('long');
  await send('/goal Keep working through thirty automatic continuations.');
  await until(async () => (await goalState())?.status === 'completed', 'Long Goal did not complete');
  await settled();
  assert.equal(provider.count, 61);
  assert.equal((await goalState())!.continuations, 30);
  console.log('PASS thirty real Pi continuations complete without a hard limit');

  await send('/goal clear');
  provider.reset('cached');
  await send('/goal Verify cached usage across ten requests.');
  await until(async () => (await goalState())?.status === 'completed', 'Cached Goal did not complete');
  await settled();
  assert.equal(provider.count, 10);
  assert.equal((await goalState())!.tokensUsed, 15000);
  assert.equal((await goalState())!.billedTokensUsed, 915000);
  console.log('PASS real provider normalization excludes cached input');

  await send('/goal clear');
  provider.reset('quota');
  await send('/goal Show a distinct quota state.');
  await until(async () => (await goalState())?.status === 'usage_limited', 'Quota state missing');
  await settled();
  console.log('PASS provider quota errors stop in usage_limited');

  await send('/goal clear');
  provider.reset('edit');
  await send('/goal Original objective before steering.');
  await until(() => provider.count === 1, 'Edit scenario did not start');
  const editing = (await goalState())!;
  await service.goalAction(fixture.sessionId, {
    action: 'edit',
    goalId: editing.id,
    revision: editing.revision,
    objective: 'Updated objective after steering.',
  });
  assert.equal((await goalState())!.revision, 2);
  provider.release();
  await until(async () => (await goalState())?.status === 'completed', 'Edited Goal did not complete');
  await settled();
  assert.equal(provider.count, 2);
  assert.ok(JSON.stringify(provider.requests.at(-1)?.body).includes('Updated objective after steering.'));
  assert.ok(
    service.runtime.messages.some(
      (message) =>
        message.role === 'custom' && message.customType === 'desktop-goal-updated' && message.display,
    ),
  );
  console.log('PASS edit during streaming steers the new objective and revision');

  await send('/goal clear');
  provider.reset('budget-ignore');
  await send('/goal --tokens 100 Bound wrap-up even when the model continues calling tools.');
  await until(async () => (await goalState())?.status === 'budget_limited', 'Wrap-up guard not started');
  await settled();
  assert.ok(provider.count <= 4, `Wrap-up exceeded three requests: ${provider.count}`);
  assert.equal((await goalState())!.status, 'budget_limited');
  assert.deepEqual(provider.errors, []);
  console.log('PASS ignored wrap-up is bounded to three additional model requests');
} finally {
  await service.dispose().catch(() => {});
  await provider.close();
}
