import { messageArrayChanges, type Message, type ToolActivity } from '../../shared/types';
import {
  conversationTurns,
  groupConversation,
  type ConversationItem,
  type TurnItem,
} from './conversation-layout';
export class ConversationDeriver {
  private source: Message[] = [];
  private boundary = 0;
  private expanded = '';
  private items: ConversationItem[] = [];
  private turns: TurnItem[] = [];
  private tools = new Map<string, ToolActivity>();
  private prefixTools = new Set<string>();
  derive(
    messages: Message[],
    tools: ToolActivity[],
    toolFor: (message: Message) => ToolActivity,
    expanded: string[],
    running: boolean,
  ) {
    let boundary = messages.length - 1;
    while (boundary > 0 && messages[boundary].role !== 'user') boundary--;
    boundary = Math.max(0, boundary);
    const change = messageArrayChanges.get(messages);
    const same =
      messages === this.source ||
      (change?.previous.deref() === this.source
        ? change.from >= this.boundary
        : this.source.slice(0, this.boundary).every((message, index) => message === messages[index]));
    const expansion = expanded.join('\0');
    const changedTool = tools.some(
      (tool) => this.prefixTools.has(tool.id) && this.tools.get(tool.id) !== tool,
    );
    if (!same || boundary !== this.boundary || expansion !== this.expanded || changedTool) {
      const prefix = messages.slice(0, boundary);
      this.items = groupConversation(prefix, toolFor, expanded);
      this.turns = conversationTurns(prefix, toolFor);
      this.prefixTools = new Set(
        prefix.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId ?? ''),
      );
    }
    this.tools = new Map(tools.map((tool) => [tool.id, tool]));
    this.expanded = expansion;
    this.boundary = boundary;
    this.source = messages;
    return {
      items: this.items.concat(groupConversation(messages, toolFor, expanded, boundary)),
      turns: this.turns.concat(conversationTurns(messages, toolFor, running, boundary, this.turns.length)),
    };
  }
}
