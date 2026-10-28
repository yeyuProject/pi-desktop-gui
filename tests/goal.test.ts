import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, readSessionFile } from '../electron/store';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { readLargeTranscript } from '../electron/large-transcript';
import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionToolContext,
  SessionBoundaryDraft,
  SessionEntry,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { registerDesktopGoal } from '../electron/pi-goal';
import { GOAL_BUDGET_PRESETS, GOAL_DIALOG_TITLE, parseGoalBudget, type GoalSnapshot } from '../shared/goal';
import {
  DESKTOP_GOAL_ENTRY_TYPE,
  MAX_GOAL_CONTINUATIONS,
  parseGoalCommand,
  readGoalState,
  type DesktopGoalState,
} from '../electron/goal-state';

function assistant(tokens: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'Working on the goal.' }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'fixture',
    usage: {
      input: Math.max(0, tokens - 1),
      output: tokens ? 1 : 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function harness(initial: SessionEntry[] = []) {
  const entries = structuredClone(initial);
  const hooks = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  const messages: string[] = [];
  const notices: { message: string; level: string }[] = [];
  const updates: (GoalSnapshot | null)[] = [];
  const aborts: (DesktopGoalState | undefined)[] = [];
  let activeTools: string[] | undefined;
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  const append = (draft: SessionBoundaryDraft) => {
    const entry = {
      ...structuredClone(draft),
      id: String(entries.length + 1),
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    entries.push(entry);
  };
  const ctx = {
    isIdle: () => true,
    model: { id: 'fixture', provider: 'fixture' },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    abort: () => aborts.push(readGoalState(entries)),
    sessionManager: { getBranch: () => structuredClone(entries) },
    ui: {
      setStatus() {
        throw new Error('Goal must use structured state, never status text.');
      },
      setWidget() {
        throw new Error('Goal must use structured state, never a widget.');
      },
      notify: (message: string, level: string) => {
        if (message.startsWith('__PI_DESKTOP__'))
          updates.push(JSON.parse(message.slice('__PI_DESKTOP__'.length)).goal);
        else notices.push({ message, level });
      },
      select: async () => undefined,
      editor: async () => undefined,
      input: async () => undefined,
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) =>
      hooks.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (_name: string, value: { handler: typeof command }) => {
      command = value.handler;
    },
    appendEntry: (customType: string, data: unknown) => append({ type: 'custom', customType, data }),
    getActiveTools: () => activeTools ?? [...tools.keys()],
    sendUserMessage: (message: string) => messages.push(message),
  } as unknown as ExtensionAPI;
  const controller = registerDesktopGoal(pi);
  const emit = async (event: ExtensionEvent) => hooks.get(event.type)?.(event, ctx);
  const toolCtx: ExtensionToolContext = {
    ...ctx,
    tools: [],
    executeTool: async () => {
      throw new Error('This fixture does not execute nested tools.');
    },
  };
  const rawTool = (name: string, parameters: Record<string, string>, callId = 'fixture-call') =>
    tools.get(name)!.execute(callId, parameters, undefined, undefined, toolCtx);
  const boundary = async (outcome: AgentBeforeSettleEvent['outcome'] = 'completed') => {
    const result = (await emit({
      type: 'agent_before_settle',
      entries: [],
      continue: false,
      outcome,
      context: {
        contextEntries: [],
        contextMessages: [],
        llmMessages: [],
        pendingMessages: [],
        canContinue: false,
      },
    })) as { entries: SessionBoundaryDraft[]; continue: boolean } | undefined;
    for (const entry of result?.entries ?? []) append(entry);
    return result;
  };
  return {
    entries,
    ctx,
    messages,
    notices,
    updates,
    action: (value: unknown) => controller.action(value, ctx),
    aborts,
    tools,
    emit,
    boundary,
    state: () => readGoalState(entries),
    command: async (input: string) => {
      const sent = messages.length;
      await command(input, ctx);
      if (messages.length > sent) await emit({ type: 'agent_start' });
    },
    activeTools: (value: string[]) => {
      activeTools = value;
    },
    rawTool,
    tool: async (name: string, parameters: Record<string, string>) => {
      await emit({
        type: 'message_end',
        message: {
          ...assistant(0),
          content: [{ type: 'toolCall', id: 'fixture-call', name, arguments: parameters }],
        },
      });
      return rawTool(name, parameters);
    },
    usedTool: () =>
      emit({ type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write', args: {} }),
    usage: (tokens: number) => emit({ type: 'message_end', message: assistant(tokens) }),
  };
}

test('Goal budget presets default to unlimited and reject invalid custom limits', () => {
  assert.deepEqual(GOAL_BUDGET_PRESETS.map(parseGoalBudget), [undefined, 500000, 2000000, 5000000]);
  assert.equal(parseGoalBudget(' 800k '), 800000);
  for (const value of ['0', '-1', '1.2k', 'lots', '9007199254740992'])
    assert.throws(() => parseGoalBudget(value), /上限/);
});

test('cold history restores the current branch Goal without connecting or reading a later abandoned branch', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-goal-history-'));
  const store = new Store(directory);
  await store.load();
  const session = store.createSession();
  session.file = path.join(directory, 'goal.jsonl');
  const h = harness();
  await h.command('原分支目标');
  await h.tool('desktop_goal_complete', {
    goal_id: h.state()!.id,
    summary: '原分支完成',
    evidence: '检查通过',
  });
  const original = h.state()!;
  const records = [
    { type: 'session', id: session.id, cwd: directory },
    ...h.entries,
    {
      type: 'custom',
      customType: DESKTOP_GOAL_ENTRY_TYPE,
      id: 'abandoned',
      parentId: null,
      data: { ...original, id: 'other', status: 'active' },
    },
    {
      type: 'message',
      id: 'tail',
      parentId: h.entries.at(-1)!.id,
      message: { role: 'user', content: '原分支后续问题', timestamp: 100 },
    },
  ];
  await fs.writeFile(session.file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const agent = new AgentService(store, new Workspace(directory));
  t.after(async () => {
    await agent.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const messages = await agent.history(session.id);
  assert.equal(messages.at(-1)!.content, '原分支后续问题');
  assert.equal(agent.runtime.connected, false);
  assert.equal(agent.runtime.sessionId, session.id);
  assert.equal(agent.runtime.goal!.id, original.id);
  assert.equal(agent.runtime.goal!.status, 'completed');
  assert.equal((await readSessionFile(session.file)).goal!.summary, '原分支完成');
  records.push({
    type: 'custom',
    id: 'clear',
    parentId: 'tail',
    customType: DESKTOP_GOAL_ENTRY_TYPE,
    data: null,
  } as never);
  await fs.writeFile(session.file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await agent.history(session.id);
  assert.equal(agent.runtime.goal, null);
});

test('a bounded large history still restores the Goal before its message preview cutoff', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-goal-large-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const h = harness();
  await h.command('较大会话的目标');
  await h.tool('desktop_goal_complete', { goal_id: h.state()!.id, summary: '完成', evidence: '检查通过' });
  const file = path.join(directory, 'large.jsonl');
  const records = [{ type: 'session', id: 'large', cwd: directory }, ...h.entries];
  await fs.writeFile(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  for (let i = 0; i < 2; i++)
    await fs.appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: 'large-' + i,
        parentId: i ? 'large-0' : h.entries.at(-1)!.id,
        message: { role: 'user', content: 'x'.repeat(9 * 1024 * 1024) },
      }) + '\n',
    );
  const transcript = await readLargeTranscript(file);
  assert.equal(transcript.messages.length, 1);
  assert.match(transcript.warning, /最多 16 MiB/);
  assert.equal(transcript.goal!.id, h.state()!.id);
  assert.equal(transcript.goal!.status, 'completed');
});

test('structured Goal events cover every status, usage, continuation, budget adjustment and clear', async () => {
  const h = harness();
  await h.emit({ type: 'session_start', reason: 'resume' });
  assert.equal(h.updates.at(-1), null);
  await h.command('--tokens 500k 修复登录');
  const id = h.state()!.id;
  assert.equal(h.updates.at(-1)!.status, 'active');
  assert.equal(h.updates.at(-1)!.tokenBudget, 500000);
  assert.equal(h.updates.at(-1)!.maxContinuations, 25);
  await h.usage(500000);
  assert.equal(h.updates.at(-1)!.status, 'paused');
  assert.equal(h.updates.at(-1)!.tokensUsed, 500000);
  await assert.rejects(h.action({ action: 'budget', goalId: id, tokenBudget: 400000 }), /上限/);
  await h.action({ action: 'budget', goalId: id, tokenBudget: 2000000 });
  assert.equal(h.updates.at(-1)!.status, 'active');
  assert.equal(h.updates.at(-1)!.tokenBudget, 2000000);
  await h.emit({ type: 'agent_start' });
  await h.usedTool();
  await h.boundary();
  assert.equal(h.updates.at(-1)!.continuations, 1);
  await h.tool('desktop_goal_blocked', { goal_id: id, summary: '需要凭据', evidence: '请求被拒绝' });
  assert.equal(h.updates.at(-1)!.status, 'blocked');
  assert.equal(h.updates.at(-1)!.reason, '需要凭据');
  await h.command('resume');
  await h.tool('desktop_goal_complete', { goal_id: id, summary: '已修好', evidence: '**测试通过**' });
  assert.equal(h.updates.at(-1)!.status, 'completed');
  assert.equal(h.updates.at(-1)!.evidence, '**测试通过**');
  await h.command('status');
  assert.match(h.notices.at(-1)!.message, /测试通过/);
  await h.command('clear');
  assert.equal(h.updates.at(-1), null);
  await assert.rejects(h.action({ action: 'clear', goalId: id }), /已变化/);
});

test('goal command parses only a leading token budget and preserves command text in objectives', () => {
  assert.deepEqual(parseGoalCommand('--tokens 20k 修复测试'), {
    action: 'start',
    objective: '修复测试',
    tokenBudget: 20000,
  });
  assert.deepEqual(parseGoalCommand('--tokens 2M 修复测试'), {
    action: 'start',
    objective: '修复测试',
    tokenBudget: 2000000,
  });
  assert.deepEqual(parseGoalCommand('说明 --tokens 10 的作用'), {
    action: 'start',
    objective: '说明 --tokens 10 的作用',
  });
  for (const text of [
    '--tokens 0 目标',
    '--tokens -1 目标',
    '--tokens 1.5k 目标',
    '--tokens 2k',
    '--tokens 9999999999999999999 目标',
  ])
    assert.throws(() => parseGoalCommand(text), /预算|用法/);
});

test('cancelling the single Goal dialog leaves no state and makes no model request', async () => {
  const cancelledGoal = harness();
  cancelledGoal.ctx.modelRegistry.hasConfiguredAuth = () => {
    throw new Error('Cancelled dialog must not resolve model authentication.');
  };
  cancelledGoal.ctx.ui.input = async (title) => {
    assert.equal(title, GOAL_DIALOG_TITLE);
    return undefined;
  };
  await cancelledGoal.command('');
  assert.equal(cancelledGoal.entries.length, 0);
  assert.equal(cancelledGoal.messages.length, 0);
  assert.equal(cancelledGoal.notices.length, 0);
});

test('new goal UI uses the normal start path with a budget or a blank budget', async () => {
  const budgeted = harness();
  budgeted.ctx.ui.input = async () =>
    JSON.stringify({ action: 'start', objective: '  完成目标里的 --tokens 参数文档  ', tokenBudget: 100000 });
  await budgeted.command('');
  assert.equal(budgeted.state()!.objective, '完成目标里的 --tokens 参数文档');
  assert.equal(budgeted.state()!.tokenBudget, 100000);
  assert.equal(budgeted.state()!.status, 'active');
  assert.equal(budgeted.messages.length, 1);

  const unbudgeted = harness();
  unbudgeted.ctx.ui.input = async () => JSON.stringify({ action: 'start', objective: '修复测试' });
  await unbudgeted.command('');
  assert.equal(unbudgeted.state()!.tokenBudget, undefined);
  assert.equal(unbudgeted.state()!.continuations, 0);
  assert.equal(unbudgeted.messages.length, 1);
  for (let run = 0; run <= MAX_GOAL_CONTINUATIONS; run++) {
    await unbudgeted.emit({ type: 'agent_start' });
    await unbudgeted.usedTool();
    await unbudgeted.boundary();
  }
  assert.equal(unbudgeted.state()!.status, 'paused');
  assert.match(unbudgeted.state()!.reason!, /自动续跑 25 次/);
});

test('existing goal menu routes pause and resume without creating a second goal', async () => {
  const h = harness();
  await h.command('目标');
  const id = h.state()!.id;
  h.ctx.ui.select = async (title, choices) => {
    assert.equal(title, 'Goal 管理');
    assert.ok(choices.includes('暂停目标'));
    return '暂停目标';
  };
  await h.command('');
  assert.equal(h.state()!.status, 'paused');
  assert.equal(h.aborts.length, 1);
  h.ctx.ui.select = async (title, choices) => {
    assert.equal(title, 'Goal 管理');
    assert.ok(choices.includes('恢复目标'));
    return '恢复目标';
  };
  await h.command('');
  assert.equal(h.state()!.id, id);
  assert.equal(h.state()!.status, 'active');
  assert.equal(h.messages.length, 2);
});

test('completed goal menu can create a new goal but cancellation preserves the completed result', async () => {
  const h = harness();
  await h.command('旧目标');
  const id = h.state()!.id;
  await h.tool('desktop_goal_complete', { goal_id: id, summary: '完成', evidence: '测试通过' });
  h.ctx.ui.select = async (_title, choices) => {
    assert.ok(choices.includes('新建目标'));
    return '新建目标';
  };
  h.ctx.ui.input = async () => undefined;
  const before = h.entries.length;
  await h.command('');
  assert.equal(h.entries.length, before);
  assert.equal(h.state()!.status, 'completed');
  assert.equal(h.state()!.id, id);
  h.ctx.ui.input = async () => JSON.stringify({ action: 'start', objective: '新目标' });
  await h.command('');
  assert.notEqual(h.state()!.id, id);
  assert.equal(h.state()!.objective, '新目标');
  assert.equal(h.messages.length, 2);
});

test('a stale menu selection cannot clear a replacement goal', async () => {
  const h = harness();
  await h.command('旧目标');
  let choose!: (choice: string) => void;
  h.ctx.ui.select = () =>
    new Promise((resolve) => {
      choose = resolve;
    });
  const pendingMenu = h.command('');
  await h.command('clear');
  await h.command('新目标');
  const newId = h.state()!.id;
  choose('清除目标');
  await pendingMenu;
  assert.equal(h.state()!.id, newId);
  assert.equal(h.state()!.status, 'active');
  assert.equal(h.aborts.length, 1);
  assert.match(h.notices.at(-1)!.message, /Goal 已变化/);
});

test('native boundary persists the goal and continues without manufacturing another user turn', async () => {
  const h = harness();
  await h.command('完成文件修改');
  const id = h.state()!.id;
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /完成文件修改/);
  await h.emit({ type: 'agent_start' });
  await h.usedTool();
  await h.usage(100);
  const next = await h.boundary();
  assert.equal(next!.continue, true);
  const context = next!.entries.find((entry) => entry.type === 'custom_message');
  assert.ok(context?.type === 'custom_message');
  assert.equal(context.display, false);
  assert.match(String(context.content), new RegExp(`goal_id: ${id}`));
  assert.equal(h.messages.length, 1, 'automatic continuation stays inside the original user task');
  assert.equal(h.state()!.tokensUsed, 100);
  assert.equal(h.state()!.continuations, 1);

  const result = await h.tool('desktop_goal_complete', {
    goal_id: id,
    summary: '修复完成',
    evidence: '运行目标测试，3 个测试通过。',
  });
  assert.equal(result.terminate, true);
  assert.equal(h.state()!.status, 'completed');
  assert.equal(h.state()!.evidence, '运行目标测试，3 个测试通过。');
  assert.equal(await h.boundary(), undefined);
});

test('three runs without tool calls pause and explicit resume resets guards but preserves usage', async () => {
  const h = harness();
  await h.command('解决问题');
  for (let run = 0; run < 3; run++) {
    await h.emit({ type: 'agent_start' });
    await h.usage(30);
    await h.boundary();
  }
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.state()!.reason!, /连续 3 次结束未调用工具/);
  assert.equal(h.state()!.continuations, 2);
  assert.equal(h.state()!.tokensUsed, 90);
  await h.command('resume');
  assert.equal(h.state()!.status, 'active');
  assert.equal(h.state()!.continuations, 0);
  assert.equal(h.state()!.noToolRuns, 0);
  assert.equal(h.state()!.tokensUsed, 90);
  assert.equal(h.messages.length, 2);
});

test('25 automatic continuations bound tool-using runs as well', async () => {
  const h = harness();
  await h.command('修复测试');
  for (let run = 0; run <= MAX_GOAL_CONTINUATIONS; run++) {
    await h.emit({ type: 'agent_start' });
    await h.usedTool();
    await h.boundary();
  }
  assert.equal(h.state()!.continuations, MAX_GOAL_CONTINUATIONS);
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.state()!.reason!, /自动续跑 25 次/);
  assert.equal(h.state()!.noToolRuns, 0);
});

test('budget counts main assistant usage once, excludes tool usage, and persists pause before abort', async () => {
  const h = harness();
  await h.command('--tokens 100 完成目标');
  await h.usage(60);
  await h.emit({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId: 'nested',
      toolName: 'nested-agent',
      content: [],
      details: {},
      usage: assistant(999).usage,
      isError: false,
      timestamp: Date.now(),
    },
  });
  assert.equal(h.state()!.tokensUsed, 60);
  await h.usage(50);
  assert.equal(h.state()!.tokensUsed, 110, 'usage is reported after the in-flight request finishes');
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.state()!.reason!, /token 预算 100/);
  assert.equal(h.aborts.at(-1)!.status, 'paused');
  assert.equal(await h.boundary(), undefined);
  await h.command('resume');
  assert.equal(h.messages.length, 1);
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.notices.at(-1)!.message, /达到用量上限/);
});

test('paused goal counts its in-flight final usage without reactivation or charging cleared history', async () => {
  const h = harness();
  await h.command('--tokens 100 目标');
  await h.usage(20);
  await h.command('pause');
  const late = assistant(35);
  late.stopReason = 'aborted';
  await h.emit({ type: 'message_end', message: late });
  assert.equal(h.state()!.tokensUsed, 55);
  assert.equal(h.state()!.status, 'paused');
  await h.emit({ type: 'agent_settled', aborted: true });
  await h.usage(99);
  assert.equal(h.state()!.tokensUsed, 55, 'settled runs no longer own accounting');
  await h.command('clear');
  await h.usage(99);
  assert.equal(h.state(), undefined);
  await h.command('新目标');
  assert.equal(h.state()!.tokensUsed, 0);
  await h.emit({ type: 'session_start', reason: 'reload' });
  await h.usage(99);
  assert.equal(h.state()!.tokensUsed, 0, 'restoring a branch invalidates the prior run owner');
});

test('missing model or authentication never creates an active goal or resumes a paused one', async () => {
  const h = harness();
  const model = h.ctx.model;
  h.ctx.model = undefined;
  await h.command('目标');
  assert.equal(h.state(), undefined);
  assert.equal(h.messages.length, 0);
  assert.match(h.notices.at(-1)!.message, /先选择一个可用模型/);
  h.ctx.model = model;
  h.ctx.modelRegistry.hasConfiguredAuth = () => false;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: 'No auth' });
  await h.command('目标');
  assert.equal(h.state(), undefined);
  assert.equal(h.messages.length, 0);
  assert.match(h.notices.at(-1)!.message, /尚未通过认证/);
  h.ctx.modelRegistry.hasConfiguredAuth = () => true;
  await h.command('目标');
  await h.command('pause');
  h.ctx.model = undefined;
  await h.command('resume');
  assert.equal(h.state()!.status, 'paused');
  assert.equal(h.messages.length, 1);
});

test('restore and branch navigation pause active goal without sending or losing usage', async () => {
  const original = harness();
  await original.command('原目标');
  await original.usage(200);
  const restored = harness(original.entries);
  await restored.emit({ type: 'session_start', reason: 'resume' });
  assert.equal(restored.messages.length, 0);
  assert.equal(restored.state()!.status, 'paused');
  assert.equal(restored.state()!.tokensUsed, 200);
  await restored.command('resume');
  const branched = harness(restored.entries);
  await branched.emit({ type: 'session_tree', newLeafId: 'fixture', oldLeafId: null } as ExtensionEvent);
  assert.equal(branched.state()!.status, 'paused');
  assert.equal(branched.messages.length, 0);
});

test('pause and clear persist before abort and prevent a later settlement from restarting work', async () => {
  const h = harness();
  await h.command('目标');
  await h.command('pause');
  assert.equal(h.aborts.at(-1)!.status, 'paused');
  assert.equal(await h.boundary(), undefined);
  await h.command('resume');
  await h.command('clear');
  assert.equal(h.entries.at(-1)!.type, 'custom');
  assert.equal(h.state(), undefined);
  assert.equal(h.aborts.at(-1), undefined);
  assert.equal(await h.boundary(), undefined);
  await h.emit({ type: 'agent_settled', aborted: true });
  assert.equal(h.state(), undefined);
  assert.equal(h.messages.length, 2);
});

test('completion requires matching id and nonempty evidence, while tool failures do not block goals', async () => {
  const h = harness();
  await h.command('原目标');
  const id = h.state()!.id;
  await h.command('替换目标');
  assert.equal(h.state()!.id, id);
  assert.match(h.notices.at(-1)!.message, /先 \/goal clear/);
  await assert.rejects(
    h.tool('desktop_goal_complete', { goal_id: 'stale', summary: 'done', evidence: 'tests' }),
    /ID/,
  );
  await assert.rejects(
    h.tool('desktop_goal_complete', { goal_id: id, summary: 'done', evidence: ' ' }),
    /具体证据/,
  );
  await h.emit({ type: 'agent_start' });
  await h.usedTool();
  await h.emit({
    type: 'tool_execution_end',
    toolCallId: 'write-1',
    toolName: 'write',
    result: { content: [{ type: 'text', text: 'Tool failed' }], details: {} },
    isError: true,
  });
  await h.boundary();
  assert.equal(h.state()!.status, 'active');
  const blocked = await h.tool('desktop_goal_blocked', {
    goal_id: id,
    summary: '需要提供测试账号',
    evidence: '测试环境返回账号不存在。',
  });
  assert.equal(blocked.terminate, true);
  assert.equal(h.state()!.status, 'blocked');
  assert.equal(await h.boundary(), undefined);
});

test('mixed and nested completion calls cannot finish a goal before their tool batch ends', async () => {
  const h = harness();
  await h.command('目标');
  const params = { goal_id: h.state()!.id, summary: '已修复', evidence: '测试通过' };
  await h.emit({
    type: 'message_end',
    message: {
      ...assistant(40),
      content: [
        { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'file.txt' } },
        { type: 'toolCall', id: 'finish', name: 'desktop_goal_complete', arguments: params },
      ],
    },
  });
  await assert.rejects(h.rawTool('desktop_goal_complete', params, 'finish'), /唯一的直接工具调用/);
  assert.equal(h.state()!.status, 'active');
  await h.emit({
    type: 'message_end',
    message: {
      ...assistant(40),
      content: [{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: {} }],
    },
  });
  await assert.rejects(h.rawTool('desktop_goal_complete', params, 'parent:child'), /唯一的直接工具调用/);
  assert.equal(h.state()!.status, 'active');
  assert.equal(h.tools.get('desktop_goal_complete')!.exposure, 'model-only');
  const result = await h.tool('desktop_goal_complete', params);
  assert.equal(result.terminate, true);
  assert.equal(h.state()!.status, 'completed');
  assert.equal(h.state()!.tokensUsed, 80);
});

test('clearing an absent, paused or completed goal does not abort an unrelated task', async () => {
  const h = harness();
  await h.command('clear');
  assert.equal(h.aborts.length, 0);
  await h.command('目标');
  await h.command('pause');
  assert.equal(h.aborts.length, 1);
  await h.command('clear');
  assert.equal(h.aborts.length, 1);
  await h.command('另一个目标');
  await h.tool('desktop_goal_complete', { goal_id: h.state()!.id, summary: '完成', evidence: '测试通过' });
  await h.command('clear');
  assert.equal(h.aborts.length, 1);
});

test('inactive goal context overrides old instructions while untouched sessions remain unchanged', async () => {
  const h = harness();
  const before = () =>
    h.emit({ type: 'before_agent_start', messageType: 'user', prompt: '普通任务' } as ExtensionEvent);
  assert.equal(await before(), undefined);
  await h.command('目标');
  await h.command('pause');
  let reminder = (await before()) as { message: { content: string; display: boolean } };
  assert.match(reminder.message.content, /已暂停/);
  assert.match(reminder.message.content, /不调用 Goal 结果工具/);
  assert.equal(reminder.message.display, false);
  await h.command('clear');
  reminder = (await before()) as typeof reminder;
  assert.match(reminder.message.content, /已清除/);
  const restored = harness(h.entries);
  await restored.emit({ type: 'session_start', reason: 'resume' });
  const restoredReminder = (await restored.emit({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: '普通任务',
  } as ExtensionEvent)) as typeof reminder;
  assert.match(restoredReminder.message.content, /已清除/);
});

test('disabled goal tools reject start and pause an active goal instead of looping', async () => {
  const h = harness();
  h.activeTools([]);
  await h.command('目标');
  assert.equal(h.state(), undefined);
  assert.equal(h.messages.length, 0);
  assert.match(h.notices.at(-1)!.message, /工具已停用/);
  h.activeTools([...h.tools.keys()]);
  await h.command('目标');
  h.activeTools(['desktop_goal_complete']);
  await h.boundary();
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.state()!.reason!, /工具已停用/);
});

test('terminal model errors and user abort preserve a paused goal', async () => {
  const h = harness();
  await h.command('目标');
  await h.boundary('error');
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.state()!.reason!, /模型请求失败/);
  await h.command('resume');
  await h.emit({ type: 'agent_settled', aborted: true });
  assert.equal(h.state()!.status, 'paused');
  assert.match(h.state()!.reason!, /执行已停止/);
});

test('state restoration honors the latest branch entry and explicit clear', async () => {
  const h = harness();
  await h.command('目标');
  const saved = structuredClone(h.entries);
  await h.command('clear');
  assert.equal(readGoalState(h.entries), undefined);
  assert.equal(readGoalState(saved)!.status, 'active');
  const entry = saved.findLast(
    (item) => item.type === 'custom' && item.customType === DESKTOP_GOAL_ENTRY_TYPE,
  )!;
  assert.ok(entry.type === 'custom');
  entry.data = { ...(entry.data as DesktopGoalState), tokensUsed: -1 };
  assert.throws(() => readGoalState(saved), /状态格式无效/);
});
