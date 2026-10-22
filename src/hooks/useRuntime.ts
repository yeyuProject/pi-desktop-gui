import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { type AppState, type Environment, type Settings, type StorageStatus } from '../../shared/types';
import { readableError } from '../lib/format';
import type { UpdateState } from '../../shared/app-update';
import { RuntimeStore } from '../lib/runtime-store';
const api = window.desktop;
export function useRuntime(
  setError: (value: string) => void,
  setPrefs: Dispatch<SetStateAction<Settings | undefined>>,
) {
  const [snapshot, setSnapshot] = useState<{ state: AppState; revision: number }>(),
    [environment, setEnvironment] = useState<Environment>(),
    [update, setUpdate] = useState<UpdateState>(),
    [storage, setStorage] = useState<StorageStatus>({ writable: false });
  const [runtimes] = useState(() => new RuntimeStore());
  const sessionId = snapshot?.state.selectedSessionId;
  const runtime = useSyncExternalStore(
    useCallback((listener) => runtimes.subscribe(sessionId, listener), [runtimes, sessionId]),
    () => runtimes.get(sessionId),
  );
  const activities = useSyncExternalStore(runtimes.subscribeActivities, runtimes.getActivities);
  const receivedState = useRef<{ state?: AppState; revision: number }>({ revision: 0 });
  const receiveState = (state: AppState, revision: number) => {
    if (!Number.isSafeInteger(revision) || revision <= receivedState.current.revision) return;
    const next = { state, revision };
    receivedState.current = next;
    setSnapshot(next);
  };
  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onEvent((event) => {
      if (!alive) return;
      if (event.type === 'state') receiveState(event.state, event.revision);
      else if (event.type === 'storage') setStorage(event.storage);
      else if (event.type === 'update') setUpdate(event.update);
      else if (event.type === 'runtimeRemoved') {
        runtimes.remove(event.sessionId);
      } else if (event.type === 'runtimePatch' && event.patch.sessionId) {
        runtimes.patch(event.patch);
      } else if (event.type === 'runtime' && event.runtime.sessionId) {
        runtimes.set(event.runtime);
      }
    });
    api
      .invoke('bootstrap')
      .then((v) => {
        if (!alive) return;
        receiveState(v.state, v.revision);
        if (v.runtime.sessionId) {
          if (!runtimes.has(v.runtime.sessionId)) runtimes.set(v.runtime);
        }
        setEnvironment(v.environment);
        setPrefs((previous) => previous ?? receivedState.current.state?.settings ?? v.state.settings);
        setStorage(v.storage);
        setUpdate(v.update);
      })
      .catch((e) => setError(readableError(e)));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const state = snapshot?.state;
  const anyRunning = runtimes.anyRunning;
  return {
    state,
    stateRevision: snapshot?.revision ?? 0,
    receivedState,
    receiveState,
    runtime,
    activities,
    anyRunning,
    environment,
    setEnvironment,
    storage,
    update,
  };
}
