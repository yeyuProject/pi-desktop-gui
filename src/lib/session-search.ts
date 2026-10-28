import { messageText, type ContentBlock, type Message, type ToolActivity } from '../../shared/types';
import { stripAnsi } from './ansi';
import { parseUserMessage } from './message-content';

export interface SessionMatch {
  messageIndex?: number;
  toolId?: string;
  section: 'text' | 'skill' | 'quote' | 'thinking' | 'attachment' | 'tool';
  snippet: string;
  text: string;
  query: string;
  start: number;
  occurrence: number;
  blockIndex?: number;
}
type Target = Pick<SessionMatch, 'section' | 'toolId' | 'blockIndex'>;
interface SearchPart {
  text: string;
  lower: string;
  target: Target;
  needle?: string;
  offsets: number[];
  active?: SessionMatch;
}
export interface SessionMatches {
  length: number;
  at(index: number): SessionMatch | undefined;
}
const part = (text: string, target: Target): SearchPart => ({
  text,
  lower: text.toLocaleLowerCase(),
  target,
  offsets: [],
});

/** Renderer messages and tools are immutable snapshots. Reuse unchanged search
 * text/offsets across stream patches; retain one query per part and no global text cache.
 */
export class SessionSearch {
  private messages = new WeakMap<
    Message,
    { tool?: ToolActivity; call?: ContentBlock; parts: SearchPart[] }
  >();
  private tools = new WeakMap<ToolActivity, SearchPart>();

  private parts(message: Message, tool?: ToolActivity, call?: ContentBlock): SearchPart[] {
    const cached = this.messages.get(message);
    if (cached && cached.tool === tool && cached.call === call) return cached.parts;
    const parts: SearchPart[] = [];
    if (message.role === 'toolResult') {
      parts.push(
        part(
          [
            tool?.name ?? message.toolName ?? call?.name ?? '',
            JSON.stringify(tool?.args ?? call?.arguments ?? {}),
            stripAnsi(messageText(message)),
            tool?.patch ?? '',
          ].join('\n'),
          { toolId: message.toolCallId ?? '', section: 'tool' },
        ),
      );
    } else {
      if (message.role === 'user') {
        const parsed = parseUserMessage(messageText(message));
        const skill = parsed.skill;
        if (skill) parts.push(part(skill.content, { section: 'skill' }));
        parsed.quotes.forEach((quote, blockIndex) =>
          parts.push(part(quote.text, { section: 'quote', blockIndex })),
        );
        parts.push(part(parsed.text || (skill ? `使用技能 ${skill.name}` : ''), { section: 'text' }));
        parsed.files.forEach((file, blockIndex) =>
          parts.push(part(file.path + '\n' + file.text, { section: 'attachment', blockIndex })),
        );
      } else if (message.role === 'bashExecution') {
        parts.push(
          part(String(message.command ?? '') + '\n' + stripAnsi(String(message.output ?? '')), {
            section: 'text',
          }),
        );
      } else parts.push(part(messageText(message) + (message.errorMessage ?? ''), { section: 'text' }));
      if (Array.isArray(message.content))
        message.content
          .filter((b) => b.type === 'thinking' && b.thinking)
          .forEach((block, blockIndex) =>
            parts.push(part(block.thinking!, { section: 'thinking', blockIndex })),
          );
    }
    this.messages.set(message, { tool, call, parts });
    return parts;
  }

  search(messages: Message[], tools: ToolActivity[], query: string): SessionMatches {
    query = query.trim();
    const needle = query.toLocaleLowerCase();
    const groups: { part: SearchPart; offsets: number[]; messageIndex?: number; end: number }[] = [];
    let length = 0;
    const add = (part: SearchPart, messageIndex?: number) => {
      if (part.needle !== needle) {
        part.needle = needle;
        part.offsets = [];
        for (
          let at = part.lower.indexOf(needle);
          at >= 0;
          at = part.lower.indexOf(needle, at + needle.length)
        )
          part.offsets.push(at);
      }
      if (!part.offsets.length) return;
      length += part.offsets.length;
      groups.push({ part, offsets: part.offsets, messageIndex, end: length });
    };
    if (needle) {
      const seen = new Set<string>();
      const byId = new Map(tools.map((t) => [t.id, t]));
      const calls = new Map<string, ContentBlock>();
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (Array.isArray(message.content))
          for (const block of message.content)
            if (block.type === 'toolCall' && block.id) calls.set(block.id, block);
        const id = message.role === 'toolResult' ? (message.toolCallId ?? '') : undefined;
        if (id !== undefined) seen.add(id);
        for (const part of this.parts(
          message,
          id === undefined ? undefined : byId.get(id),
          id === undefined ? undefined : calls.get(id),
        ))
          add(part, index);
      }
      for (const tool of tools) {
        if (seen.has(tool.id)) continue;
        let cached = this.tools.get(tool);
        if (!cached) {
          cached = part(
            [tool.name, JSON.stringify(tool.args), stripAnsi(tool.output), tool.patch ?? ''].join('\n'),
            { toolId: tool.id, section: 'tool' },
          );
          this.tools.set(tool, cached);
        }
        add(cached);
      }
    }
    return {
      length,
      at(index) {
        if (!Number.isInteger(index) || index < 0 || index >= length) return;
        let low = 0,
          high = groups.length - 1;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (index < groups[middle].end) high = middle;
          else low = middle + 1;
        }
        const group = groups[low],
          source = group.part;
        const occurrence = index - (group.end - group.offsets.length),
          start = group.offsets[occurrence];
        const active = source.active;
        if (
          active &&
          active.query === query &&
          active.occurrence === occurrence &&
          active.start === start &&
          active.messageIndex === group.messageIndex
        )
          return active;
        return (source.active = {
          ...source.target,
          messageIndex: group.messageIndex,
          text: source.text,
          query,
          start,
          occurrence,
          snippet: source.text.slice(Math.max(0, start - 32), start + needle.length + 64),
        });
      },
    };
  }
}
