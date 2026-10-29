import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { validatePlanSteps, type PlanSnapshot } from '../shared/plan';
import { DESKTOP_PLAN_ENTRY_TYPE, readPlanView } from './plan-state';

export function registerDesktopPlan(pi: ExtensionAPI, isGoalActive: () => boolean) {
  let plan: PlanSnapshot | null = null;
  let turnId: number | undefined;
  let awaitingUser = false;
  let damaged = false;
  const render = (ctx: ExtensionContext) =>
    ctx.ui.notify('__PI_DESKTOP__' + JSON.stringify({ type: 'desktop_plan', plan }));
  const enable = () => {
    const tools = pi.getActiveTools();
    if (!tools.includes('desktop_plan')) pi.setActiveTools([...tools, 'desktop_plan']);
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    const view = readPlanView(ctx.sessionManager.getBranch());
    plan = view.plan;
    turnId = plan?.turnId;
    awaitingUser = false;
    damaged = Boolean(view.warning);
    enable();
    render(ctx);
    if (view.warning) ctx.ui.notify(view.warning, 'warning');
  };
  pi.on('session_start', restore);
  pi.on('session_tree', restore);
  pi.on('before_agent_start', (event, ctx) => {
    enable();
    if (event.messageType !== 'user') return;
    if (plan || damaged) {
      pi.appendEntry(DESKTOP_PLAN_ENTRY_TYPE, null);
      plan = null;
      damaged = false;
      render(ctx);
    }
    turnId = undefined;
    awaitingUser = true;
  });
  // Pi creates the triggering user timestamp after before_agent_start. Capture it
  // from the first message event, and keep it when later steering messages arrive.
  pi.on('message_start', (event) => {
    if (awaitingUser && event.message.role === 'user') {
      turnId = event.message.timestamp;
      awaitingUser = false;
    }
  });
  pi.registerTool({
    name: 'desktop_plan',
    label: '更新任务计划',
    description: 'Replace the progress plan for the current ordinary task.',
    promptSnippet: 'Track progress of multi-step work with a short plan.',
    promptGuidelines: [
      'Use desktop_plan only when the task clearly needs three or more distinct steps. Skip it for questions, explanations and single edits.',
      'Create the plan before starting work, keep exactly one step in_progress, and mark steps completed as soon as they are done.',
      'Updating the plan is not progress by itself; do not call it repeatedly without doing work in between.',
    ],
    exposure: 'model-only',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
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
      required: ['steps'],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _update, ctx) {
      if (isGoalActive()) throw new Error('当前有进行中的 Goal，请使用 desktop_goal_plan');
      const steps: unknown = params.steps;
      validatePlanSteps(steps);
      if (turnId === undefined) throw new Error('当前没有用户任务，请在新任务开始后更新计划。');
      const next = { turnId, steps: steps.map((step) => ({ text: step.text.trim(), status: step.status })) };
      // Publish only a successfully persisted snapshot; failed writes keep the old state.
      pi.appendEntry(DESKTOP_PLAN_ENTRY_TYPE, next);
      plan = next;
      render(ctx);
      return { content: [{ type: 'text', text: JSON.stringify(next) }], details: next };
    },
  });
}
