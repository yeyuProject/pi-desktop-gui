import { useEffect, useRef, useState } from 'react';
import type { Runtime, Session, AppState } from '../../shared/types';
import { workbenchShortcuts, type WorkbenchAction } from '../../shared/workbench-actions';
import { mod } from '../lib/platform';
import { allowsWorkbenchAction, topLayer } from './useLayer';
type Toggle = React.Dispatch<React.SetStateAction<boolean>>;
interface ShortcutsOptions {
  state: AppState | undefined;
  selected: Session | undefined;
  runtime: Runtime;
  compact: boolean;
  inspector: boolean;
  ownRunning: boolean;
  createSession: () => Promise<void>;
  openSettings: (tab?: string) => void;
  action: (fn: () => Promise<unknown>) => Promise<void>;
  attempt: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  setSearchOpen: Toggle;
  setSidebar: Toggle;
  setShortcutsOpen: Toggle;
  setInspector: Toggle;
  selectTab: (tab: 'changes' | 'files' | 'output') => void;
}
function hasInputText(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return target.value.length > 0;
  if (target instanceof HTMLInputElement)
    return (
      ![
        'button',
        'checkbox',
        'color',
        'file',
        'hidden',
        'image',
        'radio',
        'range',
        'reset',
        'submit',
      ].includes(target.type) && target.value.length > 0
    );
  const editor = target instanceof HTMLElement ? target.closest<HTMLElement>('[contenteditable]') : null;
  return Boolean(editor?.isContentEditable && editor.textContent);
}
export function useShortcuts(options: ShortcutsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [stopArmed, setStopArmed] = useState(false);
  const runAction = (action: WorkbenchAction) => {
    if (!allowsWorkbenchAction(action)) return;
    const o = latest.current;
    const actions: Record<WorkbenchAction, () => void> = {
      new: () => {
        void o.createSession();
      },
      search: () => o.setSearchOpen(true),
      find: () => {
        if (o.compact) o.setInspector(false);
        window.dispatchEvent(new CustomEvent('pi:find'));
      },
      previousTurn: () => window.dispatchEvent(new CustomEvent('pi:turn', { detail: -1 })),
      nextTurn: () => window.dispatchEvent(new CustomEvent('pi:turn', { detail: 1 })),
      sidebar: () => o.setSidebar((value) => !value),
      inspector: () => o.setInspector((value) => !value),
      changes: () => o.selectTab('changes'),
      files: () => o.selectTab('files'),
      output: () => o.selectTab('output'),
      settings: () => o.openSettings(),
      editDraft: () => {
        if (o.selected) void o.action(() => window.desktop.invoke('editDraft', o.selected!.id));
      },
      shortcuts: () => o.setShortcutsOpen((value) => !value),
    };
    actions[action]();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.shiftKey) return;
      const binding = workbenchShortcuts.find(
        (item) =>
          event.key.toLowerCase() === item.key &&
          ('mod' in item ? mod(event) && !event.altKey : event.altKey && !event.ctrlKey && !event.metaKey),
      );
      if (!binding) return;
      if (
        (binding.action === 'previousTurn' || binding.action === 'nextTurn') &&
        (hasInputText(event.target) || !allowsWorkbenchAction(binding.action))
      )
        return;
      event.preventDefault();
      if (!event.repeat) runAction(binding.action);
    };
    window.addEventListener('keydown', key);
    const customAction = (event: Event) => {
      const action = (event as CustomEvent).detail;
      if (workbenchShortcuts.some((binding) => binding.action === action)) runAction(action);
    };
    window.addEventListener('pi:action', customAction);
    const off = window.desktop.onEvent((event) => {
      if (event.type === 'action') runAction(event.action);
    });
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pi:action', customAction);
      off();
    };
  }, []);
  useEffect(() => {
    if (!stopArmed) return;
    const timer = setTimeout(() => setStopArmed(false), 2000);
    return () => clearTimeout(timer);
  }, [stopArmed]);
  useEffect(() => {
    if (!options.ownRunning) setStopArmed(false);
  }, [options.ownRunning]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const o = latest.current;
      if (
        !o.ownRunning ||
        o.runtime.status === 'stopping' ||
        event.key !== 'Escape' ||
        event.repeat ||
        event.defaultPrevented ||
        event.isComposing ||
        topLayer()
      )
        return;
      event.preventDefault();
      if (stopArmed) {
        setStopArmed(false);
        if (o.runtime.sessionId) void o.attempt(() => window.desktop.invoke('stop', o.runtime.sessionId!));
      } else setStopArmed(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [stopArmed]);
  return { stopArmed, runAction };
}
