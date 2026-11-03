import { watch, type WatchEventType } from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/types';
import type { WorkspaceChangedEvent } from '../shared/workspace';

const ignored = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.gradle',
  '.idea',
  '.pytest_cache',
  '.mypy_cache',
]);
export function watchedPath(name: string) {
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts[0] === '.git') return parts[1] === 'HEAD' || parts[1] === 'index' || parts[1] === 'refs';
  return !parts.some((part) => ignored.has(part) || part === '.git');
}

type WatchHandle = {
  close(): void;
  on(event: 'error', listener: () => void): unknown;
};
type WatchFactory = (
  root: string,
  options: { recursive: true },
  listener: (event: WatchEventType, file: string | null) => void,
) => WatchHandle;

/** One native recursive watcher per selected project, with no Git processes while idle. */
export class WorkspaceWatcher {
  private watcher?: WatchHandle;
  private debounce?: ReturnType<typeof setTimeout>;
  private changed = new Set<string>();
  private unknown = false;
  private disposed = false;
  private firstChange = 0;
  private lastNotify = 0;

  private constructor(
    private project: Project,
    private notify: (event: WorkspaceChangedEvent) => void,
    private options: {
      changed?: (paths?: string[]) => void;
      running?: () => boolean;
      failed?: () => void;
    } = {},
  ) {}

  static async watch(
    project: Project,
    notify: (event: WorkspaceChangedEvent) => void,
    watchFactory: WatchFactory = watch,
    options: { changed?: (paths?: string[]) => void; running?: () => boolean; failed?: () => void } = {},
  ) {
    const instance = new WorkspaceWatcher(project, notify, options);
    try {
      instance.watcher = watchFactory(project.path, { recursive: true }, (_event, file) => {
        if (file && !watchedPath(String(file))) {
          instance.options.changed?.();
          return;
        }
        instance.changedPath(file ? String(file).split(path.sep).join('/') : undefined);
      });
      instance.watcher.on('error', () => instance.useFallback());
    } catch {
      instance.useFallback();
    }
    return instance;
  }

  private useFallback() {
    this.options.failed?.();
    this.options.changed?.();
    this.watcher?.close();
    this.watcher = undefined;
    // useWorkspace already owns the 60-second/focus fallback, including background suspension.
    // A second main-process timer would double the idle Git scans after a watcher failure.
  }

  private changedPath(file?: string) {
    if (this.disposed) return;
    this.options.changed?.(file && !file.startsWith('.git/') ? [file] : undefined);
    this.firstChange ||= Date.now();
    if (file) this.changed.add(file);
    else this.unknown = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(
      () => {
        this.lastNotify = Date.now();
        this.firstChange = 0;
        this.notify({
          type: 'workspaceChanged',
          projectId: this.project.id,
          changedPaths: this.unknown ? undefined : [...this.changed],
        });
        this.changed.clear();
        this.unknown = false;
        this.debounce = undefined;
      },
      Math.max(
        this.options.running?.() ? Math.max(0, this.lastNotify + 2000 - Date.now()) : 0,
        Math.min(300, Math.max(0, this.firstChange + 2000 - Date.now())),
      ),
    );
  }

  dispose() {
    this.disposed = true;
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    this.changed.clear();
  }
}
