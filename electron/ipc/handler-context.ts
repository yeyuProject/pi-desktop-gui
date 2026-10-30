import type { AppEvent, ApiMap, StateSnapshot } from '../../shared/types';
import type { Store } from '../store';
import type { SessionAgents } from '../session-agents';
import type { Workspace } from '../workspace';
import type { DialogOptions } from '../app-dialogs';

export type HandlerMap<K extends keyof ApiMap> = Record<K, (...args: any[]) => any>;
export interface HandlerContext {
  store: Store;
  service: SessionAgents;
  workspace: Workspace;
  text: (value: unknown, max?: number) => asserts value is string;
  strings: (value: unknown) => asserts value is string[];
  save: () => Promise<void>;
  send: (
    event: Exclude<AppEvent, { type: 'state' }> | { type: 'state'; state: StateSnapshot['state'] },
  ) => void;
  showAppDialog: (options: DialogOptions) => Promise<{ response: number }>;
  developmentRoot?: string;
}
