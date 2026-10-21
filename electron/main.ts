import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  clipboard,
  ClipboardItem,
  nativeImage,
  nativeTheme,
  Menu,
  Notification,
  screen,
  net,
  powerMonitor,
  type Rectangle,
} from 'electron';
import { AppDialogRequests, type DialogOptions } from './app-dialogs';
import { windowTheme } from '../shared/window-theme';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, readSessionFile } from './store';
import { redact } from './agent';
import { SessionAgents } from './session-agents';
import {
  Workspace,
  listDirectory,
  allFiles,
  previewFile,
  safePath,
  sensitive,
  attachmentInfo,
} from './workspace';
import { WorkspaceWatcher } from './workspace-watch';
import { projectRules, createAgentRules } from './project-rules';
import { isEmptySession, hasSessionData, fillSessionUsage } from './session-maintenance';
import { aggregateUsage } from '../shared/usage';
import { composeDraftText } from '../shared/draft';
import { validatePromptTemplate } from '../shared/prompts';
import {
  readPromptTemplate,
  savePromptTemplate,
  deletePromptTemplate,
  describeResource,
  type PromptTemplateContext,
} from './prompts';
import type { ResourceCatalog } from '../shared/types';
import type { CheckpointContext } from '../shared/checkpoints';
import { detectEnvironment, requireSupportedPi, resolvePi, agentDirectory } from './environment';
import { Configuration } from './configuration';
import { toggleResourceSetting } from './resources-config';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import { UpdateService, updateInstallation, fetchLatestRelease, fetchReleaseNotes } from './updater';
import { createNativeUpdateDriver } from './update-driver';
import { UpdateAttemptFile } from './update-attempt';
import { readImageAttachment, validateImages } from './images';
import { listPiSessions, searchSessionContents } from './history';
import {
  isMac,
  loadLoginShellPath,
  openTerminal,
  openTextEditor,
  openWithApp,
  pathKey,
  samePath,
  terminalOpen,
} from './platform';
import {
  busy,
  messageText,
  type AppEvent,
  type ApiMap,
  type Runtime,
  type Session,
  type StateSnapshot,
} from '../shared/types';

let window: BrowserWindow | undefined, store: Store, service: SessionAgents, workspace: Workspace;
let updates: UpdateService;
let quitting = false;
let closing = false;
let sessionEnding = false;
let activeOperations = 0;
const operationWaiters = new Set<() => void>();
function finishOperation() {
  activeOperations--;
  if (activeOperations) return;
  for (const resolve of operationWaiters) resolve();
  operationWaiters.clear();
}
function waitForOperations() {
  return activeOperations ? new Promise<void>((resolve) => operationWaiters.add(resolve)) : Promise.resolve();
}
let workspaceWatcher: WorkspaceWatcher | undefined;
let watchedProject = '';
let watcherRevision = 0;
let appQuitRequested = false;
if (process.env.PI_DESKTOP_DATA_DIR) app.setPath('userData', path.resolve(process.env.PI_DESKTOP_DATA_DIR));
const developmentRoot = app.isPackaged ? undefined : app.getAppPath();
const appUserModelId = app.isPackaged ? 'io.yeyuproject.pi-desktop' : 'io.yeyuproject.pi-desktop.dev';
let stateRevision = 0;
// Broadcasts, bootstrap and completion reads share one non-persistent sequence.
const stateSnapshot = (state = store.state): StateSnapshot => ({
  state: structuredClone(store.visibleState(state)),
  revision: ++stateRevision,
});
const send = (
  event: Exclude<AppEvent, { type: 'state' }> | { type: 'state'; state: StateSnapshot['state'] },
) => {
  const value: AppEvent = event.type === 'state' ? { type: 'state', ...stateSnapshot(event.state) } : event;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send('desktop:event', value);
  if (event.type === 'state') void watchSelectedProject();
};
let appDialogsReady = false;
let rendererResponsive = true;
const appDialogs = new AppDialogRequests((value) => send({ type: 'appDialog', dialog: value }));
function cancelAppDialogs() {
  appDialogs.cancelAll();
  send({ type: 'appDialogsCancelled' });
}
function showAppDialog(options: DialogOptions, allowNativeFallback = false) {
  // Already accepted operations may reach their business confirmation while quit
  // drains them. Cancel that work rather than opening a dialog IPC cannot answer.
  if (quitting && !allowNativeFallback) return Promise.resolve({ response: options.cancelId ?? 0 });
  const unavailable = !appDialogsReady || !rendererResponsive;
  if (!window || window.isDestroyed() || (unavailable && !allowNativeFallback))
    return Promise.resolve({ response: options.cancelId ?? 0 });
  // Quit from the dock/menu must not leave confirmation in a hidden/minimized window.
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  // A crashed/hung renderer must not trap a running Pi process in an unquittable app.
  // Only the close flow opts in; ordinary business operations fail closed.
  return unavailable ? dialog.showMessageBox(window, options) : appDialogs.show(options);
}
async function confirmUnsavedQuit(error: unknown, copyOnly = false) {
  // A renderer-backed dialog must still be able to reply while close is paused.
  quitting = false;
  const result = await showAppDialog(
    {
      type: 'warning',
      message: copyOnly ? '退出准备时保存失败，仍然退出？' : '本地内容尚未保存，仍然退出？',
      detail:
        (copyOnly
          ? '会话服务已关闭，窗口仅保留用于复制尚未保存的内容。请先复制需要保留的草稿。\n\n'
          : '未保存的草稿和设置仍保留在窗口中。建议留在窗口，先复制需要保留的内容。\n\n') +
        String(error instanceof Error ? error.message : error),
      buttons: [copyOnly ? '保留窗口以复制内容' : '留在窗口', '仍然退出，丢弃未保存内容'],
      defaultId: 0,
      cancelId: 0,
    },
    true,
  );
  if (result.response !== 1) return false;
  quitting = true;
  return true;
}
function updateWindowTheme() {
  if (!window || window.isDestroyed()) return;
  const { background, ...overlay } = windowTheme(nativeTheme.shouldUseDarkColors);
  window.setBackgroundColor(background);
  if (!isMac) window.setTitleBarOverlay(overlay);
}
async function watchSelectedProject() {
  if (!store || quitting) return;
  const selected = store.state.sessions.find((session) => session.id === store.state.selectedSessionId);
  const project = store.state.projects.find((item) => item.id === selected?.projectId);
  const key = project ? project.id + ':' + pathKey(project.path) : '';
  if (key === watchedProject) return;
  watchedProject = key;
  const revision = ++watcherRevision;
  workspaceWatcher?.dispose();
  workspaceWatcher = undefined;
  if (!project) return;
  const watcher = await WorkspaceWatcher.watch(project, (event) => {
    if (!quitting && revision === watcherRevision) send(event);
  });
  if (quitting || revision !== watcherRevision) watcher.dispose();
  else workspaceWatcher = watcher;
}
const save = async () => {
  await store.save();
  send({ type: 'state', state: store.state });
};
const attention = new Map<string, { status: string; dialogs: number }>();
let lastToast: Notification | undefined;
function notifyAttention(runtime: Runtime) {
  if (!runtime.sessionId) return;
  const previous = attention.get(runtime.sessionId);
  attention.set(runtime.sessionId, { status: runtime.status, dialogs: runtime.dialogs.length });
  if (!window || window.isDestroyed() || window.isFocused()) return;
  if (!previous) return;
  if (!store.state.settings.notifyOnFinish || !Notification.isSupported()) return;
  const session = store.state.sessions.find((s) => s.id === runtime.sessionId);
  if (!session) return;
  const finished = busy(previous.status) && !busy(runtime.status);
  let title = '',
    body = '';
  if (runtime.dialogs.length > previous.dialogs) {
    title = 'Pi 需要你的回复';
    body = runtime.dialogs.at(-1)?.title || session.title;
  } else if (finished && runtime.status === 'completed') {
    title = '任务已完成 · ' + session.title;
    const last = runtime.messages.findLast((m) => m.role === 'assistant');
    body = (last ? messageText(last) : '').replace(/\s+/g, ' ').trim().slice(0, 120) || '点击查看结果';
  } else if (finished && (runtime.status === 'error' || runtime.status === 'interrupted')) {
    title = '任务未完成 · ' + session.title;
    body = redact(runtime.error || '执行失败，点击查看详情').slice(0, 160);
  } else return;
  const toast = new Notification({ title, body });
  toast.on('click', () => {
    if (closing || quitting || updates.state.installing) return;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (store.state.sessions.some((s) => s.id === session.id)) {
      store.selectSession(session.id);
      void save();
    }
  });
  toast.show();
  lastToast = toast;
  window.flashFrame(true);
}
const windowFile = () => path.join(store.dir, 'window.json');
async function loadWindowState(): Promise<{ bounds?: Rectangle; maximized: boolean }> {
  try {
    const value = JSON.parse(await fs.readFile(windowFile(), 'utf8'));
    const b = value?.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return { maximized: false };
    const area = screen.getDisplayMatching(b).workArea;
    const visible =
      b.x < area.x + area.width - 100 &&
      b.x + b.width > area.x + 100 &&
      b.y >= area.y - 8 &&
      b.y < area.y + area.height - 100;
    return {
      bounds: visible
        ? {
            x: b.x,
            y: b.y,
            width: Math.min(area.width, Math.max(1024, b.width)),
            height: Math.min(area.height, Math.max(700, b.height)),
          }
        : undefined,
      maximized: value.maximized === true,
    };
  } catch {
    return { maximized: false };
  }
}
let windowTimer: NodeJS.Timeout | undefined;
let windowWrite = Promise.resolve();
function writeWindowState() {
  if (!store.storage.writable) return windowWrite;
  if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return windowWrite;
  const contents = JSON.stringify({ bounds: window.getNormalBounds(), maximized: window.isMaximized() });
  // Keep the final close snapshot behind any in-flight resize save.
  windowWrite = windowWrite.then(() => fs.writeFile(windowFile(), contents, 'utf8')).catch(() => {});
  return windowWrite;
}
function rememberWindow() {
  if (quitting) return;
  clearTimeout(windowTimer);
  windowTimer = setTimeout(() => {
    windowTimer = undefined;
    void writeWindowState();
  }, 400);
}
function text(value: unknown, max = 1024 * 1024): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error('输入格式无效');
}
function strings(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    !value.every((v) => typeof v === 'string' && v.length < 4096 && !v.includes('\0'))
  )
    throw new Error('列表格式无效');
}
// The workspace/terminal checks below await I/O before the handler is reached. Record
// an accepted session intent first, so another New click cannot reuse its stable ID.
function protectSessionOperation(method: string, args: unknown[]) {
  const id = args[0];
  text(id, 100);
  if (method === 'send') {
    text(args[1]);
    strings(args[2]);
    if (args[3] !== 'steer' && args[3] !== 'followUp') throw new Error('发送模式无效');
    validateImages(args[4] ?? []);
    if (!args[1].trim() && !(args[4] as unknown[] | undefined)?.length)
      throw new Error('请输入任务内容或添加图片');
  } else if (method === 'recover') {
    if (args[1] !== undefined) text(args[1]);
  } else if (method === 'compact') text(args[1]);
  else if (method === 'login' || method === 'logout') {
    text(args[1], 200);
    if (method === 'login' && !['oauth', 'api_key'].includes(args[2] as string))
      throw new Error('登录方式无效');
  } else if (method === 'branchSession') {
    text(args[2], 100);
    if (args[4] !== undefined) text(args[4]);
  } else if (method === 'messageAction') {
    if (!['user', 'assistant'].includes(args[2] as string) || !Number.isFinite(args[3]))
      throw new Error('消息无效');
  }
  const transient = store.isTransientSession(id);
  store.promoteSession(id);
  if (transient) return save();
}
async function newSession(projectId?: string) {
  const s = store.createPlaceholder(projectId, (id) => service.connected(id));
  await save();
  return s;
}
async function newSessionFromMenu() {
  if (appDialogs.size || closing || quitting || updates.state.installing) return;
  try {
    store.assertWritable();
    activeOperations++;
    try {
      await newSession();
    } finally {
      finishOperation();
    }
  } catch (error) {
    await showAppDialog({ message: '无法新建对话', detail: String(error) });
  }
}
function sessionRoots() {
  return [path.join(agentDirectory(store.state.settings), 'sessions'), path.join(store.dir, 'sessions')];
}
async function adoptSessionFile(file: string, projectId?: string) {
  const existing = store.state.sessions.find((s) => s.file && samePath(s.file, file));
  if (existing) {
    store.selectSession(existing.id);
    await save();
    return existing;
  }
  const data = await readSessionFile(file);
  const cwd = await fs.realpath(data.cwd).catch(() => data.cwd);
  const p = projectId ? store.project(projectId) : store.state.projects.find((p) => samePath(p.path, cwd));
  if (projectId && !samePath(cwd, p!.path)) throw new Error('会话工作目录与当前项目不一致，请先添加对应项目');
  const s = store.createSession(p?.id);
  if (!p) s.cwd = cwd;
  s.file = file;
  s.title =
    data.name ||
    messageText(data.messages.find((m) => m.role === 'user') ?? { content: '' })
      .trim()
      .split('\n')[0]
      .slice(0, 28) ||
    path.basename(file, '.jsonl');
  await save();
  return s;
}
async function chooseFile(title: string, filters?: Electron.FileFilter[]) {
  const result = await dialog.showOpenDialog(window!, { title, properties: ['openFile'], filters });
  return result.canceled ? null : result.filePaths[0];
}
let diagnosticPreview = '';
const exec = promisify(execFile);
let configurationWrites = Promise.resolve();
let updatingConfiguration = false;
function checkpointContext(projectId: string, value: unknown): CheckpointContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('检查点范围无效');
  const context = value as CheckpointContext;
  text(context.sessionId, 100);
  if (context.checkpointId !== undefined) text(context.checkpointId, 100);
  if (store.session(context.sessionId).projectId !== projectId) throw new Error('该检查点不属于当前项目');
  return { sessionId: context.sessionId, checkpointId: context.checkpointId };
}
const sessionResourcePaths = new Map<string, string[]>();
async function promptContext(id: string): Promise<PromptTemplateContext> {
  const session = store.session(id);
  const catalog = (await service.get(id).admin(id, 'resources')) as ResourceCatalog;
  sessionResourcePaths.set(
    id,
    catalog.resources.map((item) => item.path),
  );
  return {
    agentDir: agentDirectory(store.state.settings),
    cwd: session.projectId ? store.project(session.projectId).path : undefined,
    resources: catalog.resources,
  };
}
const terminalLock = (id: string) => path.join(store.dir, 'terminal-' + encodeURIComponent(id) + '.lock');
async function assertTerminalClosed(id: string) {
  if (await terminalOpen(terminalLock(id)))
    throw new Error('当前会话已交给 Pi 终端，请关闭该终端后再使用桌面会话');
}
async function inSessionWorkspace<T>(id: string, action: () => Promise<T>) {
  await assertTerminalClosed(id);
  return service.inWorkspace(await store.sessionDirectory(id), false, async () => {
    await service.assertResourcesAvailable(id);
    return action();
  });
}
async function assertWorkspaceTerminalsClosed(root: string) {
  const real = await canonicalWritePath(root);
  for (const session of store.state.sessions) {
    if (!(await terminalOpen(terminalLock(session.id)))) continue;
    const cwd = await canonicalWritePath(await store.sessionDirectory(session.id));
    if (isWithinDirectory(real, cwd) || isWithinDirectory(cwd, real))
      throw new Error(`会话“${session.title}”的 Pi 终端仍在使用这个目录，请关闭相关终端后执行`);
  }
}
async function exportSession(id: string, format: 'html' | 'jsonl') {
  if (!['html', 'jsonl'].includes(format)) throw new Error('导出格式无效');
  const agent = service.get(id);
  // Capture before the save dialog, while other sessions and this task may keep producing output.
  const temporary = path.join(store.dir, 'export-' + randomUUID() + '.' + format);
  let snapshot: Buffer;
  const original = store.session(id).file;
  try {
    snapshot = await agent.captureExport(id, format, temporary);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const chosen = await dialog.showSaveDialog(window!, {
    title: '导出完整会话',
    defaultPath: 'pi-session.' + format,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (chosen.canceled || !chosen.filePath) return null;
  if (original && samePath(original, chosen.filePath)) throw new Error('请选择不同于原会话文件的导出位置');
  await fs.writeFile(chosen.filePath, snapshot);
  return chosen.filePath;
}
async function diagnostics() {
  const environment = await detectEnvironment(store.state.settings, developmentRoot);
  const agent = store.state.selectedSessionId ? service.get(store.state.selectedSessionId) : undefined;
  diagnosticPreview = redact(
    JSON.stringify(
      {
        appVersion: app.getVersion(),
        update: {
          state: updates.state.state,
          installation: updates.state.installation,
          version: updates.state.version,
          lastInstall: updates.state.lastInstall,
        },
        platform: process.platform,
        environment,
        piCompatibility: environment.compatibility,
        sessionSwitch: agent?.lastSwitch,
        modelErrors: agent?.recentModelErrors,
        sessions: service.diagnostics(),
        runtime: {
          status: service.runtime.status,
          connected: service.runtime.connected,
          error: service.runtime.error,
          diagnostic: service.runtime.diagnostic,
          crash: service.runtime.crash,
        },
      },
      null,
      2,
    ),
  );
  return diagnosticPreview;
}
async function saveText(title: string, contents: string, defaultName: string) {
  const picked = await dialog.showSaveDialog(window!, {
    title,
    defaultPath: defaultName,
    filters: [{ name: '文本', extensions: ['txt'] }],
  });
  if (picked.canceled || !picked.filePath) return null;
  await fs.writeFile(picked.filePath, contents, 'utf8');
  return picked.filePath;
}
const handlers: Record<keyof ApiMap, (...args: any[]) => any> = {
  appDialogsReady: () => {
    appDialogsReady = true;
    rendererResponsive = true;
  },
  respondAppDialog: (id, response) => {
    text(id, 100);
    appDialogs.respond(id, response);
  },
  showAppMenu: (id, x, y) => {
    if (isMac || !['file', 'edit', 'view'].includes(id)) throw new Error('无效菜单');
    if (![x, y].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('无效菜单位置');
    if (!window || window.isDestroyed() || appDialogs.size || closing) return;
    const menu = Menu.getApplicationMenu()?.getMenuItemById(id)?.submenu;
    if (!menu) return;
    const zoom = window.webContents.getZoomFactor();
    const [width, height] = window.getContentSize();
    return new Promise<void>((resolve) =>
      menu.popup({
        window,
        x: Math.round(Math.min(width, x * zoom)),
        y: Math.round(Math.min(height, y * zoom)),
        callback: resolve,
      }),
    );
  },
  bootstrap: async () => {
    const environment = await detectEnvironment(store.state.settings, developmentRoot);
    service.resync();
    return {
      ...stateSnapshot(),
      runtime: service.runtime,
      environment,
      dataDir: store.dir,
      storage: store.storage,
      update: updates.state,
    };
  },
  navigationState: () => stateSnapshot(),
  checkUpdate: () => updates.check(),
  downloadUpdate: () => updates.download(),
  installUpdate: () => updates.install(),
  addProject: async () => {
    const chosen = await dialog.showOpenDialog(window!, {
      title: '添加本地项目',
      properties: ['openDirectory'],
    });
    if (chosen.canceled) return null;
    const folder = await fs.realpath(chosen.filePaths[0]);
    const existing = store.state.projects.find((p) => samePath(p.path, folder));
    if (existing) {
      const session =
        store.durableSessions().find((s) => s.projectId === existing.id) ??
        store.createPlaceholder(existing.id, (id) => service.connected(id));
      store.selectSession(session.id);
      await save();
      return existing;
    }
    const p = {
      id: randomUUID(),
      name: path.basename(folder),
      path: folder,
      trusted: false,
      createdAt: Date.now(),
    };
    store.state.projects.push(p);
    await newSession(p.id);
    return p;
  },
  renameProject: async (id, name) => {
    text(id, 100);
    text(name, 120);
    if (!name.trim()) return;
    store.project(id).name = name.trim();
    await save();
  },
  removeProject: async (id) => {
    text(id, 100);
    if (service.projectBusy(id)) throw new Error('请先停止该项目的任务');
    const p = store.project(id);
    await assertWorkspaceTerminalsClosed(p.path);
    const result = await showAppDialog({
      type: 'question',
      message: `从列表移除 ${p.name}？`,
      detail: '磁盘项目和 Pi 会话文件将保留。',
      buttons: ['取消', '移除入口'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return;
    if (service.projectBusy(id)) throw new Error('请先停止该项目的任务');
    await assertWorkspaceTerminalsClosed(p.path);
    await Promise.all(
      store.state.sessions.filter((s) => s.projectId === id).map((s) => service.release(s.id)),
    );
    store.state.projects = store.state.projects.filter((p) => p.id !== id);
    store.removeSessions(store.state.sessions.filter((s) => s.projectId === id).map((s) => s.id));
    if (store.state.selectedProjectId === id) {
      const next = store.durableSessions()[0] ?? store.createPlaceholder();
      store.selectSession(next.id);
    }
    await save();
  },
  trustProject: async (id) => {
    text(id, 100);
    const p = store.project(id);
    if (p.trusted) return;
    const result = await showAppDialog({
      type: 'question',
      message: `启用项目 ${p.name}`,
      detail: `Pi 将使用当前用户权限读取、修改文件、执行命令，并加载项目配置、Skills 和扩展。项目扩展可以直接执行代码，请只启用可信项目。\n\n${p.path}`,
      buttons: ['取消', '信任并启用'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) {
      p.trusted = true;
      await save();
    }
  },
  newSession: async (id) => {
    if (id !== undefined) text(id, 100);
    return newSession(id);
  },
  importSession: async (projectId) => {
    if (projectId !== undefined) text(projectId, 100);
    const p = projectId ? store.project(projectId) : undefined;
    const file = await chooseFile('导入 Pi 会话', [{ name: 'Pi 会话', extensions: ['jsonl'] }]);
    if (!file) return null;
    return adoptSessionFile(file, p?.id);
  },
  selectSession: async (id) => {
    text(id, 100);
    const s = store.session(id);
    const agent = service.get(id);
    store.selectSession(s.id);
    if (store.storage.writable) {
      // Browsing only selects and reads history. Sending or an explicit connection
      // starts Pi; existing background tasks keep their own process and runtime.
      const saving = store.save();
      try {
        send({ type: 'state', state: store.state });
      } finally {
        await saving;
      }
    } else send({ type: 'state', state: store.state });
    return agent.history(id);
  },
  renameSession: async (id, name) => {
    text(id, 100);
    text(name, 120);
    if (!name.trim()) return;
    store.promoteSession(id).title = name.trim();
    await save();
    await service.get(id).rename(id, name.trim());
  },
  deleteSession: async (id) => {
    text(id, 100);
    await assertTerminalClosed(id);
    const s = store.session(id);
    if (service.active(id)) throw new Error('请先停止这个会话的任务');
    const result = await showAppDialog({
      type: 'warning',
      message: `删除会话“${s.title}”？`,
      detail: s.file ? 'Pi 会话文件会移到回收站，可从回收站恢复。' : '这个会话还没有内容，将直接移除。',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return false;
    if (!store.state.sessions.includes(s)) return false;
    const removedFile = Boolean(s.file);
    if (service.active(id)) throw new Error('请先停止这个会话的任务');
    await service.release(id);
    await assertTerminalClosed(id);
    if (s.file) {
      const exists = await fs.lstat(s.file).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists) await shell.trashItem(s.file);
    }
    store.removeSessions([id]);
    if (store.state.selectedSessionId === id) {
      const next =
        store.durableSessions().find((x) => x.projectId === s.projectId) ??
        store.durableSessions().find((x) => !x.projectId) ??
        store.createPlaceholder(s.projectId);
      store.selectSession(next.id);
    }
    await save();
    return { trashed: removedFile };
  },
  pinSession: async (id, pinned) => {
    text(id, 100);
    store.promoteSession(id).pinned = pinned === true;
    await save();
  },
  cleanupEmptySessions: async () => {
    const candidates = (
      await Promise.all(
        store
          .durableSessions()
          .map(async (session) =>
            (await isEmptySession(
              session,
              service.connected(session.id) || (await service.inTerminal(session.id))
                ? session.id
                : undefined,
            ))
              ? session.id
              : undefined,
          ),
      )
    ).filter((id): id is string => !!id);
    if (!candidates.length) return 0;
    const result = await showAppDialog({
      type: 'question',
      message: `清理 ${candidates.length} 个空会话？`,
      detail:
        '只移除未置顶、没有消息或未发送内容的会话入口。草稿、附件、图片、自定义名称、模型与审批设置和已连接会话会保留；磁盘文件不会删除。',
      buttons: ['取消', '清理空会话'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return 0;
    const removable = new Set<string>();
    for (const id of candidates) {
      const session = store.state.sessions.find((item) => item.id === id);
      if (
        session &&
        (await isEmptySession(
          session,
          service.connected(id) || (await service.inTerminal(id)) ? id : undefined,
        ))
      )
        removable.add(id);
    }
    await Promise.all([...removable].map((id) => service.release(id)));
    // Draft saves can arrive while the file checks above await I/O; inspect current fields once more.
    const before = store.state.sessions.length;
    store.removeSessions(
      store.state.sessions
        .filter(
          (session) =>
            removable.has(session.id) && !service.connected(session.id) && !hasSessionData(session),
        )
        .map((session) => session.id),
    );
    const removed = before - store.state.sessions.length;
    if (!store.state.sessions.some((session) => session.id === store.state.selectedSessionId)) {
      const next = store.durableSessions()[0] ?? store.createPlaceholder(store.state.selectedProjectId);
      store.selectSession(next.id);
    }
    await save();
    return removed;
  },
  searchSessions: async (query) => {
    text(query, 200);
    return searchSessionContents(store.durableSessions(), query);
  },
  piSessions: async () => {
    const known = new Set(store.state.sessions.filter((s) => s.file).map((s) => pathKey(s.file!)));
    return listPiSessions(sessionRoots(), known);
  },
  openPiSession: async (file) => {
    text(file, 4096);
    const resolved = path.resolve(file);
    const inside = sessionRoots().some((root) => {
      const relative = path.relative(root, resolved);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!inside || !resolved.endsWith('.jsonl')) throw new Error('只能打开 Pi 会话目录中的会话');
    return adoptSessionFile(resolved);
  },
  setSessionModel: async (id, provider, modelId) => {
    text(id, 100);
    text(provider, 200);
    text(modelId, 400);
    await service.get(id).setModel(id, provider, modelId);
  },
  setSessionThinking: async (id, level) => {
    text(id, 100);
    text(level, 40);
    await service.setThinking(id, level);
  },
  messageAction: async (id, action, role, timestamp) => {
    text(id, 100);
    if (!['edit', 'regenerate', 'fork'].includes(action)) throw new Error('消息操作无效');
    if (!['user', 'assistant'].includes(role) || !Number.isFinite(timestamp)) throw new Error('消息无效');
    await service.get(id).messageAction(id, action, role, timestamp);
  },
  abortRetry: (id) => {
    text(id, 100);
    return service.get(id).abortRetry();
  },
  setApprovalMode: async (id, mode) => {
    text(id, 100);
    if (mode !== 'auto' && mode !== 'confirm' && mode !== 'readonly') throw new Error('审批模式无效');
    await service.get(id).setApprovalMode(id, mode);
  },
  revokeApproval: async (id, grantId) => {
    text(id, 100);
    if (grantId !== undefined) text(grantId);
    await service.get(id).revokeApproval(id, grantId);
  },
  checkpoints: async (id) => {
    text(id, 100);
    const session = store.session(id);
    return session.projectId ? workspace.listCheckpoints(store.project(session.projectId), id) : [];
  },
  checkpointPreview: async (id, checkpointId) => {
    text(id, 100);
    text(checkpointId, 100);
    const session = store.session(id);
    if (!session.projectId) throw new Error('独立对话没有项目检查点');
    return workspace.checkpointPreview(store.project(session.projectId), id, checkpointId);
  },
  revertCheckpoint: async (id, checkpointId, files, revision) => {
    text(id, 100);
    text(checkpointId, 100);
    strings(files);
    text(revision, 200);
    if (!files.length || !revision) throw new Error('请重新查看检查点并选择要撤销的文件');
    const session = store.session(id);
    if (!session.projectId) throw new Error('独立对话没有项目检查点');
    const result = await workspace.revert(
      store.project(session.projectId),
      files,
      (file) => shell.trashItem(file),
      { sessionId: id, checkpointId, revision },
    );
    send({ type: 'workspaceChanged', projectId: session.projectId, changedPaths: result });
    return result;
  },
  setEntryLabel: async (id, entryId, label) => {
    text(id, 100);
    text(entryId, 100);
    text(label, 200);
    await service.get(id).admin(id, 'set_label', { entryId, label });
  },
  revertChanges: async (projectId, only, rawContext) => {
    text(projectId, 100);
    if (only !== null) strings(only);
    const project = store.project(projectId);
    const context = checkpointContext(projectId, rawContext);
    if (service.projectBusy(projectId)) throw new Error('请等待当前任务结束后再撤销');
    const pending = (await workspace.changes(project, 'run', context)).files.filter(
      (f) => !only || only.includes(f.path),
    );
    if (!pending.length) return [];
    const created = pending.filter((f) => f.status === '新增').length;
    const result = await showAppDialog({
      type: 'warning',
      message:
        only?.length === 1 ? `撤销对 ${only[0]} 的修改？` : `撤销本轮 ${pending.length} 个文件的修改？`,
      detail:
        '文件会恢复为本轮任务开始前的内容。' +
        (created ? `本轮新建的 ${created} 个文件会移到回收站。` : '') +
        (pending.some((f) => f.existedBeforeRun) ? '\n任务开始前就已有的未提交修改会保留。' : ''),
      buttons: ['取消', '撤销修改'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return [];
    if (service.projectBusy(projectId)) throw new Error('任务正在执行，请停止后再撤销');
    return workspace.revert(project, only, (file) => shell.trashItem(file), context);
  },
  saveDraft: async (id, draft, attachments, images, snippets) => {
    text(id, 100);
    text(draft);
    strings(attachments);
    if (snippets !== undefined) {
      if (!Array.isArray(snippets) || snippets.length > 1000) throw new Error('粘贴片段格式无效');
      const ids = new Set<string>();
      for (const snippet of snippets) {
        text(snippet?.id, 100);
        text(snippet?.text);
        if (!snippet.id || ids.has(snippet.id)) throw new Error('粘贴片段标识重复，请展开后重新编辑');
        ids.add(snippet.id);
        if (!Number.isSafeInteger(snippet.offset) || snippet.offset < 0 || snippet.offset > draft.length)
          throw new Error('粘贴片段的位置无效，请展开后重新编辑');
      }
    }
    if (images !== undefined) validateImages(images);
    const s = store.session(id);
    if (draft || attachments.length || images?.length || snippets?.length) store.promoteSession(id);
    s.draft = draft;
    s.attachments = attachments;
    if (snippets !== undefined) s.draftSnippets = snippets;
    if (images !== undefined) s.images = images;
    await save();
  },
  consumeDraft: async (id, expected) => {
    text(id, 100);
    text(expected);
    const s = store.session(id);
    if (composeDraftText(s.draft, s.draftSnippets ?? []) === expected) {
      if (s.draft || s.attachments.length || s.images?.length || s.draftSnippets?.length)
        store.promoteSession(id);
      s.draft = '';
      s.attachments = [];
      s.images = [];
      s.draftSnippets = [];
      await save();
    }
  },
  saveView: async (id, scrollTop, expanded) => {
    text(id, 100);
    strings(expanded);
    if (!Number.isFinite(scrollTop)) return;
    const s = store.session(id);
    s.scrollTop = Math.max(0, scrollTop);
    s.expandedTools = expanded.slice(-1000);
    await store.save();
  },
  readHistory: async (id) => {
    text(id, 100);
    return service.get(id).history(id);
  },
  detect: () => detectEnvironment(store.state.settings, developmentRoot),
  choosePath: async (kind) => {
    if (kind === 'agent') {
      const p = await dialog.showOpenDialog(window!, {
        title: '选择 Pi 配置目录',
        properties: ['openDirectory'],
      });
      return p.canceled ? null : p.filePaths[0];
    }
    if (!['pi', 'node', 'editor'].includes(kind)) throw new Error('无效路径类型');
    return chooseFile(
      kind === 'pi'
        ? '选择 Pi 入口 cli.js 或可执行文件'
        : kind === 'node'
          ? '选择 node.exe'
          : '选择代码编辑器可执行文件',
    );
  },
  saveSettings: async (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
    const next = { ...store.state.settings };
    for (const key of [
      'piPath',
      'nodePath',
      'agentDir',
      'editorPath',
      'provider',
      'modelId',
      'thinking',
    ] as const)
      if (key in value) {
        text(value[key], 4096);
        next[key] = value[key];
      }
    if (value.theme !== undefined) {
      if (!['light', 'dark', 'system'].includes(value.theme)) throw new Error('主题无效');
      next.theme = value.theme;
    }
    for (const [key, min, max] of [
      ['fontScale', 1, 2],
      ['sidebarWidth', 180, 360],
      ['inspectorWidth', 300, 720],
      ['inspectorSplit', 15, 70],
    ] as const)
      if (value[key] !== undefined) {
        if (!Number.isFinite(value[key])) throw new Error('尺寸无效');
        next[key] = Math.max(min, Math.min(max, value[key]));
      }
    if (typeof value.onboardingDone === 'boolean') next.onboardingDone = value.onboardingDone;
    if (typeof value.notifyOnFinish === 'boolean') next.notifyOnFinish = value.notifyOnFinish;
    if (value.autoDownloadUpdates !== undefined) {
      if (typeof value.autoDownloadUpdates !== 'boolean') throw new Error('自动下载更新设置无效');
      next.autoDownloadUpdates = value.autoDownloadUpdates;
    }
    store.state.settings = next;
    await save();
    nativeTheme.themeSource = next.theme;
    updateWindowTheme();
    updates.configure(next.autoDownloadUpdates);
  },
  connect: async (id) => {
    text(id, 100);
    await service.get(id).connect(id);
  },
  readModels: async (id) => {
    text(id, 100);
    await service.get(id).readModels(id, (read) => inSessionWorkspace(id, read));
  },
  recover: async (id, prompt) => {
    text(id, 100);
    if (prompt !== undefined) text(prompt);
    await service.get(id).recover(id, prompt);
  },
  testConnection: async (id) => {
    text(id, 100);
    return service.get(id).testConnection(id);
  },
  send: async (id, prompt, attachments, mode, images = []) => {
    text(id, 100);
    text(prompt);
    strings(attachments);
    if (mode !== 'steer' && mode !== 'followUp') throw new Error('发送模式无效');
    validateImages(images);
    await service.get(id).send(id, prompt, attachments, mode, images);
  },
  pickImages: async () => {
    const picked = await dialog.showOpenDialog(window!, {
      title: '添加图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (picked.canceled) return [];
    if (picked.filePaths.length > 8) throw new Error('最多选择 8 张图片');
    const images = await Promise.all(
      picked.filePaths.map(async (file) => {
        const image = await readImageAttachment(file);
        if (!image) throw new Error('支持 PNG、JPEG、WebP、GIF 图片');
        return image;
      }),
    );
    validateImages(images);
    return images;
  },
  projectImage: async (id, relative) => {
    text(id, 100);
    text(relative, 4096);
    if (sensitive(relative)) throw new Error('凭据文件不在文件预览和引用范围内');
    const project = store.project(id);
    const file = await safePath(project.path, relative);
    if (sensitive(path.relative(project.path, file))) throw new Error('凭据文件不在文件预览和引用范围内');
    return readImageAttachment(file);
  },
  sessionTree: async (id) => {
    text(id, 100);
    return service.get(id).tree(id);
  },
  branchSession: async (id, kind, entryId, summarize, instructions) => {
    text(id, 100);
    if (!['fork', 'clone', 'navigate'].includes(kind)) throw new Error('会话操作无效');
    if (kind !== 'clone') text(entryId, 100);
    if (instructions !== undefined) text(instructions);
    await service.get(id).branch(id, kind, entryId, summarize === true, instructions);
  },
  compact: async (id, instructions) => {
    text(id, 100);
    text(instructions);
    return service.get(id).compact(id, instructions);
  },
  piOption: async (id, key, value) => {
    text(id, 100);
    text(key, 100);
    await service.get(id).option(id, key, value);
  },
  exportSession,
  shareSession: async (id) => {
    text(id, 100);
    await service.get(id).connect(id);
    const out = path.join(store.dir, 'share-preview-' + randomUUID() + '.html');
    try {
      await fs.writeFile(out, await service.get(id).captureExport(id, 'html', out));
      const result = await showAppDialog({
        type: 'question',
        message: '分享完整会话到 GitHub Gist？',
        detail:
          '会上传全部对话、工具输出和附件内容。链接持有者均可访问。请先导出并检查内容；使用本机 gh 登录的账户。',
        buttons: ['取消', '上传并生成分享链接'],
        cancelId: 0,
        defaultId: 0,
      });
      if (result.response !== 1) return null;
      const { stdout } = await exec('gh', ['gist', 'create', out, '--desc', 'Pi Desktop session'], {
        windowsHide: true,
        timeout: 120000,
      });
      const url = stdout
        .trim()
        .split(/\r?\n/)
        .find((s) => /^https:\/\/gist\.github\.com\//.test(s));
      if (!url) throw new Error('Gist 未返回分享地址，请检查 gh 状态');
      clipboard.writeText(url);
      return url;
    } finally {
      await fs.rm(out, { force: true });
    }
  },
  reloadPi: async (id) => {
    text(id, 100);
    await service.get(id).scheduleReload();
  },
  resources: async (id) => {
    text(id, 100);
    const catalog = (await service.get(id).admin(id, 'resources')) as ResourceCatalog;
    sessionResourcePaths.set(
      id,
      catalog.resources.map((item) => item.path),
    );
    const session = store.session(id);
    const context: PromptTemplateContext = {
      agentDir: agentDirectory(store.state.settings),
      cwd: session.projectId ? store.project(session.projectId).path : undefined,
      resources: catalog.resources,
    };
    return {
      ...catalog,
      resources: await Promise.all(catalog.resources.map((resource) => describeResource(context, resource))),
    };
  },
  promptRead: async (id, file) => {
    text(id, 100);
    text(file, 4096);
    return readPromptTemplate(await promptContext(id), file);
  },
  promptSave: async (id, input, original) => {
    text(id, 100);
    validatePromptTemplate(input);
    if (original !== undefined) {
      text(original?.path, 4096);
      text(original?.revision, 100);
    }
    const document = await savePromptTemplate(await promptContext(id), input, original);
    await service.reloadConfiguration(id, input.scope === 'project');
    return document;
  },
  promptDelete: async (id, file, revision) => {
    text(id, 100);
    text(file, 4096);
    text(revision, 100);
    await deletePromptTemplate(await promptContext(id), file, revision);
    const local = !samePath(path.dirname(file), path.join(agentDirectory(store.state.settings), 'prompts'));
    await service.reloadConfiguration(id, local);
  },
  usageSummary: async () => {
    await fillSessionUsage(store);
    return aggregateUsage(store.durableSessions(), store.state.projects);
  },
  toggleResource: async (id, resource, enabled) => {
    text(id, 100);
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
    const catalog = await service.get(id).admin(id, 'resources');
    const found = catalog.resources.find((r: any) => r.path === resource?.path && r.kind === resource?.kind);
    if (!found) throw new Error('资源已变化，请刷新列表');
    const local = found.metadata.scope === 'project';
    const config = new Configuration(store);
    const document = await config.read(id, 'settings', local);
    const values = toggleResourceSetting(JSON.parse(document.text), found, enabled);
    await config.save(id, 'settings', local, { ...document, text: JSON.stringify(values) });
    await service.reloadConfiguration(id, local);
  },
  packageAction: async (id, action, source, local) => {
    text(id, 100);
    text(source, 4096);
    if (!['install', 'remove', 'update'].includes(action)) throw new Error('包操作无效');
    if (action !== 'update' && (!source.trim() || source.startsWith('-')))
      throw new Error('请输入有效包来源');
    if (source.startsWith('-')) throw new Error('包来源不能是命令参数');
    const s = store.session(id);
    if (local && (!s.projectId || !store.project(s.projectId).trusted)) throw new Error('请先启用项目');
    await requireSupportedPi(store.state.settings, developmentRoot);
    const pi = await resolvePi(store.state.settings, developmentRoot);
    const args = [
      ...pi.spec.args,
      action,
      ...(action === 'update' ? ['--extensions'] : []),
      ...(source ? [source] : []),
      ...(local ? ['--local'] : []),
    ];
    await service.updatePackages(id, local, async () =>
      exec(pi.spec.command, args, {
        cwd: await store.sessionDirectory(id),
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory(store.state.settings), PI_TELEMETRY: '0' },
      }),
    );
    await service.get(id).connect(id);
  },
  providers: async (id) => {
    text(id, 100);
    return service.get(id).admin(id, 'providers');
  },
  login: async (id, provider, type) => {
    text(id, 100);
    text(provider, 200);
    if (!['oauth', 'api_key'].includes(type)) throw new Error('登录方式无效');
    await service.get(id).admin(id, 'login', { provider, type });
  },
  logout: async (id, provider) => {
    text(id, 100);
    text(provider, 200);
    await service.get(id).admin(id, 'logout', { provider });
  },
  cancelLogin: (id) => {
    text(id, 100);
    return service.get(id).cancelLogin();
  },
  configRead: async (id, kind, local) => {
    text(id, 100);
    return new Configuration(store).read(id, kind, local);
  },
  configSave: async (id, kind, local, document) => {
    text(id, 100);
    text(document?.text);
    text(document?.revision, 100);
    return new Configuration(store).saveAndApply(id, kind, local, document, () =>
      service.reloadConfiguration(id, local),
    );
  },
  revealSessionDirectory: async (id) => {
    text(id, 100);
    await shell.openPath(await store.sessionDirectory(id));
  },
  openPiTerminal: async (id) => {
    text(id, 100);
    await requireSupportedPi(store.state.settings, developmentRoot);
    const agent = service.get(id);
    await agent.connect(id);
    const spec = (await resolvePi(store.state.settings, developmentRoot)).spec;
    const s = store.session(id);
    const args = s.file ? ['--session', s.file] : ['--session-id', s.id];
    await service.handoffToTerminal(id, async () =>
      openTerminal(
        [spec.command, ...spec.args, ...args],
        await store.sessionDirectory(id),
        { PI_CODING_AGENT_DIR: agentDirectory(store.state.settings) },
        terminalLock(id),
      ),
    );
  },
  editDraft: async (id) => {
    text(id, 100);
    await protectSessionOperation('editDraft', [id]);
    const s = store.session(id);
    const original = JSON.stringify([s.draft, s.draftSnippets ?? []]);
    const file = path.join(store.dir, 'draft-' + encodeURIComponent(id) + '.txt');
    await fs.writeFile(file, composeDraftText(s.draft, s.draftSnippets ?? []), 'utf8');
    await openTextEditor(file, store.state.settings.editorPath || undefined);
    const result = await showAppDialog({
      type: 'info',
      message: '在外部编辑器中编辑草稿',
      detail: '编辑并保存文件后，点击“导入已保存内容”。',
      buttons: ['取消', '导入已保存内容'],
      defaultId: 1,
      cancelId: 0,
    });
    if (result.response !== 1) return;
    const content = await fs.readFile(file, 'utf8');
    text(content);
    const current = store.session(id);
    if (JSON.stringify([current.draft, current.draftSnippets ?? []]) !== original)
      throw new Error('草稿在外部编辑期间已变化，未覆盖当前内容。外部编辑结果仍保存在：' + file);
    current.draft = content;
    current.draftSnippets = [];
    await save();
  },
  stop: (id) => {
    text(id, 100);
    return service.get(id).stop();
  },
  stopAll: async () => {
    const result = await showAppDialog({
      type: 'warning',
      message: '停止所有会话的任务？',
      detail: '所有正在运行的会话都将停止，未发送的队列内容会恢复到各自草稿。',
      buttons: ['取消', '停止所有会话'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) await service.stop();
  },
  clearQueue: (id) => {
    text(id, 100);
    return service.get(id).clearQueue();
  },
  forceStop: async (id) => {
    text(id, 100);
    const result = await showAppDialog({
      type: 'warning',
      message: '强制结束当前 Pi 会话进程？',
      detail: '正在执行的命令将被终止。已写入的项目文件将保留。',
      buttons: ['继续等待', '强制结束'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return false;
    await service.get(id).forceStop();
    return true;
  },
  respond: async (sessionId, id, values) => {
    text(sessionId, 100);
    text(id, 200);
    if (!values || typeof values !== 'object') throw new Error('回复格式无效');
    if (values.value !== undefined) text(values.value);
    return service.get(sessionId).respond(id, {
      value: values.value,
      confirmed: values.confirmed === true,
      cancelled: values.cancelled === true,
    });
  },
  files: async (id, dir) => {
    text(id, 100);
    text(dir, 4096);
    return listDirectory(store.project(id), dir);
  },
  searchFiles: async (id, query) => {
    text(id, 100);
    text(query, 1000);
    return (await allFiles(store.project(id)))
      .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 80);
  },
  preview: async (id, relative) => {
    text(id, 100);
    text(relative, 4096);
    return previewFile(store.project(id), relative);
  },
  attachmentInfo: async (id, specs) => {
    text(id, 100);
    strings(specs);
    return attachmentInfo(store.project(id), specs);
  },
  projectRules: async (id) => {
    text(id, 100);
    return projectRules(store.project(id));
  },
  editProjectRules: async (id) => {
    text(id, 100);
    const project = store.project(id);
    const rules = await projectRules(project);
    if (!rules) throw new Error('项目规则文件已不存在，请刷新后重新生成');
    await openTextEditor(
      await safePath(project.path, rules.relativePath),
      store.state.settings.editorPath || undefined,
    );
  },
  createAgentRules: async (id) => {
    text(id, 100);
    const project = store.project(id);
    const file = await createAgentRules(project);
    send({ type: 'workspaceChanged', projectId: id, changedPaths: [file.relativePath] });
    await openTextEditor(
      await safePath(project.path, file.relativePath),
      store.state.settings.editorPath || undefined,
    );
    return file;
  },
  changes: async (id, mode = 'all', context) => {
    text(id, 100);
    if (!['all', 'run'].includes(mode)) throw new Error('差异模式无效');
    return workspace.changes(store.project(id), mode, checkpointContext(id, context));
  },
  diff: async (id, relative, mode, context) => {
    text(id, 100);
    text(relative, 4096);
    if (!['all', 'run'].includes(mode)) throw new Error('差异模式无效');
    return workspace.diff(store.project(id), relative, mode, checkpointContext(id, context));
  },
  openFile: async (id, relative) => {
    text(id, 100);
    text(relative, 4096);
    const file = await safePath(store.project(id).path, relative);
    const editor = store.state.settings.editorPath;
    if (editor) await openWithApp(editor, file);
    else shell.showItemInFolder(file);
  },
  openResource: async (id, target) => {
    text(id, 100);
    text(target, 4096);
    store.session(id);
    let known = sessionResourcePaths.get(id) ?? [];
    if (!known.some((item) => samePath(item, target))) {
      const catalog = (await service.get(id).admin(id, 'resources')) as ResourceCatalog;
      known = catalog.resources.map((item) => item.path);
      sessionResourcePaths.set(id, known);
    }
    const matched = known.find((item) => samePath(item, target));
    if (!matched) throw new Error('找不到该资源文件，请刷新资源列表后重试');
    const editor = store.state.settings.editorPath;
    if (editor) await openWithApp(editor, matched);
    else shell.showItemInFolder(matched);
  },
  referenceDropped: async (id, files) => {
    text(id, 100);
    strings(files);
    const project = store.project(id);
    const accepted: string[] = [],
      rejected: string[] = [];
    for (const file of files.slice(0, 20)) {
      const relative = path.isAbsolute(file) ? path.relative(project.path, file) : '';
      try {
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('不在项目内');
        const preview = await previewFile(project, relative, 256 * 1024 + 1);
        if (preview.binary || preview.size > 256 * 1024) throw new Error('不是 256 KiB 以内的文本文件');
        accepted.push(relative.replaceAll('\\', '/'));
      } catch {
        rejected.push(path.basename(file));
      }
    }
    return { accepted, rejected };
  },
  openLink: async (url) => {
    text(url, 4096);
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('只能打开网页链接');
    await shell.openExternal(parsed.href);
  },
  copy: async (value) => {
    text(value, 10 * 1024 * 1024);
    await clipboard.writeText(value);
  },
  copyImage: async (value) => {
    text(value, 24 * 1024 * 1024);
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value))
      throw new Error('无法复制此图片，请使用 PNG、JPEG、WebP 或 GIF 图片');
    const image = nativeImage.createFromDataURL(value);
    if (image.isEmpty()) throw new Error('图片内容无效，无法复制');
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) }),
    ]);
  },
  exportOutput: (id) => {
    text(id, 100);
    return saveText('保存工具输出', service.get(id).output(), 'pi-output.txt');
  },
  diagnostics: () => diagnostics(),
  exportDiagnostics: async () => {
    if (!diagnosticPreview) throw new Error('请先生成诊断预览');
    return saveText('保存已预览的诊断', diagnosticPreview, 'pi-diagnostics.txt');
  },
  revealData: async () => {
    await shell.openPath(store.dir);
  },
  quit: () => {
    window?.close();
  },
};

async function createWindow() {
  const saved = await loadWindowState();
  const windowIconPath =
    process.platform === 'win32'
      ? app.isPackaged
        ? path.join(process.resourcesPath, 'icon.ico')
        : path.join(app.getAppPath(), 'build', 'icon.ico')
      : path.join(app.getAppPath(), 'build', 'icon.png');
  const { background, ...titleBarOverlay } = windowTheme(nativeTheme.shouldUseDarkColors);
  window = new BrowserWindow({
    width: saved.bounds?.width ?? 1440,
    height: saved.bounds?.height ?? 900,
    ...(saved.bounds ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: 1024,
    minHeight: 700,
    title: 'Pi Desktop',
    icon: windowIconPath,
    backgroundColor: background,
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (!isMac) {
    // Retain the Menu for native roles/accelerators; never setMenu(null).
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(false);
  }
  const rendererLost = () => {
    appDialogsReady = false;
    cancelAppDialogs();
  };
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) rendererLost();
  });
  window.webContents.on('render-process-gone', rendererLost);
  window.webContents.on('destroyed', rendererLost);
  window.on('unresponsive', () => {
    rendererResponsive = false;
    cancelAppDialogs();
  });
  window.on('responsive', () => {
    rendererResponsive = true;
  });
  if (process.platform === 'win32') {
    const executable = (app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE) || app.getPath('exe');
    // Windows needs a real file for its taskbar icon; a portable launcher outlives its extracted resources.
    window.setAppDetails({
      appId: appUserModelId,
      appIconPath: app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE ? executable : windowIconPath,
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${executable}"` : `"${executable}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Pi Desktop',
    });
  }
  window.once('ready-to-show', () => {
    if (saved.maximized) window?.maximize();
    window?.show();
  });
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const)
    window.on(event as 'resize', () => void rememberWindow());
  window.on('focus', () => window?.flashFrame(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('session-end', () => {
    sessionEnding = true;
    updates.prepareForQuit(false);
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (updates.state.installing) return;
    if (appDialogs.size) {
      cancelAppDialogs();
      if (!appQuitRequested) return;
    }
    if (isMac && !appQuitRequested) {
      window?.hide();
      return;
    }
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        service.suspendReload(true);
        if (service.requiresStopConfirmation) {
          const result = await showAppDialog(
            {
              type: 'question',
              message: 'Pi 仍在执行任务',
              detail: '停止并退出会清空后续队列，已写入文件将保留。',
              buttons: ['留在窗口', '停止并退出'],
              defaultId: 0,
              cancelId: 0,
            },
            true,
          );
          if (result.response !== 1) return;
          try {
            await service.stop();
          } catch {
            await showAppDialog(
              {
                type: 'error',
                message: '任务尚未停止，请先使用强制结束。',
              },
              true,
            );
            return;
          }
        }
        quitting = true;
        clearTimeout(windowTimer);
        windowTimer = undefined;
        // Capture the close-time bounds before persistence/disposal can yield to
        // late native resize events; still await this write before destroying.
        const finalWindowWrite = writeWindowState();
        // First await only the already-enqueued filesystem writes. If they fail,
        // the user can stay before any session service has been disposed.
        let discardUnsaved = false;
        try {
          await store.flush();
        } catch (error) {
          if (!(await confirmUnsavedQuit(error, service.disposed))) return;
          discardUnsaved = true;
        }
        // Cancellation must start before waiting for accepted native/agent work:
        // a queued model read can otherwise wait for a dialog that disposal closes.
        await service.dispose();
        await waitForOperations();
        await configurationWrites;
        // Keep a defensive final barrier for disposal-triggered writes. Never
        // silently discard a newly failed write while destroying the window.
        try {
          await store.flush();
        } catch (error) {
          if (!discardUnsaved && !(await confirmUnsavedQuit(error, true))) return;
        }
        workspaceWatcher?.dispose();
        await finalWindowWrite;
        updates.prepareForQuit(!sessionEnding && (store.storage.writable || !!store.storage.newerFormat));
        updates.dispose();
        window?.destroy();
        app.quit();
      } finally {
        if (!quitting) service.suspendReload(false);
        closing = false;
        appQuitRequested = false;
      }
    })();
  });
  const devUrl = process.env.PI_DESKTOP_DEV_URL;
  if (!app.isPackaged && devUrl === 'http://127.0.0.1:5173') await window.loadURL(devUrl);
  else await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId(appUserModelId);
      await loadLoginShellPath();
      store = new Store(app.getPath('userData'), app.getVersion());
      await store.load();
      nativeTheme.themeSource = store.state.settings.theme;
      nativeTheme.on('updated', updateWindowTheme);
      if (!store.state.sessions.some((s) => s.id === store.state.selectedSessionId)) {
        // An omitted transient selection may still carry a valid project scope on disk.
        const scope = store.state.selectedProjectId;
        const initial =
          store.durableSessions().find((session) => session.projectId === scope) ??
          store.createPlaceholder(scope);
        store.selectSession(initial.id);
        if (store.storage.writable) await store.save().catch(() => {});
      }
      if ((store.storage.recovery || store.state.appVersion !== app.getVersion()) && store.storage.writable)
        await store.save().catch(() => {});
      workspace = new Workspace(store.dir);
      if (store.storage.writable) await workspace.cleanup();
      service = new SessionAgents(
        store,
        workspace,
        developmentRoot,
        path.join(__dirname, 'pi-bridge.mjs'),
        (id) => terminalOpen(terminalLock(id)),
      );
      await watchSelectedProject();
      service.on('runtimePatch', (patch) => {
        send({ type: 'runtimePatch', patch });
      });
      service.on('attention', notifyAttention);
      service.on('runtimeRemoved', (sessionId) => send({ type: 'runtimeRemoved', sessionId }));
      service.on('state', (state) => send({ type: 'state', state }));
      store.on('storage', (storage) => send({ type: 'storage', storage }));
      const installation = updateInstallation(process.platform, app.isPackaged, process.env);
      const updateEnabled = app.isPackaged && !process.env.PI_DESKTOP_DATA_DIR;
      const updateAttempts =
        updateEnabled && ['nsis', 'appimage'].includes(installation)
          ? new UpdateAttemptFile(store.dir)
          : undefined;
      updates = new UpdateService({
        currentVersion: app.getVersion(),
        installation,
        enabled: updateEnabled,
        disabledReason: updateEnabled ? undefined : '开发和测试环境不检查更新。',
        autoDownload: store.state.settings.autoDownloadUpdates,
        previousAttempt: await updateAttempts?.read(app.getVersion()),
        recordAttempt: updateAttempts ? (attempt) => updateAttempts.record(attempt) : undefined,
        driver:
          updateEnabled && (installation === 'nsis' || installation === 'appimage')
            ? createNativeUpdateDriver(installation)
            : undefined,
        fetchRelease: () => fetchLatestRelease(net.fetch),
        fetchNotes: (version) => fetchReleaseNotes(version, net.fetch),
        busy: () => service.hasPendingWork || updatingConfiguration || activeOperations > 0,
        beforeInstall: async () => {
          if (closing || sessionEnding) throw new Error('应用正在退出，请下次启动后重试更新');
          if (!store.storage.writable && !store.storage.newerFormat) store.assertWritable();
          await service.disconnect();
          if (store.storage.writable) await store.flush();
          clearTimeout(windowTimer);
          windowTimer = undefined;
          await writeWindowState();
          quitting = true;
          // Keep the watcher until process exit: preparation/installer errors can return to this window.
          // Its callback is already suppressed while quitting, and resumes if installFailed clears it.
        },
        installFailed: () => {
          quitting = false;
        },
      });
      updates.on('update', (update) => send({ type: 'update', update }));
      powerMonitor.on('shutdown', () => {
        sessionEnding = true;
        updates.prepareForQuit(false);
      });
      ipcMain.handle('desktop:invoke', async (event, method: string, args: unknown[]) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error('无效 IPC 来源');
        if (
          !Object.prototype.hasOwnProperty.call(handlers, method) ||
          !Array.isArray(args) ||
          args.length > 6
        )
          throw new Error('无效请求');
        let trackedOperation = false;
        try {
          if (quitting) throw new Error('应用正在关闭，请稍后重新打开');
          // Late layout cleanup must not create writes after the update's persistence barrier.
          if (updates.state.installing && method === 'saveView') return;
          if (
            updates.state.installing &&
            ![
              'bootstrap',
              'navigationState',
              'diagnostics',
              'copy',
              'respondAppDialog',
              'appDialogsReady',
            ].includes(method)
          )
            throw new Error('正在准备重启更新，请稍候');
          const readOnlyMethods: (keyof ApiMap)[] = [
            'appDialogsReady',
            'respondAppDialog',
            'showAppMenu',
            'bootstrap',
            'navigationState',
            'checkUpdate',
            'downloadUpdate',
            'installUpdate',
            'selectSession',
            'readHistory',
            'searchSessions',
            'piSessions',
            'detect',
            'choosePath',
            'files',
            'searchFiles',
            'preview',
            'attachmentInfo',
            'projectImage',
            'projectRules',
            'editProjectRules',
            'checkpoints',
            'checkpointPreview',
            'usageSummary',
            'diff',
            'changes',
            'configRead',
            'sessionTree',
            'resources',
            'providers',
            'promptRead',
            'exportSession',
            'copy',
            'copyImage',
            'diagnostics',
            'exportDiagnostics',
            'exportOutput',
            'revealData',
            'openLink',
            'openFile',
            'openResource',
            'stop',
            'stopAll',
            'abortRetry',
            'clearQueue',
            'respond',
            'forceStop',
            'quit',
          ];
          if (!store.storage.writable && !readOnlyMethods.includes(method as keyof ApiMap))
            store.assertWritable();
          // A renderer modal must block the same application commands as a native modal.
          // Autosaves already scheduled before it opened may still finish safely.
          if (
            appDialogs.size &&
            ![
              'appDialogsReady',
              'respondAppDialog',
              'bootstrap',
              'navigationState',
              'diagnostics',
              'copy',
              'copyImage',
              'saveDraft',
              'saveView',
              'readHistory',
              'stop',
              'stopAll',
              'forceStop',
              'abortRetry',
              'clearQueue',
              'respond',
              'quit',
            ].includes(method)
          )
            throw new Error('请先完成当前确认');
          const settingPatch =
            method === 'saveSettings' && args[0] && typeof args[0] === 'object'
              ? (args[0] as Record<string, unknown>)
              : undefined;
          const changesEngineSettings =
            !!settingPatch &&
            ['piPath', 'nodePath', 'agentDir', 'provider', 'modelId', 'thinking'].some(
              (key) =>
                key in settingPatch &&
                settingPatch[key] !== store.state.settings[key as keyof typeof store.state.settings],
            );
          const engineOperation =
            changesEngineSettings ||
            [
              'connect',
              'readModels',
              'recover',
              'send',
              'selectSession',
              'sessionTree',
              'branchSession',
              'compact',
              'piOption',
              'exportSession',
              'shareSession',
              'reloadPi',
              'resources',
              'promptRead',
              'promptSave',
              'promptDelete',
              'toggleResource',
              'packageAction',
              'providers',
              'login',
              'logout',
              'configSave',
              'openPiTerminal',
              'deleteSession',
              'openPiSession',
              'setSessionModel',
              'setSessionThinking',
              'messageAction',
              'setEntryLabel',
              'cleanupEmptySessions',
              'revertChanges',
              'revertCheckpoint',
              'createAgentRules',
              'testConnection',
            ].includes(method);
          const configOperation =
            changesEngineSettings ||
            [
              'configSave',
              'packageAction',
              'promptSave',
              'promptDelete',
              'toggleResource',
              'reloadPi',
            ].includes(method);
          trackedOperation =
            engineOperation ||
            [
              'usageSummary',
              'respond',
              'stop',
              'stopAll',
              'forceStop',
              'abortRetry',
              'clearQueue',
              'cancelLogin',
            ].includes(method) ||
            !readOnlyMethods.includes(method as keyof ApiMap);
          if (trackedOperation) activeOperations++;
          const invoke = () => handlers[method as keyof ApiMap](...args);
          const execute = async () => {
            const projectId = ['revertChanges', 'createAgentRules'].includes(method)
              ? (args[0] as string)
              : method === 'revertCheckpoint'
                ? store.session(args[0] as string).projectId
                : undefined;
            if (projectId) {
              const root = store.project(projectId).path;
              return service.inWorkspace(root, true, async () => {
                await assertWorkspaceTerminalsClosed(root);
                return invoke();
              });
            }
            const sessionOperation =
              [
                'connect',
                'send',
                'recover',
                'compact',
                'openPiTerminal',
                'testConnection',
                'login',
                'logout',
              ].includes(method) ||
              (method === 'branchSession' && args[1] === 'navigate') ||
              (method === 'messageAction' && args[1] !== 'fork');
            if (sessionOperation) {
              const id = args[0] as string;
              await protectSessionOperation(method, args);
              return inSessionWorkspace(id, invoke);
            }
            return invoke();
          };
          if (configOperation) {
            const operation = configurationWrites.then(async () => {
              updatingConfiguration = true;
              try {
                return await execute();
              } finally {
                updatingConfiguration = false;
              }
            });
            configurationWrites = operation.then(
              () => {},
              () => {},
            );
            return await operation;
          }
          return await execute();
        } catch (e) {
          throw new Error(redact(e instanceof Error ? e.message : String(e)));
        } finally {
          if (trackedOperation) finishOperation();
        }
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(isMac
            ? [
                {
                  label: app.name,
                  submenu: [
                    { role: 'about' as const, label: '关于 Pi Desktop' },
                    { type: 'separator' as const },
                    {
                      label: '设置…',
                      accelerator: 'Cmd+,',
                      registerAccelerator: false,
                      click: () =>
                        window?.webContents.sendInputEvent({
                          type: 'keyDown',
                          keyCode: ',',
                          modifiers: ['meta'],
                        }),
                    },
                    { type: 'separator' as const },
                    { role: 'services' as const, label: '服务' },
                    { type: 'separator' as const },
                    { role: 'hide' as const, label: '隐藏 Pi Desktop' },
                    { role: 'hideOthers' as const, label: '隐藏其他' },
                    { role: 'unhide' as const, label: '全部显示' },
                    { type: 'separator' as const },
                    { role: 'quit' as const, label: '退出 Pi Desktop' },
                  ],
                },
              ]
            : []),
          {
            id: 'file',
            label: '文件',
            submenu: [
              {
                label: '新建对话',
                accelerator: 'CmdOrCtrl+N',
                registerAccelerator: false,
                click: () => {
                  void newSessionFromMenu();
                },
              },
              { type: 'separator' },
              isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
            ],
          },
          {
            id: 'edit',
            label: '编辑',
            submenu: [
              { role: 'undo', label: '撤销' },
              { role: 'redo', label: '重做' },
              { type: 'separator' },
              { role: 'cut', label: '剪切' },
              { role: 'copy', label: '复制' },
              { role: 'paste', label: '粘贴' },
              { role: 'selectAll', label: '全选' },
            ],
          },
          {
            id: 'view',
            label: '视图',
            submenu: [
              { role: 'resetZoom', label: '重置缩放' },
              { role: 'zoomIn', label: '放大' },
              { role: 'zoomOut', label: '缩小' },
              { role: 'togglefullscreen', label: '全屏' },
            ],
          },
          ...(isMac
            ? [
                {
                  label: '窗口',
                  submenu: [
                    { role: 'minimize' as const, label: '最小化' },
                    { role: 'zoom' as const, label: '缩放' },
                    { type: 'separator' as const },
                    { role: 'front' as const, label: '全部置于顶层' },
                  ],
                },
              ]
            : []),
        ]),
      );
      await createWindow();
      updates.start();
    })
    .catch((error) => {
      dialog.showErrorBox('Pi Desktop 无法启动', String(error));
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
  app.on('activate', () => {
    if (window && !window.isDestroyed()) window.show();
  });
  app.on('before-quit', (event) => {
    if (!quitting && window && !window.isDestroyed()) {
      event.preventDefault();
      appQuitRequested = true;
      window.close();
    }
  });
}
