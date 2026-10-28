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
    incompatible('桌面适配', '适配扩展未正确加载或协议版本不一致');
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
