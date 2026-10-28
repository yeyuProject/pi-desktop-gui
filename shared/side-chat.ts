import { messageText, type Message } from './types';
import { parseUserMessage, type DraftQuote } from './message-content';
import type { ModelErrorDescription } from './errors';

export interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  usage?: { tokens: number; cost: number };
  aborted?: boolean;
}
export interface SideChat {
  sessionId: string;
  messages: SideChatMessage[];
  running?: string;
  error?: ModelErrorDescription;
  omittedTurns: number;
}
export interface SideChatRequest {
  id: string;
  prompt: string;
  quotes: DraftQuote[];
  scope: 'quotes' | 'reply' | 'all';
  replyTimestamp?: number;
}
export interface SideChatInput {
  role: 'user' | 'assistant';
  content: string;
}
export interface SideChatResult {
  text: string;
  aborted: boolean;
  usage: { tokens: number; cost: number };
}

/** Conservative text estimate; leave at least half the window for the side conversation. */
export function sideChatContext(
  messages: Message[],
  request: Pick<SideChatRequest, 'scope' | 'replyTimestamp'>,
  contextWindow: number | undefined,
  running: boolean,
) {
  if (request.scope === 'quotes') return { messages: [] as SideChatInput[], omittedTurns: 0 };
  if (request.scope === 'reply' && !Number.isFinite(request.replyTimestamp))
    throw new Error('请从主会话中的一条回复打开“到此条回复”');
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0)
    throw new Error('当前模型没有提供上下文窗口大小，请改选“仅引用内容”或完善模型配置');
  const end =
    request.scope === 'reply'
      ? messages.findIndex((m) => m.role === 'assistant' && m.timestamp === request.replyTimestamp)
      : messages.findLastIndex(
          (m) =>
            m.role === 'assistant' &&
            (['stop', 'length', 'error', 'aborted'].includes(m.stopReason ?? '') ||
              (!running && m.stopReason !== 'toolUse')),
        );
  if (end < 0 && request.scope === 'reply') throw new Error('这条回复已不在当前分支，请重新选择上下文范围');
  const turns: SideChatInput[][] = [];
  const calls = new Map<string, { name: string; path?: string }>();
  for (const m of messages.slice(0, end + 1)) {
    if (m.role === 'user') turns.push([]);
    const turn = turns.at(-1);
    if (!turn) continue;
    if (m.role === 'user') {
      const parsed = parseUserMessage(messageText(m));
      const content = [
        ...parsed.quotes.map((q) => `引用：${q.text}`),
        parsed.text || (parsed.skill ? `/skill:${parsed.skill.name}` : ''),
      ].join('\n\n');
      if (content) turn.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.content))
        for (const b of m.content)
          if (b.type === 'toolCall' && b.id)
            calls.set(b.id, {
              name: b.name ?? '工具',
              path: typeof b.arguments?.path === 'string' ? b.arguments.path : undefined,
            });
      const content = messageText(m);
      if (content.trim()) turn.push({ role: 'assistant', content });
    } else if (m.role === 'toolResult') {
      const call = calls.get(m.toolCallId ?? '');
      turn.push({
        role: 'user',
        content: `[工具：${m.toolName ?? call?.name ?? '工具'}${call?.path ? '，目标：' + call.path : ''}]`,
      });
    }
  }
  const size = (turn: SideChatInput[]) =>
    turn.reduce((sum, m) => sum + Math.ceil(m.content.length / 3) + 8, 0);
  let tokens = turns.reduce((sum, turn) => sum + size(turn), 0),
    omittedTurns = 0;
  while (turns.length && tokens > contextWindow * 0.5) {
    tokens -= size(turns.shift()!);
    omittedTurns++;
  }
  return { messages: turns.flat(), omittedTurns };
}

export function validateSideChatInput(
  value: unknown,
): asserts value is { id: string; messages: SideChatInput[] } {
  const p = value as { id?: unknown; messages?: unknown };
  if (
    !p ||
    typeof p.id !== 'string' ||
    !/^[\w-]{1,100}$/.test(p.id) ||
    !Array.isArray(p.messages) ||
    !p.messages.length ||
    p.messages.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') ||
    JSON.stringify(p.messages).length > 4 * 1024 * 1024
  )
    throw new Error('侧边提问内容无效或过长，请缩短问题或清空侧边历史后重新发送');
}
