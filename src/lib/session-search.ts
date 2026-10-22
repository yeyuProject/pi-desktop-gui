import { messageText, type Message, type ToolActivity } from '../../shared/types';
import { stripAnsi } from './ansi';
import { splitUserContent } from './message-content';
export interface SessionMatch {
  messageIndex?: number;
  toolId?: string;
  section: 'text' | 'thinking' | 'attachment' | 'tool';
  snippet: string;
  text: string;
  query: string;
  start: number;
  occurrence: number;
  blockIndex?: number;
}
export function searchSession(messages: Message[], tools: ToolActivity[], query: string): SessionMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: SessionMatch[] = [],
    seen = new Set<string>();
  const byId = new Map(tools.map((t) => [t.id, t]));
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const add = (
    text: string,
    target: Omit<SessionMatch, 'text' | 'start' | 'snippet' | 'query' | 'occurrence'>,
  ) => {
    const lower = text.toLocaleLowerCase();
    let occurrence = 0;
    for (
      let start = lower.indexOf(needle);
      start >= 0;
      start = lower.indexOf(needle, start + needle.length)
    ) {
      matches.push({
        ...target,
        text,
        start,
        occurrence: occurrence++,
        query: query.trim(),
        snippet: text.slice(Math.max(0, start - 32), start + needle.length + 64),
      });
    }
  };
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (Array.isArray(message.content))
      for (const block of message.content) {
        if (block.type === 'toolCall' && block.id)
          calls.set(block.id, { name: block.name ?? '', args: block.arguments ?? {} });
      }
    if (message.role === 'toolResult') {
      const id = message.toolCallId ?? '',
        tool = byId.get(id),
        call = calls.get(id);
      seen.add(id);
      add(
        [
          tool?.name ?? message.toolName ?? call?.name ?? '',
          JSON.stringify(tool?.args ?? call?.args ?? {}),
          stripAnsi(messageText(message)),
          tool?.patch ?? '',
        ].join('\n'),
        { messageIndex, toolId: id, section: 'tool' },
      );
      continue;
    }
    if (message.role === 'user') {
      const parsed = splitUserContent(messageText(message));
      add(parsed.text, { messageIndex, section: 'text' });
      parsed.files.forEach((file, blockIndex) =>
        add(file.path + '\n' + file.text, { messageIndex, section: 'attachment', blockIndex }),
      );
    } else if (message.role === 'bashExecution') {
      add(String(message.command ?? '') + '\n' + stripAnsi(String(message.output ?? '')), {
        messageIndex,
        section: 'text',
      });
    } else add(messageText(message) + (message.errorMessage ?? ''), { messageIndex, section: 'text' });
    if (Array.isArray(message.content))
      message.content
        .filter((b) => b.type === 'thinking' && b.thinking)
        .forEach((block, blockIndex) =>
          add(block.thinking!, { messageIndex, section: 'thinking', blockIndex }),
        );
  }
  for (const tool of tools)
    if (!seen.has(tool.id))
      add([tool.name, JSON.stringify(tool.args), stripAnsi(tool.output), tool.patch ?? ''].join('\n'), {
        toolId: tool.id,
        section: 'tool',
      });
  return matches;
}
export function limitForMessage(total: number, index: number, current: number): number {
  return Math.max(current, Math.ceil((total - index) / 80) * 80);
}
