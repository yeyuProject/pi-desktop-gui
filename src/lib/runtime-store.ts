import { applyRuntimePatch, busy, emptyRuntime, type Runtime, type RuntimePatch } from '../../shared/types';

export interface SessionActivity {
  status: Runtime['status'];
  pending: number;
}
/** Token updates notify only the owning conversation; sidebar subscribers see activity changes. */
export class RuntimeStore {
  private runtimes = new Map<string, Runtime>();
  private listeners = new Map<string, Set<() => void>>();
  private activityListeners = new Set<() => void>();
  private activities: Record<string, SessionActivity> = {};
  private empty = emptyRuntime();
  get = (id?: string) => (id && this.runtimes.get(id)) || this.empty;
  has = (id: string) => this.runtimes.has(id);
  getActivities = () => this.activities;
  get anyRunning() {
    return Object.values(this.activities).some((item) => busy(item.status) || item.pending > 0);
  }
  subscribe(id: string | undefined, listener: () => void) {
    const key = id ?? '';
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
  subscribeActivities = (listener: () => void) => {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  };
  set(runtime: Runtime) {
    const id = runtime.sessionId;
    if (!id) return;
    this.runtimes.set(id, runtime);
    for (const listener of this.listeners.get(id) ?? []) listener();
    const before = this.activities[id];
    if (before?.status !== runtime.status || before.pending !== runtime.dialogs.length) {
      this.activities = {
        ...this.activities,
        [id]: { status: runtime.status, pending: runtime.dialogs.length },
      };
      for (const listener of this.activityListeners) listener();
    }
  }
  patch(patch: RuntimePatch) {
    if (patch.sessionId) this.set(applyRuntimePatch(this.get(patch.sessionId), patch));
  }
  remove(id: string) {
    this.runtimes.delete(id);
    const { [id]: _removed, ...activities } = this.activities;
    this.activities = activities;
    for (const listener of this.listeners.get(id) ?? []) listener();
    for (const listener of this.activityListeners) listener();
  }
}
