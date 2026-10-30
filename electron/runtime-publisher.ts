import type { EventEmitter } from 'node:events';
import type { Runtime, Message, ToolActivity } from '../shared/types';

/** Owns streamed-state serialization caches and the pending publication timer. */
export class RuntimePublisher {
  private publishing?: NodeJS.Timeout;
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
    }, 40);
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
      (item, index) => index >= r.tools.length - 8 || (item as ToolActivity).status === 'running',
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
    this.events.emit('runtimePatch', {
      ...fields,
      sessionId: r.sessionId,
      ...(removed.length ? { removed } : {}),
      messagesFrom,
      messages: messages.slice(messagesFrom).map((s) => JSON.parse(s)),
      messageCount: messages.length,
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
  }

  cancelPending() {
    if (this.publishing) clearTimeout(this.publishing);
  }
}
