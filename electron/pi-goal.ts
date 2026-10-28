import { randomUUID } from 'node:crypto';
import { GOAL_DIALOG_TITLE, validateGoalAction, type GoalAction } from '../shared/goal';
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import {
  DESKTOP_GOAL_ENTRY_TYPE,
  MAX_GOAL_CONTINUATIONS,
  nextGoalBoundary,
  parseGoalCommand,
  readGoalState,
  goalSnapshot,
  type DesktopGoalState,
  type GoalCommand,
} from './goal-state';

const COMPLETE_TOOL = 'desktop_goal_complete';
const BLOCKED_TOOL = 'desktop_goal_blocked';
const GOAL_CONTEXT = 'desktop-goal-context';
const goalTools = [COMPLETE_TOOL, BLOCKED_TOOL];
const statusNames: Record<DesktopGoalState['status'], string> = {
  active: '执行中',
  paused: '已暂停',
  blocked: '遇到阻碍',
  completed: '已完成',
};
const resultParameters = {
  type: 'object',
  properties: {
    goal_id: { type: 'string', minLength: 1, description: 'The current goal_id from Goal context.' },
    summary: { type: 'string', minLength: 1, description: 'What was completed or what prevents completion.' },
    evidence: {
      type: 'string',
      minLength: 1,
      description: 'Concrete verification results, or evidence for the blocker and required user action.',
    },
  },
  required: ['goal_id', 'summary', 'evidence'],
  additionalProperties: false,
} as const;

function goalContext(goal: DesktopGoalState): string {
  return [
    '当前用户启用的 Goal：',
    `goal_id: ${goal.id}`,
    `目标：${goal.objective}`,
    `已使用 token：${goal.tokensUsed}${goal.tokenBudget === undefined ? '' : ` / ${goal.tokenBudget}`}`,
    '继续完成这个目标，沿用当前工作模型和工具。普通文字回复不会把 Goal 标记为完成。',
    `确认目标已实际完成后，单独调用 ${COMPLETE_TOOL}，提交当前 goal_id、完成摘要 summary 和具体检查证据 evidence。`,
    `只有确实无法继续、需要用户补充或外部条件改变时，单独调用 ${BLOCKED_TOOL}，说明阻碍和证据。普通工具失败不代表目标被阻塞。`,
    '用户新消息用于补充或修正当前目标；尊重暂停、停止和取消，不自行创建或替换目标。',
  ].join('\n');
}

function details(goal: DesktopGoalState): string[] {
  return [
    `Goal · ${statusNames[goal.status]}`,
    goal.objective,
    `Token：${goal.tokensUsed}${goal.tokenBudget === undefined ? '（未设预算）' : ` / ${goal.tokenBudget}`} · 自动续跑：${goal.continuations} / ${MAX_GOAL_CONTINUATIONS}`,
    ...(goal.reason ? [goal.reason] : []),
    ...(goal.summary ? [`结果：${goal.summary}`] : []),
    ...(goal.evidence ? [`证据：${goal.evidence}`] : []),
  ];
}

/** Registered inside the desktop bridge and executed entirely by Pi's native extension runtime. */
export function registerDesktopGoal(pi: ExtensionAPI) {
  let goal: DesktopGoalState | undefined;
  let stateError: string | undefined;
  let usedTools = false;
  let hasGoalHistory = false;
  let resultToolCallId: string | undefined;
  let accountingGoalId: string | undefined;
  let stateRevision = 0;

  const render = (ctx: ExtensionContext) => {
    ctx.ui.notify(
      '__PI_DESKTOP__' +
        JSON.stringify({
          type: 'desktop_goal',
          goal: goalSnapshot(goal),
        }),
    );
  };
  const save = (next: DesktopGoalState | undefined, ctx: ExtensionContext) => {
    // Persist before publishing or aborting: subsequent events must see the stopped state.
    pi.appendEntry(DESKTOP_GOAL_ENTRY_TYPE, next ?? null);
    if (goal?.id !== next?.id) accountingGoalId = undefined;
    goal = next;
    stateRevision++;
    hasGoalHistory = true;
    stateError = undefined;
    render(ctx);
  };
  const pause = (reason: string, ctx: ExtensionContext) => {
    if (goal?.status === 'active') save({ ...goal, status: 'paused', reason, updatedAt: Date.now() }, ctx);
  };
  const missingTools = () => goalTools.filter((name) => !pi.getActiveTools().includes(name));
  const requireTools = () => {
    const missing = missingTools();
    if (missing.length)
      throw new Error(`Goal 工具已停用：${missing.join('、')}。请在工具设置中启用后再开始或恢复。`);
  };
  const requireModel = async (ctx: ExtensionContext) => {
    const model = ctx.model;
    if (!model) throw new Error('请先选择一个可用模型，再开始或恢复 Goal。');
    const revision = stateRevision;
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error('当前模型尚未通过认证，请检查服务商登录或密钥后再开始 Goal。');
    }
    if (revision !== stateRevision || !ctx.isIdle())
      throw new Error('Goal 或任务状态已变化，请重新确认后再开始或恢复。');
    if (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)
      throw new Error('所选模型已变化，请重新开始或恢复 Goal。');
  };
  const restore = (ctx: ExtensionContext) => {
    usedTools = false;
    resultToolCallId = undefined;
    accountingGoalId = undefined;
    stateRevision++;
    try {
      const branch = ctx.sessionManager.getBranch();
      hasGoalHistory = branch.some(
        (entry) => entry.type === 'custom' && entry.customType === DESKTOP_GOAL_ENTRY_TYPE,
      );
      goal = readGoalState(branch);
      stateError = undefined;
      if (goal?.status === 'active')
        save(
          {
            ...goal,
            status: 'paused',
            reason: '会话已重新载入或切换分支，Goal 已暂停；使用 /goal resume 明确继续。',
            updatedAt: Date.now(),
          },
          ctx,
        );
      else render(ctx);
    } catch (error) {
      goal = undefined;
      stateError = error instanceof Error ? error.message : String(error);
      render(ctx);
      ctx.ui.notify(stateError, 'error');
    }
  };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));

  pi.on('before_agent_start', (_event, ctx) => {
    if (goal?.status === 'active' && missingTools().length) {
      pause('Goal 工具已停用，自动执行已暂停；请启用完成和阻塞工具后再恢复。', ctx);
      ctx.ui.notify(goal!.reason!, 'warning');
    }
    if (goal?.status === 'active')
      return { message: { customType: GOAL_CONTEXT, content: goalContext(goal), display: false } };
    if (hasGoalHistory)
      return {
        message: {
          customType: GOAL_CONTEXT,
          content: `当前 Goal ${goal ? statusNames[goal.status] : '已清除或不可用'}。之前的 Goal 持续执行规则已停止，请正常处理当前用户任务，不调用 Goal 结果工具。只有用户使用 /goal 开始或恢复后才重新启用。`,
          display: false,
        },
      };
  });
  pi.on('agent_start', () => {
    usedTools = false;
    resultToolCallId = undefined;
    accountingGoalId = goal?.status === 'active' ? goal.id : undefined;
  });
  pi.on('tool_execution_start', () => {
    if (goal?.status === 'active') usedTools = true;
  });
  pi.on('message_end', (event, ctx) => {
    if (
      !goal ||
      goal.id !== accountingGoalId ||
      (goal.status !== 'active' && goal.status !== 'paused') ||
      event.message.role !== 'assistant'
    )
      return;
    const calls = event.message.content.filter((block) => block.type === 'toolCall');
    resultToolCallId =
      goal.status === 'active' && calls.length === 1 && goalTools.includes(calls[0].name)
        ? calls[0].id
        : undefined;
    // Main assistant usage already includes this model request. Tool usage may contain nested work.
    const tokens = event.message.usage.totalTokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(goal.tokensUsed + tokens)) {
      pause('模型没有返回有效的 token 用量，Goal 已暂停。', ctx);
      ctx.abort();
      return;
    }
    save({ ...goal, tokensUsed: goal.tokensUsed + tokens, updatedAt: Date.now() }, ctx);
    if (
      goal!.status === 'active' &&
      goal!.tokenBudget !== undefined &&
      goal!.tokensUsed >= goal!.tokenBudget
    ) {
      pause(`已达到 token 预算 ${goal!.tokenBudget}，Goal 已暂停；当前模型回复的用量已计入。`, ctx);
      ctx.abort();
    }
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (goal?.status !== 'active') return;
    if (event.outcome !== 'completed') {
      pause(
        event.outcome === 'error'
          ? '模型请求失败，Goal 已暂停，请检查错误后再恢复。'
          : '执行已停止，Goal 已暂停。',
        ctx,
      );
      return;
    }
    if (missingTools().length) {
      pause('Goal 工具已停用，自动执行已暂停；请启用完成和阻塞工具后再恢复。', ctx);
      ctx.ui.notify(goal!.reason!, 'warning');
      return;
    }
    const next = nextGoalBoundary(goal, usedTools, Date.now());
    goal = next.state;
    stateRevision++;
    render(ctx);
    const entries: SessionBoundaryDraft[] = [
      ...event.entries,
      { type: 'custom', customType: DESKTOP_GOAL_ENTRY_TYPE, data: goal },
    ];
    if (next.continue)
      entries.push({
        type: 'custom_message',
        customType: GOAL_CONTEXT,
        content: goalContext(goal),
        display: false,
      });
    else ctx.ui.notify(goal.reason!, 'warning');
    return { entries, continue: next.continue || event.continue };
  });
  pi.on('agent_settled', (event, ctx) => {
    if (event.aborted && goal?.id === accountingGoalId)
      pause('执行已停止，Goal 已暂停；使用 /goal resume 明确继续。', ctx);
    accountingGoalId = undefined;
  });

  for (const [name, status] of [
    [COMPLETE_TOOL, 'completed'],
    [BLOCKED_TOOL, 'blocked'],
  ] as const)
    pi.registerTool({
      name,
      label: status === 'completed' ? '完成 Goal' : '报告 Goal 阻碍',
      description:
        status === 'completed'
          ? 'Mark the active user-created Goal complete only after verifying the objective. Supply its exact goal_id, a summary, and concrete evidence. Call this tool alone.'
          : 'Stop the active Goal when a real blocker requires user input or an external change. Supply its exact goal_id, a summary, and evidence. Ordinary tool failure is not enough. Call this tool alone.',
      parameters: resultParameters,
      executionMode: 'sequential',
      exposure: 'model-only',
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        if (!goal || goal.status !== 'active')
          throw new Error('当前没有执行中的 Goal，请由用户先开始或恢复目标。');
        if (toolCallId !== resultToolCallId)
          throw new Error(
            'Goal 结果工具必须是本次回复唯一的直接工具调用，请单独调用，不要与其他工具混用或嵌套调用。',
          );
        if (params.goal_id !== goal.id)
          throw new Error('Goal ID 与当前目标不一致，请重新读取当前 Goal 信息。');
        if (!params.summary.trim() || !params.evidence.trim())
          throw new Error('请填写结果摘要和具体证据，不能仅声明“已完成”或“无法继续”。');
        const next: DesktopGoalState = {
          ...goal,
          status,
          summary: params.summary.trim(),
          evidence: params.evidence.trim(),
          ...(status === 'blocked' ? { reason: params.summary.trim() } : {}),
          updatedAt: Date.now(),
        };
        save(next, ctx);
        return {
          content: [{ type: 'text', text: details(next).join('\n') }],
          details: next,
          terminate: true,
        };
      },
    });

  const execute = async (
    command: GoalCommand | Extract<GoalAction, { action: 'budget' }>,
    ctx: ExtensionContext,
  ) => {
    if (command.action === 'clear') {
      const wasActive = goal?.status === 'active';
      save(undefined, ctx);
      if (wasActive) ctx.abort();
      ctx.ui.notify('Goal 已清除。', 'info');
    } else if (command.action === 'menu' || command.action === 'status') {
      ctx.ui.notify(
        goal
          ? details(goal).join('\n')
          : '当前没有 Goal。用 /goal [--tokens N] <目标> 开始；默认最多自动续跑 25 次。',
        'info',
      );
    } else if (command.action === 'pause') {
      if (!goal || goal.status !== 'active') throw new Error('当前没有执行中的 Goal。');
      pause('用户暂停了 Goal；使用 /goal resume 明确继续。', ctx);
      ctx.abort();
    } else if (command.action === 'resume' || command.action === 'budget') {
      if (!goal || goal.status === 'completed') throw new Error('当前没有可恢复的 Goal。');
      if (goal.status === 'active') throw new Error('Goal 正在执行，无需重复恢复。');
      if (!ctx.isIdle()) throw new Error('请先等待当前任务结束或停止，再恢复 Goal。');
      requireTools();
      const budget = command.action === 'budget' ? command.tokenBudget : goal.tokenBudget;
      if (budget !== undefined && goal.tokensUsed >= budget)
        throw new Error('Goal 已达到用量上限，请调整到高于已用量的上限，或选择“不限”后继续。');
      await requireModel(ctx);
      const {
        reason: _reason,
        summary: _summary,
        evidence: _evidence,
        tokenBudget: _budget,
        ...previous
      } = goal;
      save(
        {
          ...previous,
          ...(budget === undefined ? {} : { tokenBudget: budget }),
          status: 'active',
          continuations: 0,
          noToolRuns: 0,
          updatedAt: Date.now(),
        },
        ctx,
      );
      pi.sendUserMessage(`继续完成 Goal：\n${goal!.objective}`);
    } else if (command.action === 'start') {
      if (goal && goal.status !== 'completed')
        throw new Error('已有未完成的 Goal。请先 /goal clear 清除，再设置新目标。');
      if (!ctx.isIdle()) throw new Error('请先等待当前任务结束或停止，再开始 Goal。');
      requireTools();
      await requireModel(ctx);
      const now = Date.now();
      save(
        {
          version: 1,
          id: randomUUID(),
          objective: command.objective.trim(),
          status: 'active',
          ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
          tokensUsed: 0,
          continuations: 0,
          noToolRuns: 0,
          createdAt: now,
          updatedAt: now,
        },
        ctx,
      );
      pi.sendUserMessage(`请完成 Goal：\n${goal!.objective}`);
    }
  };

  pi.registerCommand('goal', {
    description: '持续执行目标：/goal [--tokens N] <目标>；status、pause、resume、clear',
    handler: async (input, ctx) => {
      try {
        let command = parseGoalCommand(input);
        if (command.action === 'clear') {
          const wasActive = goal?.status === 'active';
          save(undefined, ctx);
          if (wasActive) ctx.abort();
          ctx.ui.notify('Goal 已清除。', 'info');
          return;
        }
        if (stateError) throw new Error(stateError);
        if (command.action === 'menu') {
          const menuGoalId = goal?.id;
          const assertCurrentGoal = () => {
            if (goal?.id !== menuGoalId) throw new Error('Goal 已变化，请重新打开 Goal 管理。');
          };
          let create = !goal;
          if (goal) {
            const actions = [
              '查看目标',
              ...(goal.status === 'active'
                ? ['暂停目标']
                : goal.status === 'completed'
                  ? ['新建目标']
                  : ['恢复目标']),
              '清除目标',
            ];
            const choice = await ctx.ui.select('Goal 管理', actions);
            if (!choice) return;
            assertCurrentGoal();
            create = choice === '新建目标';
            if (!create)
              command = {
                action:
                  choice === '暂停目标'
                    ? 'pause'
                    : choice === '恢复目标'
                      ? 'resume'
                      : choice === '清除目标'
                        ? 'clear'
                        : 'status',
              };
          }
          if (create) {
            const response = await ctx.ui.input(GOAL_DIALOG_TITLE, '');
            if (response === undefined) return;
            assertCurrentGoal();
            const action: unknown = JSON.parse(response);
            validateGoalAction(action);
            if (action.action !== 'start') throw new Error('请输入需要完成的目标。');
            command = action;
          }
        }
        await execute(command, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  return {
    action: async (value: unknown, ctx: ExtensionContext) => {
      validateGoalAction(value);
      if (value.action !== 'start' && goal?.id !== value.goalId)
        throw new Error('Goal 已变化，请重新打开 Goal。');
      if (stateError && value.action !== 'clear') throw new Error(stateError);
      await execute(value, ctx);
      return { applied: true };
    },
  };
}
