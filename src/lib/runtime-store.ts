import { applyRuntimePatch, busy, emptyRuntime, type Runtime, type RuntimePatch } from '../../shared/types';
import { retainAskDrafts } from './ask-drafts';

export interface SessionActivity {
  status: Runtime['status'];
  pending: number;
  waitingFor?: '审批' | '提问' | '扩展回复';
}
export type SidebarActivity = Pick<SessionActivity, 'status' | 'pending'>;
/** Token updates notify only the owning conversation; sidebar subscribers see activity changes. */
export class RuntimeStore {
  private runtimes = new Map<string, Runtime>();
  private listeners = new Map<string, Set<() => void>>();
  private activityListeners = new Set<() => void>();
  private activities: Record<string, SessionActivity> = {};
  private sidebarActivities: Record<string, SidebarActivity> = {};
  private empty = emptyRuntime();
  get = (id?: string) => (id && this.runtimes.get(id)) || this.empty;
  has = (id: string) => this.runtimes.has(id);
  getActivities = () => this.activities;
  getSidebarActivities = () => this.sidebarActivities;
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
    if (this.runtimes.get(id)?.dialogs !== runtime.dialogs) retainAskDrafts(id, runtime.dialogs);
    this.runtimes.set(id, runtime);
    for (const listener of this.listeners.get(id) ?? []) listener();
    const before = this.activities[id];
    const statusChanged = before?.status !== runtime.status || before.pending !== runtime.dialogs.length;
    if (statusChanged)
      this.sidebarActivities = {
        ...this.sidebarActivities,
        [id]: { status: runtime.status, pending: runtime.dialogs.length },
      };
    const waitingFor = runtime.dialogs.some((dialog) => dialog.approval)
      ? ('审批' as const)
      : runtime.dialogs.some((dialog) => dialog.ask)
        ? ('提问' as const)
        : runtime.dialogs.length
          ? ('扩展回复' as const)
          : undefined;
    if (statusChanged || before?.waitingFor !== waitingFor) {
      this.activities = {
        ...this.activities,
        [id]: {
          status: runtime.status,
          pending: runtime.dialogs.length,
          ...(waitingFor ? { waitingFor } : {}),
        },
      };
      for (const listener of this.activityListeners) listener();
    }
  }
  patch(patch: RuntimePatch) {
    if (patch.sessionId) this.set(applyRuntimePatch(this.get(patch.sessionId), patch));
  }
  remove(id: string) {
    retainAskDrafts(id, []);
    this.runtimes.delete(id);
    const { [id]: _removed, ...activities } = this.activities;
    this.activities = activities;
    if (id in this.sidebarActivities) {
      const { [id]: _activity, ...remaining } = this.sidebarActivities;
      this.sidebarActivities = remaining;
    }
    for (const listener of this.listeners.get(id) ?? []) listener();
    for (const listener of this.activityListeners) listener();
  }
}
