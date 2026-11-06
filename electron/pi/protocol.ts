import type { Message, Model, PiCommand, Runtime } from '../../shared/types';
import { DESKTOP_BRIDGE_PROTOCOL } from '../../shared/pi-bridge';
import { isApprovalGrant } from '../../shared/approval';

export interface PiState {
  model?: Model;
  thinkingLevel?: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  autoCompactionEnabled?: boolean;
  steeringMode?: string;
  followUpMode?: string;
}
export interface RpcResults {
  get_state: PiState;
  get_messages: { messages: Message[] };
  get_available_models: { models: Model[] };
  get_available_thinking_levels: { levels: string[] };
  get_commands: { commands: PiCommand[] };
}
export type RpcResult<K extends string> = K extends keyof RpcResults ? RpcResults[K] : any;
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const model = (value: unknown) =>
  object(value) && typeof value.id === 'string' && typeof value.provider === 'string';
const numbers = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function incompatible(command: string, detail: string): never {
  throw new Error(
    `Pi 返回的 ${command} 数据格式与当前桌面端不兼容（${detail}）。请在诊断中记录 Pi 版本及错误信息，更新 Pi Desktop 或 Pi 后重试。`,
  );
}

/** Check documented fields at the subprocess boundary. Unknown additional fields are allowed. */
export function validateRpcResult(command: string, value: unknown) {
  if (command === 'get_state') {
    if (
      !object(value) ||
      typeof value.isStreaming !== 'boolean' ||
      typeof value.isCompacting !== 'boolean' ||
      !numbers(value.pendingMessageCount) ||
      value.pendingMessageCount < 0 ||
      (value.model !== undefined && !model(value.model)) ||
      (value.sessionFile !== undefined && typeof value.sessionFile !== 'string') ||
      (value.sessionName !== undefined && typeof value.sessionName !== 'string')
    )
      incompatible(command, '会话状态缺少必要字段');
  } else if (command === 'get_messages') {
    if (
      !object(value) ||
      !Array.isArray(value.messages) ||
      value.messages.some(
        (message) =>
          !object(message) ||
          typeof message.role !== 'string' ||
          (['user', 'assistant', 'toolResult'].includes(message.role) &&
            typeof message.content !== 'string' &&
            !Array.isArray(message.content)),
      )
    )
      incompatible(command, '消息列表无效');
  } else if (command === 'get_available_models') {
    if (!object(value) || !Array.isArray(value.models) || !value.models.every(model))
      incompatible(command, '模型列表无效');
  } else if (command === 'get_available_thinking_levels') {
    if (
      !object(value) ||
      !Array.isArray(value.levels) ||
      value.levels.some((level) => typeof level !== 'string')
    )
      incompatible(command, '推理级别列表无效');
  } else if (command === 'get_commands') {
    if (
      !object(value) ||
      !Array.isArray(value.commands) ||
      value.commands.some((c) => !object(c) || typeof c.name !== 'string')
    )
      incompatible(command, '命令列表无效');
  }
}

const content = (value: unknown) =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every((block) => object(block) && typeof block.type === 'string'));
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Guard fields consumed by the desktop, not the entire Pi schema. Unknown events/fields pass through. */
export function validateRpcEvent(value: unknown) {
  if (!object(value) || typeof value.type !== 'string') incompatible('事件', '缺少事件类型');
  const check = (valid: boolean, field: string) => {
    if (!valid) incompatible(value.type, `${field} 无效`);
  };
  switch (value.type) {
    case 'message_start':
    case 'message_end': {
      const message = value.message;
      check(object(message) && typeof message.role === 'string', 'message');
      // Bash, summaries and extension-defined roles need not have a content field.
      if (['user', 'assistant', 'toolResult', 'custom'].includes(message.role))
        check(content(message.content), 'message.content');
      break;
    }
    case 'message_update': {
      const event = value.assistantMessageEvent;
      check(object(event) && typeof event.type === 'string', 'assistantMessageEvent');
      if (
        [
          'text_start',
          'text_delta',
          'text_end',
          'thinking_start',
          'thinking_delta',
          'thinking_end',
          'toolcall_start',
          'toolcall_delta',
          'toolcall_end',
        ].includes(event.type)
      )
        check(Number.isSafeInteger(event.contentIndex) && event.contentIndex >= 0, 'contentIndex');
      if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.type))
        check(typeof event.delta === 'string', 'delta');
      if (['text_end', 'thinking_end'].includes(event.type))
        check(typeof event.content === 'string', 'content');
      if (event.type === 'toolcall_end')
        check(
          object(event.toolCall) &&
            event.toolCall.type === 'toolCall' &&
            typeof event.toolCall.id === 'string' &&
            typeof event.toolCall.name === 'string',
          'toolCall',
        );
      // Do not validate tool arguments: Pi must report invalid model arguments as tool errors.
      // Keep toolcall_start ids optional; the final toolCall is authoritative.
      break;
    }
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end': {
      check(typeof value.toolCallId === 'string', 'toolCallId');
      if (value.type !== 'tool_execution_update') check(typeof value.toolName === 'string', 'toolName');
      const result = value.type === 'tool_execution_end' ? value.result : value.partialResult;
      // Untyped extensions may omit results/content; retain the existing empty-output fallback.
      if (result != null) {
        check(object(result), 'result');
        if (result.content != null) check(content(result.content), 'result.content');
      }
      if (value.type === 'tool_execution_end' && value.isError !== undefined)
        check(typeof value.isError === 'boolean', 'isError');
      break;
    }
    case 'queue_update':
      if (value.steering != null) check(strings(value.steering), 'steering');
      if (value.followUp != null) check(strings(value.followUp), 'followUp');
      break;
    case 'entry_appended':
      check(object(value.entry) && typeof value.entry.type === 'string', 'entry');
      if (value.entry.type === 'custom_message') check(content(value.entry.content), 'entry.content');
      break;
    case 'agent_settled':
      if (value.aborted !== undefined) check(typeof value.aborted === 'boolean', 'aborted');
      break;
  }
}

export function validateBridgeResult(method: string, value: unknown) {
  if (
    method === 'side_chat' &&
    (!object(value) ||
      typeof value.text !== 'string' ||
      typeof value.aborted !== 'boolean' ||
      !object(value.usage) ||
      !numbers(value.usage.tokens) ||
      value.usage.tokens < 0 ||
      !numbers(value.usage.cost) ||
      value.usage.cost < 0)
  )
    incompatible('侧边回答', '回答或费用数据无效');
  if (
    method === 'options' &&
    (!object(value) ||
      value.protocolVersion !== DESKTOP_BRIDGE_PROTOCOL ||
      typeof value.autoRetry !== 'boolean' ||
      !['auto', 'confirm', 'readonly'].includes(value.approvalMode))
  )
    incompatible('Pi Desktop 的配套扩展', 'Pi Desktop 的配套扩展没有加载，或者和当前 Pi 版本不匹配。');
  if (
    ['options', 'approval_mode', 'revoke_approval'].includes(method) &&
    (!object(value) || !Array.isArray(value.approvalGrants) || !value.approvalGrants.every(isApprovalGrant))
  )
    incompatible('桌面审批', '已授权规则列表无效');
}

export function sessionStats(value: unknown): Runtime['stats'] {
  if (!object(value)) incompatible('get_session_stats', '统计数据无效');
  const optionalNumber = (value: unknown, field: string) => {
    // Pi documents null usage immediately after compaction, until the next model response.
    if (value === undefined || value === null) return undefined;
    if (!numbers(value) || value < 0) incompatible('get_session_stats', field + ' 不是有效非负数字');
    return value as number;
  };
  return {
    tokens: optionalNumber(value.tokens?.total, 'tokens.total'),
    inputTokens: optionalNumber(value.tokens?.input, 'tokens.input'),
    outputTokens: optionalNumber(value.tokens?.output, 'tokens.output'),
    cacheReadTokens: optionalNumber(value.tokens?.cacheRead, 'tokens.cacheRead'),
    cacheWriteTokens: optionalNumber(value.tokens?.cacheWrite, 'tokens.cacheWrite'),
    cost: optionalNumber(value.cost, 'cost'),
    contextPercent: optionalNumber(value.contextUsage?.percent, 'contextUsage.percent'),
    contextTokens: optionalNumber(value.contextUsage?.tokens, 'contextUsage.tokens'),
    contextWindow: optionalNumber(value.contextUsage?.contextWindow, 'contextUsage.contextWindow'),
  };
}
