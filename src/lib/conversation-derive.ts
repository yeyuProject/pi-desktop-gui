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
  private prefixTurns: TurnItem[] = [];
  private turns: TurnItem[] = [];
  private tools = new Map<string, ToolActivity>();
  private prefixTools = new Set<string>();
  /**
   * 1. 找到当前轮的起点，检查已结束的轮次是否需要重算。
   * 2. 历史消息、工具分组或展开状态有变化时重建前面的分组和目录。
   * 3. 重算当前轮。正文续写没有改变目录内容时，沿用上一次的目录。
   */
  derive(
    messages: Message[],
    tools: ToolActivity[],
    toolFor: (message: Message) => ToolActivity,
    expanded: string[],
    running: boolean,
  ) {
    // 1. 当前轮的工具仍会更新，缓存只覆盖此前的轮次。
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
    // 2. 旧轮的修改和工具展开也会影响分组，不能复用过期的历史。
    const rebuild = !same || boundary !== this.boundary || expansion !== this.expanded || changedTool;
    if (rebuild) {
      const prefix = messages.slice(0, boundary);
      this.items = groupConversation(prefix, toolFor, expanded);
      this.prefixTurns = conversationTurns(prefix, toolFor);
      this.prefixTools = new Set(
        prefix.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId ?? ''),
      );
    }
    this.tools = new Map(tools.map((tool) => [tool.id, tool]));
    this.expanded = expansion;
    this.boundary = boundary;
    this.source = messages;
    // 3. 从最后一条用户消息开始至多有一轮。只有可见摘要变化才让目录重新定位。
    const [current] = conversationTurns(messages, toolFor, running, boundary, this.prefixTurns.length);
    const previous = this.turns[this.prefixTurns.length];
    if (
      rebuild ||
      current?.index !== previous?.index ||
      current?.title !== previous?.title ||
      current?.tooltip !== previous?.tooltip ||
      current?.skillName !== previous?.skillName ||
      current?.replyIndex !== previous?.replyIndex ||
      current?.failed !== previous?.failed ||
      current?.modified !== previous?.modified ||
      current?.added !== previous?.added ||
      current?.removed !== previous?.removed
    )
      this.turns = current ? [...this.prefixTurns, current] : this.prefixTurns;
    return {
      items: this.items.concat(groupConversation(messages, toolFor, expanded, boundary)),
      turns: this.turns,
    };
  }
}
