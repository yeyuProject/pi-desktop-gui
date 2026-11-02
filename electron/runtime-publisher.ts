import type { EventEmitter } from 'node:events';
import type { Runtime, Message, ToolActivity, ContentBlock, RuntimePatch } from '../shared/types';

/** Owns streamed-state serialization caches and the pending publication timer. */
export class RuntimePublisher {
  private publishing?: NodeJS.Timeout;
  private interval = 40;
  private changedBlocks = new Set<number>();
  private changedTools = new Set<string>();
  private tail?: Message;
  private blocks: ContentBlock[] = [];
  messageChanged(at: number) {
    this.changedBlocks.add(at);
  }
  toolChanged(id: string) {
    this.changedTools.add(id);
  }
  setVisible(visible: boolean) {
    this.interval = visible ? 40 : 500;
    if (this.publishing) clearTimeout(this.publishing);
    this.publishing = undefined;
    if (visible) this.publish(true);
    else this.publish();
  }
  constructor(
    private runtime: () => Runtime,
    private events: Pick<EventEmitter, 'listenerCount' | 'emit'>,
  ) {}
  publish(immediate = false) {
    if (immediate) {
      if (this.publishing) clearTimeout(this.publishing);
      this.publishing = undefined;
      this.flush();
      return;
    }
    this.publishing ??= setTimeout(() => {
      this.publishing = undefined;
      this.flush();
    }, this.interval);
  }
  /** What the UI last received, as JSON strings per item, to send only what changed since. */
  private sent = {
    sessionId: undefined as string | undefined,
    messages: [] as string[],
    tools: [] as string[],
  };
  private serialized = new WeakMap<object, string>();
  private sentFields = new Map<string, { value: unknown; json: string | undefined }>();
  private flush() {
    if (this.events.listenerCount('runtime')) this.events.emit('runtime', structuredClone(this.runtime()));
    if (!this.events.listenerCount('runtimePatch')) return;
    const r = this.runtime();
    const reset = this.sent.sessionId !== r.sessionId;
    const tail = r.messages.at(-1);
    const partial =
      !reset &&
      this.changedBlocks.size > 0 &&
      tail === this.tail &&
      r.messages.length === this.sent.messages.length &&
      Array.isArray(tail?.content);
    let messageTail: RuntimePatch['messageTail'];
    if (partial && tail && Array.isArray(tail.content)) {
      const content = tail.content;
      messageTail = {
        index: r.messages.length - 1,
        blocks: [...this.changedBlocks].map((at) => {
          const block = { ...content[at] };
          const before = this.blocks[at];
          const field = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : undefined;
          if (
            field &&
            before?.type === block.type &&
            typeof before[field] === 'string' &&
            typeof block[field] === 'string' &&
            block[field].startsWith(before[field])
          ) {
            const from = before[field].length;
            block[field] = block[field].slice(from);
            return { at, block, from };
          }
          return { at, block: structuredClone(block) };
        }),
      };
    }
    // Messages are only mutated in place at the end (streaming) and tools only while running;
    // everything else is replaced wholesale, so settled objects reuse their cached serialization.
    const changedFrom = (
      items: object[],
      previous: string[],
      next: string[],
      seen: WeakMap<object, string>,
      mutable: (item: object, index: number) => boolean,
    ) => {
      let from = reset ? 0 : Math.min(previous.length, items.length);
      for (let i = 0; i < items.length; i++) {
        if (partial && items === r.messages && i === items.length - 1) {
          next[i] = previous[i];
          continue;
        }
        const changing = mutable(items[i], i);
        const frozen = !changing && seen.get(items[i]);
        next[i] = frozen || JSON.stringify(items[i]);
        if (changing) seen.delete(items[i]);
        else if (!frozen) seen.set(items[i], next[i]);
        if (i < from && next[i] !== previous[i]) from = i;
      }
      return from;
    };
    const messages: string[] = [],
      tools: string[] = [];
    const messagesFrom = changedFrom(
      r.messages,
      this.sent.messages,
      messages,
      this.serialized,
      (item, index) => index === r.messages.length - 1 && (item as Message).role === 'assistant',
    );
    // Preserve late updates to recent tools and the final transition of older
    // concurrent tools, which must remain uncached while running.
    const toolsFrom = changedFrom(
      r.tools,
      this.sent.tools,
      tools,
      this.serialized,
      (item) =>
        this.changedTools.has((item as ToolActivity).id) || (item as ToolActivity).status === 'running',
    );
    const { messages: _m, tools: _t, ...rest } = r;
    const fields: Record<string, unknown> = {};
    const removed = [...this.sentFields.keys()].filter((key) => !(key in rest));
    for (const key of removed) this.sentFields.delete(key);
    for (const [key, value] of Object.entries(rest)) {
      const before = this.sentFields.get(key);
      // These collections are replaced when updated. Avoid scanning large diagnostics
      // and model catalogs on every token; other (mutable) fields are compared by value.
      const replaced = key === 'diagnostic' || key === 'models' || key === 'commands';
      if (!reset && before && (replaced || typeof value !== 'object') && before.value === value) continue;
      const json = JSON.stringify(value);
      if (reset || !before || before.json !== json) fields[key] = structuredClone(value);
      this.sentFields.set(key, { value, json });
    }
    this.sent = { sessionId: r.sessionId, messages, tools };
    this.tail = tail;
    this.blocks = Array.isArray(tail?.content) ? tail.content.map((block) => ({ ...block })) : [];
    this.changedBlocks.clear();
    this.changedTools.clear();
    this.events.emit('runtimePatch', {
      ...fields,
      sessionId: r.sessionId,
      ...(removed.length ? { removed } : {}),
      messagesFrom,
      messages: messages.slice(messagesFrom).map((s) => JSON.parse(s)),
      messageCount: messages.length,
      ...(messageTail ? { messageTail } : {}),
      toolsFrom,
      tools: tools.slice(toolsFrom).map((s) => JSON.parse(s)),
      toolCount: tools.length,
    });
  }
  /** Next patch carries the whole runtime, e.g. after the window reloads. */
  resync() {
    this.sent = { sessionId: undefined, messages: [], tools: [] };
    this.serialized = new WeakMap();
    this.sentFields.clear();
    this.tail = undefined;
    this.blocks = [];
    this.changedBlocks.clear();
    this.changedTools.clear();
  }

  cancelPending() {
    if (this.publishing) clearTimeout(this.publishing);
  }
}
