import { isGoalStartMessage } from '../../shared/goal-input';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Message, Runtime, Session } from '../../shared/types';
import { hideRecoveredErrors } from '../lib/conversation-layout';
import { readableError } from '../lib/format';
const empty: Message[] = [];

export function useHistory(
  selected: Session | undefined,
  runtime: Runtime,
  thread: RefObject<HTMLDivElement | null>,
  autoScroll: RefObject<boolean>,
  setNewContent: (value: boolean) => void,
  setError: (value: string, id: string) => void,
) {
  const [history, setHistory] = useState<{ sessionId: string; messages: Message[]; ready: boolean }>();
  const restore = useRef<{ id: string; top?: number } | undefined>(undefined);
  const report = useRef(setError);
  const restoredSession = useRef<string | undefined>(undefined);
  report.current = setError;
  const hasLiveHistory = runtime.sessionId === selected?.id && runtime.messages.length > 0;
  useEffect(() => {
    if (!selected) return;
    let active = true;
    if (restoredSession.current !== selected.id) {
      restoredSession.current = selected.id;
      restore.current = { id: selected.id, top: selected.scrollTop };
      autoScroll.current = selected.scrollTop === undefined;
    }
    setHistory({ sessionId: selected.id, messages: [], ready: false });
    // The live runtime already owns a complete transcript. Reading it over IPC
    // again would retain a second copy of every message (including images).
    if (hasLiveHistory) {
      setHistory({ sessionId: selected.id, messages: [], ready: true });
      return;
    }
    void window.desktop
      .invoke('readHistory', selected.id)
      .then((messages) => {
        if (active) setHistory({ sessionId: selected.id, messages, ready: true });
      })
      .catch((error) => {
        if (active) report.current(readableError(error), selected.id);
      });
    return () => {
      active = false;
    };
  }, [selected?.id, hasLiveHistory]);
  const own = runtime.sessionId === selected?.id;
  const messages = useMemo(
    () =>
      hideRecoveredErrors(
        (own && (runtime.connected || runtime.messages.length)
          ? runtime.messages
          : history && history.sessionId === selected?.id
            ? history.messages
            : empty
        )
          .map((message, index, all) =>
            isGoalStartMessage(all, index) ? { ...message, goalStart: true } : message,
          )
          .filter((message) => message.role !== 'custom' || message.display !== false),
      ),
    [own, runtime.connected, runtime.messages, history, selected?.id],
  );
  useLayoutEffect(() => {
    const element = thread.current;
    if (!element) return;
    if (restore.current && restore.current.id === selected?.id) {
      if (
        !(own && runtime.messages.length) &&
        !(history && history.sessionId === selected?.id && history.ready)
      )
        return;
      element.scrollTop = restore.current.top ?? element.scrollHeight;
      restore.current = undefined;
      setNewContent(false);
      return;
    }
    if (autoScroll.current) {
      element.scrollTop = element.scrollHeight;
      setNewContent(false);
    } else setNewContent(true);
  }, [messages, runtime.tools, history?.ready]);
  return { history, messages };
}
