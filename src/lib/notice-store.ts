export const NOTICE_ENTER_MS = 160;
export const NOTICE_EXIT_MS = 120;
export type NoticeLevel = 'success' | 'info' | 'warning' | 'error';
export interface NoticeOptions {
  level?: NoticeLevel;
  action?: { label: string; run: () => unknown | Promise<unknown> };
}
export interface Notice extends NoticeOptions {
  id: number;
  text: string;
  level: NoticeLevel;
  entering: boolean;
  leaving: boolean;
}
export interface NoticeClock {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}
const systemClock: NoticeClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
interface Entry {
  value: Notice;
  duration: number;
  remaining: number;
  deadline: number;
  pauses: Set<string>;
  timer?: unknown;
  motionTimer?: unknown;
}
/** UI11 minimums (3.5 s, info 5 s, actions 6 s, warnings 9 s); long text gets up to 8 s to read. */
export function noticeDuration(text: string, options: NoticeOptions = {}) {
  if (options.level === 'error') return Infinity;
  if (options.level === 'warning') return 9000;
  const minimum = options.action ? 6000 : options.level === 'info' ? 5000 : 3500;
  return Math.max(minimum, Math.min(8000, 1500 + Array.from(text).length * 60));
}

/** Owns notification timers without updating the workbench. Leaving entries still occupy a slot. */
export class NoticeStore {
  private sequence = 0;
  private entries: Entry[] = [];
  private waiting: Entry[] = [];
  private snapshot: readonly Notice[] = [];
  /** Reasons that hold every timer, e.g. the pointer resting on the stack. */
  private holds = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private clock: NoticeClock = systemClock) {}
  get = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    const next = this.entries.map((entry) => entry.value);
    if (next.length === this.snapshot.length && next.every((value, index) => value === this.snapshot[index]))
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private cancel(handle: unknown) {
    if (handle !== undefined) this.clock.clearTimeout(handle);
  }
  notice = (text: string, options: NoticeOptions = {}) => {
    if (!text.trim()) return;
    const level = options.level ?? 'success';
    // Repeating a notice replays it instead of stacking an identical copy.
    const same = (item: Entry) =>
      item.value.text === text && item.value.level === level && !item.value.leaving;
    for (const item of this.entries.filter(same)) {
      this.cancel(item.timer);
      this.cancel(item.motionTimer);
    }
    this.entries = this.entries.filter((item) => !same(item));
    this.waiting = this.waiting.filter((item) => !same(item));
    const entry: Entry = {
      value: {
        ...options,
        id: ++this.sequence,
        text,
        level,
        entering: true,
        leaving: false,
      },
      duration: noticeDuration(text, options),
      remaining: noticeDuration(text, options),
      deadline: 0,
      pauses: new Set(),
    };
    this.waiting.push(entry);
    // A burst must not leave an unbounded queue behind the three visible notifications.
    if (this.waiting.length > 3) {
      const index = this.waiting.findIndex((item) => item.value.level !== 'error');
      this.waiting.splice(index < 0 ? 0 : index, 1);
    }
    this.fill();
    this.publish();
    return entry.value.id;
  };
  private start(entry: Entry) {
    if (!Number.isFinite(entry.remaining) || entry.pauses.size || this.holds.size || entry.value.leaving)
      return;
    entry.deadline = this.clock.now() + entry.remaining;
    entry.timer = this.clock.setTimeout(() => this.dismiss(entry.value.id), entry.remaining);
  }
  private fill() {
    while (this.entries.length < 3 && this.waiting.length) {
      const entry = this.waiting.shift()!;
      this.entries.push(entry);
      this.start(entry);
      entry.motionTimer = this.clock.setTimeout(() => {
        entry.value = { ...entry.value, entering: false };
        entry.motionTimer = undefined;
        this.publish();
      }, NOTICE_ENTER_MS);
    }
    while (this.waiting.length > this.entries.filter((entry) => entry.value.leaving).length) {
      const active = this.entries.filter((entry) => !entry.value.leaving);
      const entry =
        active.find((item) => item.value.level !== 'error') ??
        (this.waiting.filter((item) => item.value.level === 'error').length >
        this.entries.filter((item) => item.value.leaving).length
          ? active[0]
          : undefined);
      if (entry) this.leave(entry);
      else {
        const index = this.waiting.findIndex((item) => item.value.level !== 'error');
        if (index < 0) break;
        this.waiting.splice(index, 1);
      }
    }
  }
  private leave(entry: Entry) {
    if (entry.value.leaving) return;
    this.cancel(entry.timer);
    this.cancel(entry.motionTimer);
    entry.value = { ...entry.value, entering: false, leaving: true };
    // Keep this in sync with --motion-fast. Also runs when reduced motion disables CSS animations.
    entry.motionTimer = this.clock.setTimeout(() => {
      this.entries = this.entries.filter((item) => item !== entry);
      this.fill();
      this.publish();
    }, NOTICE_EXIT_MS);
  }
  dismiss = (id: number) => {
    const entry = this.entries.find((item) => item.value.id === id);
    if (entry) this.leave(entry);
    else this.waiting = this.waiting.filter((item) => item.value.id !== id);
    this.publish();
  };
  pause = (id: number, reason: string) => {
    const entry = this.entries.find((item) => item.value.id === id);
    if (!entry || entry.value.leaving || entry.pauses.has(reason)) return;
    if (!entry.pauses.size) {
      this.cancel(entry.timer);
      if (Number.isFinite(entry.remaining)) entry.remaining = Math.max(0, entry.deadline - this.clock.now());
    }
    entry.pauses.add(reason);
  };
  resume = (id: number, reason: string) => {
    const entry = this.entries.find((item) => item.value.id === id);
    if (!entry || !entry.pauses.delete(reason)) return;
    if (!entry.pauses.size) this.start(entry);
  };
  /** Hovering or focusing the stack holds all timers; releasing restarts each one in full. */
  hold = (reason: string) => {
    if (this.holds.has(reason)) return;
    if (!this.holds.size) for (const entry of this.entries) this.cancel(entry.timer);
    this.holds.add(reason);
  };
  release = (reason: string) => {
    if (!this.holds.delete(reason) || this.holds.size) return;
    for (const entry of this.entries) {
      if (entry.value.leaving) continue;
      entry.remaining = entry.duration;
      if (!entry.pauses.size) this.start(entry);
    }
  };
  dispose() {
    for (const entry of this.entries) {
      this.cancel(entry.timer);
      this.cancel(entry.motionTimer);
    }
    this.entries = [];
    this.waiting = [];
    this.holds.clear();
    this.publish();
  }
}
export const notices = new NoticeStore();
export const notice = notices.notice;
