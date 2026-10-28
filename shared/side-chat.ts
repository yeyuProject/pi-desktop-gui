import { messageText, type Message } from './types';
import { formatMessageQuotes, parseUserMessage, type DraftQuote } from './message-content';
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

export function sideChatPrompt(request: Pick<SideChatRequest, 'prompt' | 'quotes'>) {
  return [formatMessageQuotes(request.quotes), request.prompt].filter(Boolean).join('\n\n');
}

/** CJK text needs about one token per character; other text uses four characters per token. */
export function estimateSideChatTokens(text: string) {
  let characters = 0,
    cjk = 0;
  const pattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  for (const char of text) {
    characters++;
    if (pattern.test(char)) cjk++;
  }
  return cjk + Math.ceil((characters - cjk) / 4);
}

/** The main excerpt, side history and new question share half the model's window. */
export function sideChatContext(
  messages: Message[],
  request: Pick<SideChatRequest, 'scope' | 'replyTimestamp'>,
  contextWindow: number | undefined,
  running: boolean,
  sideMessages: SideChatInput[] = [],
) {
  if (request.scope === 'reply' && !Number.isFinite(request.replyTimestamp))
    throw new Error('请从主会话中的一条回复打开“到此条回复”');
  const window =
    contextWindow && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000;
  const end =
    request.scope === 'quotes'
      ? -1
      : request.scope === 'reply'
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
    turn.reduce((sum, m) => sum + estimateSideChatTokens(m.content) + 8, 0);
  const history = sideMessages.slice();
  let tokens = turns.reduce((sum, turn) => sum + size(turn), size(history)),
    omittedTurns = 0;
  while (turns.length && tokens > window * 0.5) {
    tokens -= size(turns.shift()!);
    omittedTurns++;
  }
  // Keep the new question intact, dropping old side exchanges when the excerpt is already empty.
  while (history.length > 1 && tokens > window * 0.5) {
    tokens -= size([history.shift()!]);
    while (history.length > 1 && history[0].role !== 'user') tokens -= size([history.shift()!]);
  }
  if (tokens > window * 0.5) throw new Error('侧边问题与引用超过模型上下文的一半，请缩短内容后重新发送');
  return { messages: [...turns.flat(), ...history], omittedTurns };
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
