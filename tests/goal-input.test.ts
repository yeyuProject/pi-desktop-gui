import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { hasSessionData } from '../electron/session-lifecycle';
import { parseState } from '../electron/store-state';
import {
  editGoalDraft,
  exitGoalCommand,
  goalCommandPreview,
  isGoalStartMessage,
  parseGoalCommand,
  readGoalDraft,
  sameGoalDraft,
  validateGoalStartInput,
  withGoalBudget,
} from '../shared/goal-input';
import type { GoalSnapshot } from '../shared/goal';
import type { Message } from '../shared/types';

test('Goal command preview budgets and Escape preserve the objective, including embedded commands', () => {
  const command = '/goal --tokens 500k 说明 --tokens 2m 和 /goal edit';
  assert.deepEqual(goalCommandPreview(command), {
    objective: '说明 --tokens 2m 和 /goal edit',
    tokenBudget: 500000,
  });
  assert.equal(exitGoalCommand(command), '说明 --tokens 2m 和 /goal edit');
  assert.equal(withGoalBudget(command, 2000000), '/goal --tokens 2000000 说明 --tokens 2m 和 /goal edit');
  assert.equal(withGoalBudget(command), '/goal 说明 --tokens 2m 和 /goal edit');
  for (const command of ['status', 'pause', 'resume', 'clear', 'edit', 'edit 新目标'])
    assert.equal(goalCommandPreview('/goal ' + command), undefined);
  assert.equal(goalCommandPreview('//goal objective'), undefined);
  assert.ok(goalCommandPreview('/goal --tokens invalid text')?.error);
  assert.throws(() => parseGoalCommand('--tokens invalid text'));
  assert.deepEqual(parseGoalCommand('edit 新目标'), { action: 'edit', objective: '新目标' });
  assert.throws(() => validateGoalStartInput({ objective: 'x'.repeat(4001), draftText: '' }));
  validateGoalStartInput({ objective: '4000字外的材料不属于目标正文', draftText: '材料'.repeat(5000) });
});

test('independent editor and mode survive storage; corrupt mode never discards ordinary draft', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-goal-draft-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  session.draftGoal = { kind: 'start', tokenBudget: 500000 };
  assert.equal(hasSessionData(session), true);
  session.draft = '保留的普通草稿';
  session.attachments = ['file.md'];
  session.draftSnippets = [{ id: 'piece', text: '原片段', offset: 2 }];
  const goal = { id: 'goal-1', revision: 2, objective: '原目标' } as GoalSnapshot;
  session.draftGoal = editGoalDraft(goal, session.draftGoal);
  if (session.draftGoal.kind === 'edit') session.draftGoal.objective = '编辑中的文字';
  await store.save();
  const restored = new Store(dir);
  await restored.load();
  assert.deepEqual(restored.session(session.id), JSON.parse(JSON.stringify(session)));
  const editor = restored.session(session.id).draftGoal!;
  assert.equal(editor.kind, 'edit');
  assert.deepEqual(editor.kind === 'edit' && editor.restore, { kind: 'start', tokenBudget: 500000 });
  assert.equal(sameGoalDraft(editor, { ...editor }), true);
  assert.equal(sameGoalDraft(editor, { ...editor, revision: 3 } as typeof editor), false);
  const corrupt = structuredClone(store.state);
  (corrupt.sessions[0] as any).draftGoal = { kind: 'edit', revision: -1, objective: 'bad' };
  const repaired = parseState(corrupt).state;
  assert.equal(repaired.sessions[0].draftGoal, undefined);
  assert.equal(repaired.sessions[0].draft, session.draft);
  assert.deepEqual(repaired.sessions[0].draftSnippets, session.draftSnippets);
  assert.equal(readGoalDraft({ kind: 'start', tokenBudget: 0 }), undefined);
});

test('durable Goal marker labels only its immediate user message, excluding later messages', () => {
  const messages = [
    { role: 'custom', customType: 'desktop-goal-start', display: false, content: 'Goal' },
    { role: 'custom', customType: 'desktop-goal-context', display: false, content: 'context' },
    { role: 'user', content: 'original input' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'supplement' },
  ] as Message[];
  assert.equal(isGoalStartMessage(messages, 2), true);
  assert.equal(isGoalStartMessage(messages, 3), false);
  assert.equal(isGoalStartMessage(messages, 4), false);
});

for (const outcome of [
  'sent',
  'cancelled',
  'new-text',
  'new-budget',
  'storage-failed',
  'stopped',
  'no-vision',
] as const) {
  test(`Goal start uses one bridge and preserves unsent state: ${outcome}`, async (t) => {
    const { AgentService } = await import('../electron/agent');
    const { Workspace } = await import('../electron/workspace');
    const { emptyRuntime } = await import('../shared/types');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-goal-send-'));
    const store = new Store(dir);
    await store.load();
    const session = store.createSession();
    session.title = 'Existing conversation';
    // Explicit Goal mode treats command-looking text literally.
    session.draft = outcome === 'sent' ? '! preserve this as a goal' : '/literal goal text';
    session.draftGoal = { kind: 'start', tokenBudget: 500000 };
    await store.save();
    const service = new AgentService(store, new Workspace(dir));
    service.runtime = {
      ...emptyRuntime(),
      connected: true,
      sessionId: session.id,
      model: { id: 'test', provider: 'fixture', name: 'Fixture', input: ['text'] },
    };
    const internal = service as any;
    const calls: any[] = [];
    internal.rpc = {
      closed: false,
      bridge: async (method: string, args: any) => {
        calls.push({ method, args });
        if (outcome === 'new-text') session.draft = 'a newer draft';
        if (outcome === 'new-budget') session.draftGoal = { kind: 'start', tokenBudget: 2000000 };
        return { applied: outcome !== 'cancelled' };
      },
      request: async (method: string) => {
        throw new Error('Unexpected ordinary request: ' + method);
      },
    };
    t.mock.method(internal, 'ensureConnected', async () => {});
    t.mock.method(internal, 'applyTaskSelection', async () => {});
    t.after(async () => {
      internal.rpc = undefined;
      service.runtime.status = 'idle';
      await service.dispose();
      await store.flush().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    });
    const start = {
      objective: session.draft,
      draftText: session.draft,
      draftGoal: structuredClone(session.draftGoal),
    };
    if (outcome === 'storage-failed' || outcome === 'stopped') {
      const save = store.save.bind(store);
      t.mock.method(store, 'save', async () => {
        if (outcome === 'storage-failed') throw new Error('simulated disk failure');
        internal.stopEpoch++;
        await save();
      });
    }
    const images =
      outcome === 'no-vision'
        ? [
            {
              id: 'image',
              name: 'reference.png',
              mimeType: 'image/png',
              data: (await fs.readFile('build/icon.png')).toString('base64'),
            },
          ]
        : [];
    const sending = service.send(session.id, start.objective, [], 'steer', images, start);
    if (['storage-failed', 'stopped', 'no-vision'].includes(outcome)) {
      await assert.rejects(sending, /simulated disk failure|取消|图片能力/);
      assert.equal(calls.length, 0);
    } else {
      await sending;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'goal_action');
      assert.equal(calls[0].args.firstMessage.text, start.objective);
    }
    if (outcome === 'sent') {
      assert.equal(session.draft, '');
      assert.equal(session.draftGoal, undefined);
    } else {
      assert.equal(session.draft, outcome === 'new-text' ? 'a newer draft' : start.objective);
      assert.deepEqual(
        session.draftGoal,
        outcome === 'new-budget' ? { kind: 'start', tokenBudget: 2000000 } : start.draftGoal,
      );
    }
  });
}
