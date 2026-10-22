import { messageText, type Message, type ToolActivity } from '../../shared/types';
import { splitUserContent } from './message-content';
const readOnly = new Set(['read', 'grep', 'find', 'ls', 'tool_search']);

/** Nested calls have live tool events but no separate transcript message. */
export function placeRuntimeTools(messages: Message[], tools: ToolActivity[]) {
  const results = new Set<string>();
  const messageForTool = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== 'toolResult') return;
    if (message.toolCallId) {
      results.add(message.toolCallId);
      messageForTool.set(message.toolCallId, index);
    }
    for (const call of message.nestedCalls?.calls ?? []) messageForTool.set(call.id, index);
  });
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const afterMessage = new Map<number, ToolActivity[]>();
  const trailing: ToolActivity[] = [];
  for (const tool of tools) {
    if (results.has(tool.id)) continue;
    let id: string | undefined = tool.id;
    const seen = new Set<string>();
    while (id && !messageForTool.has(id) && !seen.has(id)) {
      seen.add(id);
      id = byId.get(id)?.parentToolCallId;
    }
    const index = id ? messageForTool.get(id) : undefined;
    if (index === undefined) trailing.push(tool);
    else {
      messageForTool.set(tool.id, index);
      const siblings = afterMessage.get(index) ?? [];
      siblings.push(tool);
      afterMessage.set(index, siblings);
    }
  }
  return { afterMessage, trailing, messageForTool };
}

export function hideRecoveredErrors(messages: Message[]): Message[] {
  const result: Message[] = [];
  let recovered = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') recovered = false;
    if (message.role === 'assistant') {
      if (message.stopReason === 'stop' || message.stopReason === 'toolUse') recovered = true;
      else if (message.stopReason === 'error' && recovered) {
        if (!message.content.length) continue;
        result.push({ ...message, errorMessage: undefined });
        continue;
      }
    }
    result.push(message);
  }
  return result.reverse();
}
// Text-less tool, thinking, image and unknown blocks may carry meaningful work.
// Only genuinely empty failed replies can share a compact presentation.
function isEmptyFailure(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    message.stopReason === 'error' &&
    Boolean(message.errorMessage) &&
    (typeof message.content === 'string'
      ? !message.content.trim()
      : message.content.every((block) => block.type === 'text' && !block.text?.trim()))
  );
}
export type ConversationItem =
  { kind: 'message'; index: number } | { kind: 'group' | 'errors'; id: string; indices: number[] };
export function groupConversation(
  messages: Message[],
  toolFor: (message: Message) => ToolActivity,
  expanded: string[],
): ConversationItem[] {
  const result: ConversationItem[] = [],
    pending: number[] = [];
  const flush = () => {
    if (pending.length >= 3)
      result.push({
        kind: 'group',
        id: 'group:' + pending.map((i) => toolFor(messages[i]).id).join(':'),
        indices: [...pending],
      });
    else for (const index of pending) result.push({ kind: 'message', index });
    pending.length = 0;
  };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (isEmptyFailure(message)) {
      flush();
      const indices = [index];
      while (index + 1 < messages.length && isEmptyFailure(messages[index + 1])) indices.push(++index);
      if (indices.length > 1)
        result.push({ kind: 'errors', id: `errors:${message.timestamp ?? ''}:${indices[0]}`, indices });
      else result.push({ kind: 'message', index });
      continue;
    }
    if (message.role === 'toolResult') {
      const tool = toolFor(message);
      if (
        readOnly.has(tool.name) &&
        tool.status === 'done' &&
        !message.isError &&
        !expanded.includes(tool.id)
      ) {
        pending.push(index);
        continue;
      }
    }
    // Tool-call-only assistant envelopes have no visible message; they do not break an exploration group.
    if (
      message.role === 'assistant' &&
      !messageText(message) &&
      !message.errorMessage &&
      Array.isArray(message.content) &&
      !message.content.some((b) => (b.type === 'thinking' && b.thinking) || typeof b.partialJson === 'string')
    )
      continue;
    flush();
    result.push({ kind: 'message', index });
  }
  flush();
  return result;
}
export interface TurnItem {
  turn: number;
  index: number;
  title: string;
  modified: boolean;
  failed: boolean;
  added: number;
  removed: number;
}
export function conversationTurns(
  messages: Message[],
  toolFor: (message: Message) => ToolActivity,
): TurnItem[] {
  const turns: TurnItem[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user')
      turns.push({
        turn: turns.length + 1,
        index,
        title: splitUserContent(messageText(message)).text.slice(0, 36),
        modified: false,
        failed: false,
        added: 0,
        removed: 0,
      });
    const current = turns.at(-1);
    if (!current) continue;
    if (
      message.errorMessage ||
      message.isError ||
      (message.role === 'bashExecution' && Number(message.exitCode))
    )
      current.failed = true;
    if (message.role === 'toolResult') {
      const tool = toolFor(message);
      current.modified ||= tool.name === 'write' || tool.name === 'edit';
      current.failed ||= tool.status === 'error';
      for (const line of tool.patch?.split('\n') ?? []) {
        if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
        if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
      }
    }
  }
  return turns;
}

/** Presentation only: preserve source messages and search coordinates. */
export function turnThinking(messages: Message[], startIndex = 0) {
  const groups: {
    owner: number;
    end: number;
    text: string;
    parts: { index: number; block: number; offset: number }[];
  }[] = [];
  let current: (typeof groups)[number] | undefined;
  messages.forEach((message, index) => {
    if (message.role === 'user') current = undefined;
    if (current) current.end = index;
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    const blocks = message.content.filter((b) => b.type === 'thinking' && b.thinking);
    if (!blocks.length) return;
    if (!current) {
      current = { owner: index, end: index, text: '', parts: [] };
      groups.push(current);
    }
    blocks.forEach((block, blockIndex) => {
      if (current!.text) current!.text += '\n\n';
      current!.parts.push({ index, block: blockIndex, offset: current!.text.length });
      current!.text += block.thinking;
    });
  });
  return groups.filter((g) => g.end >= startIndex);
}
