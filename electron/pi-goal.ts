import { validatePlanSteps } from '../shared/plan';
import type { ImageContent } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import {
  goalRequestTokens,
  validateGoalAction,
  validateGoalObjective,
  type GoalAction,
} from '../shared/goal';
import { classifyModelError } from '../shared/errors';
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import {
  DESKTOP_GOAL_ENTRY_TYPE,
  nextGoalBoundary,
  parseGoalCommand,
  readGoalState,
  goalSnapshot,
  type DesktopGoalState,
  type GoalCommand,
  type GoalRunActivity,
} from './goal-state';
import { goalContext, goalUpdatedContext, GOAL_BUDGET_MESSAGE } from './goal-context';

const UPDATE_TOOL = 'desktop_goal_update';
const GET_TOOL = 'desktop_goal_get';
const PLAN_TOOL = 'desktop_goal_plan';
const GOAL_CONTEXT = 'desktop-goal-context';
const goalTools = [UPDATE_TOOL, GET_TOOL, PLAN_TOOL];
const statusNames: Record<DesktopGoalState['status'], string> = {
  active: '执行中',
  paused: '已暂停',
  blocked: '遇到阻碍',
  budget_limited: '达到用量上限',
  usage_limited: '服务商额度不足',
  completed: '已完成',
};
const identityProperties = {
  goal_id: { type: 'string', minLength: 1, description: 'The current goal_id.' },
  revision: { type: 'integer', minimum: 1, description: 'The current objective revision.' },
} as const;
function details(goal: DesktopGoalState): string[] {
  return [
    `Goal · ${statusNames[goal.status]}`,
    goal.objective,
    `Goal 用量：${goal.tokensUsed}${goal.tokenBudget === undefined ? '（不限）' : ` / ${goal.tokenBudget}`}（不含缓存命中）`,
    ...(goal.reason ? [goal.reason] : []),
    ...(goal.summary ? [`结果：${goal.summary}`] : []),
  ];
}
const emptyActivity = (): GoalRunActivity => ({
  usedTools: false,
  failedCommand: false,
  successfulTool: false,
});

/** Runs inside Pi's native extension runtime. No provider or workspace operations are performed here. */
export function registerDesktopGoal(pi: ExtensionAPI) {
  let goal: DesktopGoalState | undefined;
  let stateError: string | undefined;
  let activity = emptyActivity();
  let hasGoalHistory = false;
  let resultToolCallId: string | undefined;
  let accountingGoalId: string | undefined;
  let stateRevision = 0;
  let activeSince: number | undefined;
  let modelError: ReturnType<typeof classifyModelError> | undefined;
  let budgetRequests = 0;

  const render = (ctx: ExtensionContext, open = false) =>
    ctx.ui.notify(
      '__PI_DESKTOP__' + JSON.stringify({ type: 'desktop_goal', goal: goalSnapshot(goal), open }),
    );
  const advance = (next: DesktopGoalState | undefined) => {
    const now = Date.now();
    if (next) {
      next = { ...next, updatedAt: now };
      if (
        next.id === goal?.id &&
        goal.status === 'active' &&
        activeSince !== undefined &&
        next.timeUsedMs !== null
      )
        next.timeUsedMs += Math.max(0, now - activeSince);
    }
    if (goal?.id !== next?.id) accountingGoalId = undefined;
    activeSince = next?.status === 'active' ? now : undefined;
    goal = next;
    stateRevision++;
    hasGoalHistory = true;
    stateError = undefined;
    return next;
  };
  const save = (next: DesktopGoalState | undefined, ctx: ExtensionContext) => {
    const previous = { goal, activeSince, accountingGoalId, stateRevision, hasGoalHistory, stateError };
    advance(next);
    // A failed append must not commit a new in-memory Goal.
    try {
      pi.appendEntry(DESKTOP_GOAL_ENTRY_TYPE, goal ?? null);
    } catch (error) {
      ({ goal, activeSince, accountingGoalId, stateRevision, hasGoalHistory, stateError } = previous);
      throw error;
    }
    render(ctx);
  };
  const pause = (reason: string, ctx: ExtensionContext) => {
    if (goal?.status === 'active') save({ ...goal, status: 'paused', reason }, ctx);
  };
  const missingTools = () => goalTools.filter((name) => !pi.getActiveTools().includes(name));
  const requireTools = () => {
    const missing = missingTools();
    if (missing.length)
      throw new Error(`Goal 工具已停用：${missing.join('、')}。请在工具设置中启用后再开始或恢复。`);
  };
  const requireModel = async (ctx: ExtensionContext, allowRunning = false) => {
    const model = ctx.model;
    if (!model) throw new Error('请先选择一个可用模型，再开始或恢复 Goal。');
    const revision = stateRevision;
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error('当前模型尚未通过认证，请检查服务商登录或密钥后再开始 Goal。');
    }
    if (revision !== stateRevision || (!allowRunning && !ctx.isIdle()))
      throw new Error('Goal 或任务状态已变化，请重新确认后再开始或恢复。');
    if (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)
      throw new Error('所选模型已变化，请重新开始或恢复 Goal。');
  };
  const restore = (ctx: ExtensionContext) => {
    activity = emptyActivity();
    resultToolCallId = accountingGoalId = undefined;
    activeSince = undefined;
    modelError = undefined;
    budgetRequests = 0;
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
  // Queued steering can survive an abort/replacement. Project the current control
  // state at every provider boundary, without rewriting the saved conversation.
  pi.on('context', (event) => {
    if (!hasGoalHistory) return;
    const content =
      goal?.status === 'active'
        ? goalContext(goal)
        : goal?.status === 'budget_limited' && goal.id === accountingGoalId
          ? `goal_id: ${goal.id}\nrevision: ${goal.revision}\n${GOAL_BUDGET_MESSAGE}`
          : `当前 Goal ${goal ? statusNames[goal.status] : '已清除或不可用'}。旧目标的自动执行指令已停止，只处理用户当前请求，不调用 Goal 结果工具。`;
    return {
      messages: [
        ...event.messages.filter(
          (message) =>
            message.role !== 'custom' ||
            ![GOAL_CONTEXT, 'desktop-goal-budget', 'desktop-goal-start'].includes(message.customType),
        ),
        { role: 'custom' as const, customType: GOAL_CONTEXT, content, display: false, timestamp: Date.now() },
      ],
    };
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (goal?.status === 'active' && missingTools().length) {
      pause('Goal 工具已停用，自动执行已暂停；请启用 Goal 工具后再恢复。', ctx);
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
    activity = emptyActivity();
    resultToolCallId = undefined;
    modelError = undefined;
    if (goal?.status === 'active') {
      budgetRequests = 0;
      accountingGoalId = goal.id;
    } else if (goal?.status !== 'budget_limited' || goal.id !== accountingGoalId)
      accountingGoalId = undefined;
  });
  pi.on('tool_execution_start', (event) => {
    if (goal?.status === 'active' && !goalTools.includes(event.toolName)) activity.usedTools = true;
  });
  pi.on('tool_execution_end', (event) => {
    if (goal?.status !== 'active' || goalTools.includes(event.toolName)) return;
    activity.usedTools = true;
    if (!event.isError) activity.successfulTool = true;
    if (event.isError && event.toolName === 'bash') activity.failedCommand = true;
  });
  pi.on('before_provider_request', (_event, ctx) => {
    if (goal?.id === accountingGoalId && goal?.status === 'budget_limited' && ++budgetRequests > 3)
      ctx.abort();
  });
  pi.on('message_end', (event, ctx) => {
    if (!goal || goal.id !== accountingGoalId || event.message.role !== 'assistant') return;
    const message = event.message;
    if (message.stopReason === 'error') modelError = classifyModelError(message.errorMessage ?? '');
    else if (message.stopReason !== 'aborted') modelError = undefined;
    const calls = message.content.filter((block) => block.type === 'toolCall');
    resultToolCallId =
      goal.status === 'active' && calls.length === 1 && calls[0].name === UPDATE_TOOL
        ? calls[0].id
        : undefined;
    const tokens = goalRequestTokens(message.usage);
    const billed = message.usage.totalTokens;
    if (
      tokens === undefined ||
      !Number.isSafeInteger(billed) ||
      billed < 0 ||
      !Number.isSafeInteger(goal.tokensUsed + tokens) ||
      !Number.isSafeInteger(goal.billedTokensUsed + billed)
    ) {
      pause('模型没有返回有效的 token 用量，Goal 已暂停。', ctx);
      ctx.abort();
      return;
    }
    const cost = message.usage.cost.total;
    save(
      {
        ...goal,
        tokensUsed: goal.tokensUsed + tokens,
        billedTokensUsed: goal.billedTokensUsed + billed,
        costUsed: goal.costUsed + (Number.isFinite(cost) && cost >= 0 ? cost : 0),
      },
      ctx,
    );
    if (
      goal!.status === 'active' &&
      goal!.tokenBudget !== undefined &&
      goal!.tokensUsed >= goal!.tokenBudget
    ) {
      save({ ...goal!, status: 'budget_limited', reason: `已达到用量上限 ${goal!.tokenBudget}` }, ctx);
      budgetRequests = 0;
      pi.sendMessage(
        { customType: 'desktop-goal-budget', content: GOAL_BUDGET_MESSAGE, display: false },
        { deliverAs: 'steer' },
      );
    }
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (goal?.status !== 'active') return;
    if (event.outcome !== 'completed') {
      if (event.outcome === 'error' && modelError?.kind === 'quota')
        save({ ...goal, status: 'usage_limited', reason: `${modelError.title}。${modelError.detail}` }, ctx);
      else
        pause(
          event.outcome === 'error'
            ? `${modelError?.title ?? '模型请求失败'}，Goal 已暂停，请检查错误后再恢复。`
            : '用户暂停了 Goal；使用 /goal resume 明确继续。',
          ctx,
        );
      return;
    }
    if (missingTools().length) {
      pause('Goal 工具已停用，自动执行已暂停；请启用 Goal 工具后再恢复。', ctx);
      ctx.ui.notify(goal!.reason!, 'warning');
      return;
    }
    const next = nextGoalBoundary(goal, activity, Date.now());
    advance(next.state);
    activity = emptyActivity();
    resultToolCallId = undefined;
    render(ctx);
    const entries: SessionBoundaryDraft[] = [
      ...event.entries,
      { type: 'custom', customType: DESKTOP_GOAL_ENTRY_TYPE, data: goal },
    ];
    if (next.continue)
      entries.push({
        type: 'custom_message',
        customType: GOAL_CONTEXT,
        content: goalContext(goal!),
        display: false,
      });
    else ctx.ui.notify(goal!.reason!, 'warning');
    return { entries, continue: next.continue || event.continue };
  });
  pi.on('agent_settled', (event, ctx) => {
    if (event.aborted && goal?.id === accountingGoalId)
      pause('用户暂停了 Goal；使用 /goal resume 明确继续。', ctx);
    accountingGoalId = undefined;
  });

  const requireCurrent = (params: { goal_id: string; revision: number }) => {
    if (!goal || goal.status !== 'active')
      throw new Error('当前没有执行中的 Goal，请由用户先开始或恢复目标。');
    if (params.goal_id !== goal.id) throw new Error('Goal ID 与当前目标不一致，请重新读取当前 Goal 信息。');
    if (params.revision !== goal.revision)
      throw new Error('Goal revision 已过期，请用 desktop_goal_get 核对修改后的目标。');
    return goal;
  };
  pi.registerTool({
    name: GET_TOOL,
    label: '查看 Goal',
    description:
      'Read the current user-created Goal, revision, usage, remaining budget and plan. Does not create or resume a Goal.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } as const,
    exposure: 'model-only',
    async execute() {
      const snapshot = goalSnapshot(goal);
      if (snapshot && snapshot.timeUsedMs !== null && activeSince !== undefined)
        snapshot.timeUsedMs += Math.max(0, Date.now() - activeSince);
      const result = goal
        ? {
            ...snapshot,
            remainingTokens:
              goal.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
          }
        : null;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: UPDATE_TOOL,
    label: '更新 Goal 状态',
    description:
      'After auditing every requirement against current evidence, mark completed. Report blocked only after the same blocker persists for 3 Goal runs; resume restarts that audit. Use paused only on an explicit user request. completed/blocked must be the only direct tool call in the response. Never mark incomplete work complete because a budget is nearly exhausted.',
    parameters: {
      type: 'object',
      properties: {
        ...identityProperties,
        status: { type: 'string', enum: ['completed', 'blocked', 'paused'] },
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['goal_id', 'revision', 'status', 'summary'],
      additionalProperties: false,
    } as const,
    executionMode: 'sequential',
    exposure: 'model-only',
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const current = requireCurrent(params);
      if (params.status !== 'paused' && toolCallId !== resultToolCallId)
        throw new Error(
          'Goal 结果工具必须是本次回复唯一的直接工具调用，请单独调用，不要与其他工具混用或嵌套调用。',
        );
      if (
        !['completed', 'blocked', 'paused'].includes(params.status) ||
        !params.summary.trim() ||
        params.summary.length > 2000
      )
        throw new Error('请填写有效状态及不超过 2000 字的结果摘要。');
      save(
        {
          ...current,
          status: params.status,
          summary: params.summary.trim(),
          reason: params.status === 'completed' ? undefined : params.summary.trim(),
        },
        ctx,
      );
      return { content: [{ type: 'text', text: details(goal!).join('\n') }], details: goal, terminate: true };
    },
  });
  pi.registerTool({
    name: PLAN_TOOL,
    label: '更新 Goal 计划',
    description:
      'Keep a short plan aligned with the current Goal. At most 12 steps and one in_progress step. Updating a plan is not actual work.',
    parameters: {
      type: 'object',
      properties: {
        ...identityProperties,
        steps: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 4000 },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['goal_id', 'revision', 'steps'],
      additionalProperties: false,
    } as const,
    executionMode: 'sequential',
    exposure: 'model-only',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = requireCurrent(params);
      validatePlanSteps(params.steps);
      save({ ...current, plan: params.steps.map((step) => ({ ...step, text: step.text.trim() })) }, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(goal!.plan) }], details: goalSnapshot(goal) };
    },
  });

  type StartPayload = { references?: string[]; firstMessage?: { text: string; images?: ImageContent[] } };
  const execute = async (command: (GoalCommand | GoalAction) & StartPayload, ctx: ExtensionContext) => {
    if (command.action === 'clear') {
      const ownedRun = goal !== undefined && goal.id === accountingGoalId;
      save(undefined, ctx);
      if (ownedRun) ctx.abort();
      ctx.ui.notify('Goal 已清除。', 'info');
    } else if (command.action === 'menu') render(ctx, true);
    else if (command.action === 'status')
      ctx.ui.notify(
        goal ? details(goal).join('\n') : '当前没有 Goal。用 /goal [--tokens N] <目标> 开始。',
        'info',
      );
    else if (command.action === 'pause') {
      if (!goal || goal.status !== 'active') throw new Error('当前没有执行中的 Goal。');
      pause('用户暂停了 Goal；使用 /goal resume 明确继续。', ctx);
      ctx.abort();
    } else if (command.action === 'edit') {
      if (!goal) throw new Error('当前没有可编辑的 Goal。');
      validateGoalObjective(command.objective);
      if ('revision' in command && command.revision !== goal.revision)
        throw new Error('Goal 已变化，请重新打开编辑目标。');
      save(
        {
          ...goal,
          objective: command.objective.trim(),
          revision: goal.revision + 1,
          noProgressRuns: 0,
          failedRuns: 0,
          plan: undefined,
          summary: undefined,
          ...(goal.status === 'completed' || goal.status === 'blocked'
            ? { status: 'paused', reason: '目标已修改，点击继续后执行。' }
            : {}),
        },
        ctx,
      );
      activity = emptyActivity();
      resultToolCallId = undefined;
      pi.sendMessage(
        { customType: 'desktop-goal-updated', content: '目标已修改', display: true },
        { triggerTurn: false },
      );
      pi.sendMessage(
        { customType: GOAL_CONTEXT, content: goalUpdatedContext(goal!), display: false },
        // The context hook projects the latest revision at the next provider boundary.
        // Record the edit without leaving a queued turn that could run after completion.
        { triggerTurn: false, ...(ctx.isIdle() ? {} : { deliverAs: 'steer' as const }) },
      );
    } else if (command.action === 'resume' || command.action === 'budget') {
      if (!goal || goal.status === 'completed') throw new Error('当前没有可恢复的 Goal。');
      validateGoalObjective(goal.objective);
      if (goal.status === 'active') throw new Error('Goal 正在执行，无需重复恢复。');
      if (!ctx.isIdle()) throw new Error('请先等待当前任务结束或停止，再恢复 Goal。');
      requireTools();
      const budget = command.action === 'budget' ? command.tokenBudget : goal.tokenBudget;
      if (budget !== undefined && goal.tokensUsed >= budget)
        throw new Error('Goal 已达到用量上限，请调整到高于已用量的上限，或选择“不限”后继续。');
      await requireModel(ctx);
      save(
        {
          ...goal,
          reason: undefined,
          summary: undefined,
          tokenBudget: budget,
          status: 'active',
          continuations: 0,
          noProgressRuns: 0,
          failedRuns: 0,
        },
        ctx,
      );
      pi.sendUserMessage(`继续完成 Goal：\n${goal!.objective}`);
    } else if (command.action === 'start') {
      validateGoalObjective(command.objective);
      requireTools();
      await requireModel(ctx, true);
      if (goal && goal.status !== 'completed') {
        const prior = { id: goal.id, revision: goal.revision, status: goal.status };
        if (!(await ctx.ui.confirm('替换当前 Goal？', '当前 Goal 的进度记录会清除，已完成的修改保留。')))
          return false;
        if (goal?.id !== prior.id || goal.revision !== prior.revision || goal.status !== prior.status)
          throw new Error('Goal 已变化，请重新确认替换。');
        if (!ctx.isIdle()) {
          pause('用户替换 Goal，当前执行已停止。', ctx);
          ctx.abort();
          if ('waitForIdle' in ctx && typeof ctx.waitForIdle === 'function') await ctx.waitForIdle();
          if (goal?.id !== prior.id || goal.revision !== prior.revision)
            throw new Error('Goal 已变化，请重新确认替换。');
        }
      }
      if (!ctx.isIdle()) throw new Error('请先等待当前任务结束或停止，再开始 Goal。');
      requireTools();
      await requireModel(ctx);
      const now = Date.now();
      save(
        {
          version: 2,
          id: randomUUID(),
          revision: 1,
          objective: command.objective.trim(),
          references: command.references?.length ? [...command.references] : undefined,
          status: 'active',
          tokenBudget: command.tokenBudget,
          tokensUsed: 0,
          billedTokensUsed: 0,
          costUsed: 0,
          timeUsedMs: 0,
          continuations: 0,
          noProgressRuns: 0,
          failedRuns: 0,
          createdAt: now,
          updatedAt: now,
        },
        ctx,
      );
      pi.sendMessage(
        { customType: 'desktop-goal-start', content: 'Goal', display: false, details: { goalId: goal!.id } },
        { triggerTurn: false },
      );
      const first = command.firstMessage;
      pi.sendUserMessage(
        first ? [{ type: 'text', text: first.text }, ...(first.images ?? [])] : command.objective,
      );
    }
    return true;
  };
  pi.registerCommand('goal', {
    description: '持续执行目标：/goal [--tokens N] <目标>；edit [新目标]、status、pause、resume、clear',
    handler: async (input, ctx) => {
      try {
        const command = parseGoalCommand(input);
        if (stateError && command.action !== 'clear') throw new Error(stateError);
        if (
          (command.action === 'menu' && (!goal || goal.status === 'completed')) ||
          (command.action === 'edit' && !command.objective)
        ) {
          if (command.action === 'edit' && !goal) throw new Error('当前没有可编辑的 Goal。');
          ctx.ui.notify(
            '__PI_DESKTOP__' +
              JSON.stringify({ type: 'desktop_goal_compose', edit: command.action === 'edit' }),
          );
          return;
        }
        await execute(command, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  return {
    isActive: () => goal?.status === 'active',
    action: async (value: unknown, ctx: ExtensionContext) => {
      validateGoalAction(value);
      if (value.action !== 'start' && goal?.id !== value.goalId)
        throw new Error('Goal 已变化，请重新打开 Goal。');
      if (stateError && value.action !== 'clear') throw new Error(stateError);
      return { applied: await execute(value, ctx) };
    },
  };
}
