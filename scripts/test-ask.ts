import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { readSessionFile } from '../electron/store';
import { DESKTOP_ASK_TOOL, readAskDetails, answerAskWithText } from '../shared/ask';
import { SessionSearch } from '../src/lib/session-search';
import { prepareRealPiFixture } from '../tests/support/local-provider';
import { createAskProvider, singleQuestion, multipleQuestions } from '../tests/support/ask-provider';

process.env.PI_OFFLINE = '1';
const provider = await createAskProvider();
const fixture = await prepareRealPiFixture(
  provider.baseUrl,
  path.join(os.tmpdir(), 'pi-desktop-ask-integration'),
);
let service = new AgentService(fixture.store, new Workspace(fixture.dataDir));
const id = fixture.sessionId;
fixture.store.session(id).approvalMode = 'readonly';
const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 30000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(
        `${label}: ${JSON.stringify({
          status: service.runtime.status,
          error: service.runtime.error,
          dialogs: service.runtime.dialogs,
          waiting: provider.waiting,
        })}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
const question = () => service.runtime.dialogs.find((dialog) => dialog.ask);
const waitQuestion = () => until(() => Boolean(question()), 'No question panel request');
const settled = () => until(() => !service.hasPendingWork, 'Task did not settle');
const details = () =>
  service.runtime.messages
    .filter((message) => message.role === 'toolResult' && message.toolName === DESKTOP_ASK_TOOL)
    .map((message) => readAskDetails(message.details))
    .filter((value) => value !== undefined);
const finish = async () => {
  await until(() => provider.waiting > 0, 'Model did not resume after answer');
  provider.respond('已收到回答，继续执行原任务。');
  await settled();
};
try {
  await service.connect(id);
  const resources = await service.admin(id, 'resources');
  assert.ok(resources.activeTools.includes(DESKTOP_ASK_TOOL));
  provider.respond({
    tool: 'desktop_plan',
    args: { steps: [{ text: '确定数据库并验证', status: 'in_progress' }] },
  });
  await service.send(id, '选择合适的数据库，再继续当前任务', [], 'steer');
  await until(() => Boolean(service.runtime.plan) && provider.waiting > 0, 'Plan did not arrive');
  const plan = structuredClone(service.runtime.plan);
  provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  await waitQuestion();
  assert.equal(service.runtime.status, 'waiting');
  assert.equal(question()!.expiresAt, undefined);
  assert.equal(service.runtime.dialogs.length, 1, 'readonly mode does not add an approval dialog');
  const userCount = service.runtime.messages.filter((message) => message.role === 'user').length;
  await assert.rejects(service.send(id, 'stale renderer send', [], 'steer'), /等待你的回答/);
  await assert.rejects(
    service.respond(question()!.id, {
      ask: {
        status: 'answered',
        answers: { database: { selected: ['invented'] } },
      },
    }),
    /题目中的选项/,
  );
  assert.ok(question());
  await service.respond(question()!.id, {
    ask: { status: 'answered', answers: { database: { selected: ['SQLite'] } }, note: '保留离线能力' },
  });
  await finish();
  assert.equal(service.runtime.messages.filter((message) => message.role === 'user').length, userCount);
  assert.deepEqual(service.runtime.plan, plan);
  assert.equal(details().at(-1)?.status, 'answered');
  assert.match(
    JSON.stringify(provider.requests.at(-1)!.messages.filter((message) => message.role === 'tool')),
    /SQLite/,
  );
  assert.match(
    JSON.stringify(provider.requests[0].messages.filter((message) => message.role === 'system')),
    /Do not ask for information you can obtain/,
  );
  console.log(
    'PASS real Pi question registration, readonly approval, same-turn answer, plan preservation and result details',
  );

  provider.respond({ tool: DESKTOP_ASK_TOOL, args: multipleQuestions });
  await service.send(id, '这次直接用文字回答第一个问题', [], 'steer');
  await waitQuestion();
  await service.respond(question()!.id, { ask: answerAskWithText(multipleQuestions, '采用内存数据库') });
  await finish();
  assert.equal(details().at(-1)?.status, 'answered');

  provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  await service.send(id, '验证跳过提问', [], 'steer');
  await waitQuestion();
  await service.respond(question()!.id, { skipped: true });
  await finish();
  assert.equal(details().at(-1)?.status, 'skipped');

  provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  await service.send(id, '验证停止提问', [], 'steer');
  await waitQuestion();
  await service.stop();
  await settled();
  assert.equal(service.runtime.dialogs.length, 0);
  assert.equal(details().at(-1)?.status, 'cancelled');
  console.log('PASS text answer, skip and stop cancellation with persisted status');

  const file = fixture.store.session(id).file!;
  const history = await readSessionFile(file);
  assert.ok(history.messages.some((message) => readAskDetails(message.details)?.status === 'cancelled'));
  const matches = new SessionSearch().search(history.messages, [], '保留离线能力');
  assert.ok(matches.length > 0);
  await service.dispose();
  service = new AgentService(fixture.store, new Workspace(fixture.dataDir));
  const restored = await service.history(id);
  assert.ok(restored.some((message) => readAskDetails(message.details)?.status === 'answered'));
  assert.ok(restored.some((message) => readAskDetails(message.details)?.status === 'cancelled'));
  console.log('PASS offline history restoration and search from persisted question details');

  provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  await service.send(id, '验证每回合最多三次', [], 'steer');
  for (let index = 0; index < 3; index++) {
    await waitQuestion();
    await service.respond(question()!.id, { skipped: true });
    await until(() => provider.waiting > 0, 'Model did not resume');
    provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  }
  await until(
    () =>
      service.runtime.tools.some((tool) => tool.output.includes('本轮提问次数已达上限')) &&
      provider.waiting > 0,
    'Fourth question not rejected',
  );
  assert.equal(service.runtime.dialogs.length, 0);
  provider.respond('本轮提问已达到上限，按推荐继续。');
  await settled();
  console.log('PASS fourth question rejected without opening a dialog');

  await service.dispose();
  const testBridge = path.join(fixture.dir, 'short-ask-timeout.mjs');
  await build({
    entryPoints: ['electron/pi-bridge.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: testBridge,
    external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai/compat'],
    plugins: [
      {
        name: 'short-test-question-timeout',
        setup(build) {
          build.onLoad({ filter: /[\\/]pi-ask\.ts$/ }, async ({ path: file }) => {
            const source = await fs.readFile(file, 'utf8');
            assert.equal(
              source.split('goalTimeoutMs = 600000').length,
              2,
              'test must only replace the explicit ten-minute timeout',
            );
            return {
              contents: source.replace('goalTimeoutMs = 600000', 'goalTimeoutMs = 150'),
              loader: 'ts',
              resolveDir: path.dirname(file),
            };
          });
        },
      },
    ],
  });
  service = new AgentService(fixture.store, new Workspace(fixture.dataDir), undefined, testBridge);
  const beforeGoal = (await service.history(id)).filter((message) => readAskDetails(message.details)).length;
  provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  await service.send(id, '/goal 验证超时继续工作以及提问不算无进展', [], 'steer');
  for (let index = 0; index < 3; index++) {
    await until(
      () => details().length === beforeGoal + index + 1 && provider.waiting > 0,
      'Goal timeout did not return a result',
    );
    assert.equal(details().at(-1)?.status, 'timeout_recommended');
    assert.equal(service.runtime.goal?.status, 'active');
    if (index < 2) provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  }
  provider.respond('按推荐继续当前目标。');
  await until(
    () => (service.runtime.goal?.continuations ?? 0) >= 1 && provider.waiting > 0,
    'Goal did not continue',
  );
  provider.respond({ tool: DESKTOP_ASK_TOOL, args: singleQuestion });
  await until(
    () => details().length === beforeGoal + 4 && provider.waiting > 0,
    'Goal continuation did not reset question limit',
  );
  assert.equal(details().at(-1)?.status, 'timeout_recommended');
  assert.equal(service.runtime.goal?.status, 'active');
  const goalEntries = (await fs.readFile(fixture.store.session(id).file!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(goalEntries.findLast((entry) => entry.customType === 'desktop-goal')?.data.noProgressRuns, 0);
  await service.stop();
  await settled();
  console.log(
    'PASS real Goal timeout, recommended choice, active continuation and per-turn question limit reset',
  );
} finally {
  await service.dispose().catch(() => {});
  await provider.close();
}
