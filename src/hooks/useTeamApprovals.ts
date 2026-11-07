import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ExtensionDialog, Runtime } from '../../shared/types';
import type { RuntimeStore } from '../lib/runtime-store';
import { teamMemberActive } from '../../shared/team';
export type SourcedApproval = ExtensionDialog & { sourceSessionId: string; sourceName?: string };
/** Subscribe only to dialog references, never member transcript arrays. */
export function useTeamApprovals(runtimes: RuntimeStore, runtime: Runtime): SourcedApproval[] {
  const idsKey = (runtime.team ?? [])
    .flatMap((s) => s.members.filter((m) => teamMemberActive(m.status)).map((m) => m.sessionId))
    .join('|');
  const ids = useMemo(() => (idsKey ? idsKey.split('|') : []), [idsKey]);
  const selector = useMemo(() => {
    let before: ExtensionDialog[][] = [];
    let snapshot: SourcedApproval[] = [];
    return () => {
      const dialogs = ids.map((id) => runtimes.get(id).dialogs);
      if (dialogs.length !== before.length || dialogs.some((d, i) => d !== before[i])) {
        before = dialogs;
        snapshot = dialogs.flatMap((items, index) =>
          items
            .filter((d) => d.approval)
            .map((d) => ({
              ...d,
              sourceSessionId: ids[index],
              sourceName: runtime.team?.flatMap((s) => s.members).find((m) => m.sessionId === ids[index])
                ?.name,
            })),
        );
      }
      return snapshot;
    };
  }, [runtimes, ids, runtime.team]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const off = ids.map((id) => runtimes.subscribe(id, listener));
      return () => off.forEach((unsubscribe) => unsubscribe());
    },
    [runtimes, ids],
  );
  const members = useSyncExternalStore(subscribe, selector);
  return useMemo(
    () =>
      [
        ...runtime.dialogs
          .filter((d) => d.approval)
          .map((d) => ({ ...d, sourceSessionId: runtime.sessionId! })),
        ...members,
      ].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    [runtime.dialogs, runtime.sessionId, members],
  );
}
