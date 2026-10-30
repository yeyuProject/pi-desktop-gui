import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  DESKTOP_ASK_TOOL,
  formatAskResult,
  recommendedAnswers,
  validateAskAnswer,
  validateAskRequest,
  type AskAnswer,
} from '../shared/ask';
import { DESKTOP_ASK_PREFIX } from '../shared/pi-bridge';

export function registerDesktopAsk(
  pi: ExtensionAPI,
  isGoalActive: () => boolean,
  { goalTimeoutMs = 600000, now = Date.now } = {},
) {
  let count = 0;
  const enable = () => {
    const tools = pi.getActiveTools();
    if (!tools.includes(DESKTOP_ASK_TOOL)) pi.setActiveTools([...tools, DESKTOP_ASK_TOOL]);
  };
  const reset = () => {
    count = 0;
    enable();
  };
  pi.on('session_start', reset);
  pi.on('session_tree', reset);
  pi.on('before_agent_start', (event) => {
    enable();
    if (event.messageType === 'user') count = 0;
  });
  pi.on('agent_before_settle', () => {
    if (isGoalActive()) count = 0;
  });
  pi.registerTool({
    name: DESKTOP_ASK_TOOL,
    label: '向用户提问',
    description:
      'Ask the user to resolve a consequential choice, then continue the same task with their answer.',
    promptSnippet: 'Ask 1–3 structured questions when a consequential decision needs user input.',
    promptGuidelines: [
      'Ask only when several reasonable choices exist and choosing incorrectly would cause significant rework, the objective is unclear, or a decision is irreversible.',
      'Do not ask for information you can obtain by reading code, running commands, or checking documentation.',
      'Give 2–4 mutually exclusive choices per question and mark one recommended option. Ask at most three questions together; avoid repeated questions in the same turn.',
      'After a skip or timeout, continue with the recommended choices and explain assumptions in the final response.',
      'Do not use this tool to request permission to execute an operation. The desktop handles tool approvals separately.',
    ],
    exposure: 'model-only',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'header', 'question', 'options'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              header: { type: 'string', minLength: 1, maxLength: 24 },
              question: { type: 'string', minLength: 1, maxLength: 2000 },
              multiSelect: { type: 'boolean', default: false },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 6,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['label'],
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 60 },
                    description: { type: 'string', maxLength: 200 },
                    recommended: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async execute(_id, params, signal, _update, ctx) {
      const request: unknown = params;
      validateAskRequest(request);
      if (count >= 3) throw new Error('本轮提问次数已达上限，请按推荐方案继续并说明假设。');
      count++;
      const timeout = isGoalActive() ? goalTimeoutMs : undefined;
      const started = now();
      let answer: AskAnswer = { status: 'cancelled' };
      if (!signal?.aborted) {
        const reply = await ctx.ui.input(DESKTOP_ASK_PREFIX + JSON.stringify(request), '', {
          signal,
          timeout,
        });
        if (reply !== undefined && !signal?.aborted) {
          try {
            const value: unknown = JSON.parse(reply);
            validateAskAnswer(request, value);
            if (value.status === 'timeout_recommended') throw new Error('超时结果只能由提问工具生成');
            answer = value;
          } catch (error) {
            console.error(
              '[desktop_ask_user] Invalid answer:',
              error instanceof SyntaxError
                ? 'invalid JSON'
                : error instanceof Error
                  ? error.message
                  : 'unknown',
            );
            ctx.ui.notify('无法读取问题回答，已取消本次提问。', 'warning');
          }
        } else if (
          timeout !== undefined &&
          !signal?.aborted &&
          isGoalActive() &&
          now() - started >= timeout
        ) {
          answer = { status: 'timeout_recommended', answers: recommendedAnswers(request) };
        }
      }
      return {
        content: [{ type: 'text', text: formatAskResult(answer) }],
        details: { ...request, ...answer },
      };
    },
  });
}
