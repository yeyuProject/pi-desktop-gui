import { messageArrayChanges, messageText, type ContentBlock, type Message } from '../../shared/types';
/** Index settled messages once. Streaming text does not change tool calls or quote identities. */
export class TranscriptIndex {
  private before: Message[] = [];
  private count = 0;
  private calls = new Map<string, ContentBlock>();
  private sources = new Set<string>();
  private sourceView = new Set<string>();
  private tailKey = '';
  private prompts: string[] = [];
  private previousPrompt = '';
  derive(messages: Message[]) {
    const change = messageArrayChanges.get(messages);
    const append =
      messages.length >= this.before.length &&
      (change?.previous.deref() === this.before
        ? change.from >= Math.max(0, this.before.length - 1)
        : this.before.slice(0, -1).every((message, index) => message === messages[index]));
    if (!append) {
      this.count = 0;
      this.calls = new Map();
      this.sources = new Set();
      this.sourceView = new Set();
      this.tailKey = '';
      this.prompts = [];
      this.previousPrompt = '';
    }
    const prefixChanged = this.count !== Math.max(0, messages.length - 1);
    for (let at = this.count; at < Math.max(0, messages.length - 1); at++) {
      const message = messages[at];
      if (Array.isArray(message.content))
        for (const block of message.content)
          if (block.type === 'toolCall' && block.id) this.calls.set(String(block.id), block);
      if (message.timestamp !== undefined)
        this.sources.add(
          `${message.role === 'bashExecution' ? 'toolResult' : message.role}:${message.timestamp}`,
        );
      if (message.toolCallId) this.sources.add('tool:' + message.toolCallId);
      if (message.role === 'user') {
        const text = messageText(message).split('\n\n<project_file path=')[0].trim();
        if (text && text !== this.previousPrompt) this.prompts = [...this.prompts, text];
        this.previousPrompt = text;
      }
    }
    this.count = Math.max(0, messages.length - 1);
    this.before = messages;
    const tail = messages.at(-1);
    const keys = [
      ...(tail?.timestamp === undefined
        ? []
        : [`${tail.role === 'bashExecution' ? 'toolResult' : tail.role}:${tail.timestamp}`]),
      ...(tail?.toolCallId ? ['tool:' + tail.toolCallId] : []),
    ];
    const tailKey = keys.join('|');
    if (prefixChanged || tailKey !== this.tailKey) {
      this.sourceView = new Set([...this.sources, ...keys]);
      this.tailKey = tailKey;
    }
    const tailPrompt =
      tail?.role === 'user' ? messageText(tail).split('\n\n<project_file path=')[0].trim() : '';
    return {
      calls: this.calls,
      sources: this.sourceView,
      prompts:
        tailPrompt && tailPrompt !== this.previousPrompt ? [...this.prompts, tailPrompt] : this.prompts,
    };
  }
}
