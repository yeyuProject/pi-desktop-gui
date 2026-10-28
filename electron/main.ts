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
  session as electronSession,
  powerMonitor,
  type Rectangle,
} from 'electron';
import { AppDialogRequests, type DialogOptions } from './app-dialogs';
import { nativeThemeSource, THEMES, windowTheme } from '../shared/window-theme';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, readSessionFile } from './store';
import { redact } from './agent';
import { SessionAgents } from './session-agents';
import { Workspace } from './workspace';
import { createWorkspaceHandlers, type WorkspaceHandlerName } from './ipc/workspace-handlers';
import { WorkspaceWatcher } from './workspace-watch';
import { isEmptySession, hasSessionData, fillSessionUsage } from './session-maintenance';
import { aggregateUsage } from '../shared/usage';
import { validateGoalAction } from '../shared/goal';
import { composeDraftText } from '../shared/draft';
import { isDraftQuote } from '../shared/message-content';
import { splitMessageQuotes } from '../shared/message-content';
import { SideChats } from './side-chats';
import {
  sideChatContext,
  sideChatPrompt,
  type SideChat,
  type SideChatRequest,
  type SideChatInput,
} from '../shared/side-chat';
import { classifyModelError } from '../shared/errors';
import { validatePromptTemplate } from '../shared/prompts';
import {
  readPromptTemplate,
  savePromptTemplate,
  deletePromptTemplate,
  describeResource,
  type PromptTemplateContext,
} from './prompts';
import type { ResourceCatalog } from '../shared/types';
import { detectEnvironment, requireSupportedPi, resolvePi, agentDirectory } from './environment';
import { Configuration } from './configuration';
import { toggleResourceSetting } from './resources-config';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import { UpdateService, updateInstallation } from './updater';
import { createNativeUpdateDriver } from './update-driver';
import { updateFeed, updateProxy } from './update-network';
import { readSignedUpdate } from './signed-update-provider';
import { UpdateAttemptFile } from './update-attempt';
import { acknowledgeUpdateHealth } from './update-health';
import { removeSessionScratch, clearDesktopRecords } from './local-data';
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
  type StateSnapshot,
  type Settings,
} from '../shared/types';

let window: BrowserWindow | undefined, store: Store, service: SessionAgents, workspace: Workspace;
let sideChats: SideChats;
interface SideFlight {
  sessionId: string;
  id: string;
  chat?: SideChat;
  done?: Promise<void>;
  cancelled?: boolean;
}
let sideFlight: SideFlight | undefined;
let workspaceCleanup: Promise<void> | undefined;
let updates: UpdateService;
let quitting = false;
let closing = false;
let sessionEnding = false;
let activeOperations = 0;
let workspaceHandlers: ReturnType<typeof createWorkspaceHandlers> | undefined;
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
let environmentRevision = 0;
const environmentSettingsKey = (settings: Settings) =>
  JSON.stringify([settings.piPath, settings.nodePath, agentDirectory(settings)]);
let environmentSnapshot: { key: string; value: Awaited<ReturnType<typeof detectEnvironment>> } | undefined;
async function refreshEnvironment(): Promise<Awaited<ReturnType<typeof detectEnvironment>>> {
  const revision = ++environmentRevision;
  const settings = store.state.settings;
  const key = environmentSettingsKey(settings);
  const environment = await detectEnvironment(settings, developmentRoot).catch((error) => ({
    piPath: '',
    supported: false,
    compatibility: 'unknown' as const,
    agentDir: agentDirectory(settings),
    authExists: false,
    modelsExist: false,
    errors: [(error as Error).message],
  }));
  if (revision === environmentRevision) {
    // Layout/theme saves replace settings too; only Pi paths invalidate a probe.
    if (key !== environmentSettingsKey(store.state.settings)) return refreshEnvironment();
    environmentSnapshot = { key, value: environment };
    send({ type: 'environment', environment });
  }
  return environment;
}
let searchController: AbortController | undefined;
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
let workbenchReady = false;
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
  const { background, ...overlay } = windowTheme(
    nativeTheme.shouldUseDarkColors,
    store?.state.settings.theme,
  );
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
function updateAttentionBadge() {
  const count = [...attention.values()].reduce((sum, item) => sum + item.dialogs, 0);
  app.setBadgeCount(count);
  if (process.platform === 'win32' && window && !window.isDestroyed()) {
    window.setOverlayIcon(
      count ? nativeImage.createFromPath(path.join(app.getAppPath(), 'build/icon.png')) : null,
      count ? `${count} 项等待回复` : '',
    );
  }
}
// Retain the native notification while its click handler may still be used.
let _lastToast: Notification | undefined;
function notifyAttention(runtime: Runtime) {
  if (!runtime.sessionId) return;
  const previous = attention.get(runtime.sessionId);
  attention.set(runtime.sessionId, { status: runtime.status, dialogs: runtime.dialogs.length });
  updateAttentionBadge();
  if (
    !window ||
    window.isDestroyed() ||
    (window.isFocused() && store.state.selectedSessionId === runtime.sessionId)
  )
    return;
  if (!previous) return;
  if (!Notification.isSupported()) return;
  const session = store.state.sessions.find((s) => s.id === runtime.sessionId);
  if (!session) return;
  const finished = busy(previous.status) && !busy(runtime.status);
  let title: string, body: string;
  if (runtime.dialogs.length > previous.dialogs) {
    if (store.state.settings.notifyOnApproval === false) return;
    title = 'Pi 需要你的回复';
    body = runtime.dialogs.at(-1)?.title || session.title;
  } else if (finished && runtime.status === 'completed') {
    if (!store.state.settings.notifyOnFinish) return;
    title = '任务已完成 · ' + session.title;
    const last = runtime.messages.findLast((m) => m.role === 'assistant');
    body = (last ? messageText(last) : '').replace(/\s+/g, ' ').trim().slice(0, 120) || '点击查看结果';
  } else if (finished && (runtime.status === 'error' || runtime.status === 'interrupted')) {
    if (store.state.settings.notifyOnError === false) return;
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
  _lastToast = toast;
  window.flashFrame(true);
}
const windowFile = () => path.join(store.dir, 'window.json');
async function loadWindowState(): Promise<{ bounds?: Rectangle; maximized: boolean; zoom?: number }> {
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
            width: Math.min(area.width, Math.max(800, b.width)),
            height: Math.min(area.height, Math.max(700, b.height)),
          }
        : undefined,
      maximized: value.maximized === true,
      zoom: Number.isFinite(value.zoom) ? Math.max(0.5, Math.min(2, value.zoom)) : 1,
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
  const contents = JSON.stringify({
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
    zoom: window.webContents.getZoomFactor(),
  });
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
function changeZoom(direction: number) {
  if (!window || window.isDestroyed()) return;
  window.webContents.setZoomFactor(
    direction === 0 ? 1 : Math.max(0.5, Math.min(2, window.webContents.getZoomFactor() + direction * 0.1)),
  );
  rememberWindow();
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
const handlers: Record<Exclude<keyof ApiMap, WorkspaceHandlerName>, (...args: any[]) => any> = {
  sideChatRead: async (id) => {
    text(id, 100);
    store.session(id);
    const chat = await sideChats.read(id);
    return sideFlight?.sessionId === id && sideFlight.chat ? sideFlight.chat : chat;
  },
  sideChatSend: async (id, request: SideChatRequest) => {
    text(id, 100);
    store.assertWritable();
    text(request?.id, 100);
    text(request?.prompt);
    if (
      !/^[\w-]{1,100}$/.test(request.id) ||
      !['quotes', 'reply', 'all'].includes(request.scope) ||
      !Array.isArray(request.quotes) ||
      !request.quotes.every(isDraftQuote) ||
      (!request.prompt.trim() && !request.quotes.length)
    )
      throw new Error('请填写侧边问题，引用内容与上下文范围必须有效');
    if (sideFlight) throw new Error('已有侧边对话正在回答，请先等待或停止');
    const agent = service.get(id);
    if (!agent.runtime.connected || !agent.runtime.model)
      throw new Error('请先连接主会话并选择模型，再发送侧边提问');
    const flight: SideFlight = { sessionId: id, id: request.id };
    sideFlight = flight;
    flight.done = (async () => {
      const chat = await sideChats.read(id);
      flight.chat = chat;
      const context = sideChatContext(
        agent.runtime.messages,
        request,
        agent.runtime.model!.contextWindow,
        busy(agent.runtime.status),
        [
          ...chat.messages.map(({ role, content }) => ({ role, content })),
          { role: 'user', content: sideChatPrompt(request) },
        ],
      );
      const prompt = sideChatPrompt(request);
      const inputs: SideChatInput[] = context.messages;
      chat.messages.push({ id: request.id + '-user', role: 'user', content: prompt, timestamp: Date.now() });
      const answer = { id: request.id, role: 'assistant' as const, content: '', timestamp: Date.now() };
      chat.messages.push(answer);
      chat.messages = chat.messages.slice(-100);
      chat.running = request.id;
      chat.error = undefined;
      chat.omittedTurns = context.omittedTurns;
      store.promoteSession(id);
      send({ type: 'sideChat', chat });
      try {
        if (flight.cancelled) {
          Object.assign(answer, { aborted: true });
          return;
        }
        const result = await agent.sideChat(id, { id: request.id, messages: inputs }, (text) => {
          answer.content += text;
          send({ type: 'sideChatDelta', sessionId: id, id: request.id, text });
        });
        Object.assign(answer, { content: result.text, aborted: result.aborted, usage: result.usage });
        const session = store.session(id);
        session.sideUsage = {
          tokens: (session.sideUsage?.tokens ?? 0) + result.usage.tokens,
          cost: (session.sideUsage?.cost ?? 0) + result.usage.cost,
          updatedAt: Date.now(),
        };
        await save();
      } catch (error) {
        chat.error = classifyModelError(error instanceof Error ? error.message : String(error));
      } finally {
        chat.running = undefined;
        await sideChats.save(chat);
        send({ type: 'sideChat', chat });
      }
    })();
    try {
      await flight.done;
    } finally {
      if (sideFlight === flight) sideFlight = undefined;
    }
  },
  sideChatStop: async (id) => {
    text(id, 100);
    store.session(id);
    if (sideFlight?.sessionId === id) {
      sideFlight.cancelled = true;
      await service.get(id).stopSideChat();
    }
  },
  sideChatClear: async (id) => {
    text(id, 100);
    store.assertWritable();
    store.session(id);
    if (sideFlight?.sessionId === id) {
      sideFlight.cancelled = true;
      await service.get(id).stopSideChat();
      await sideFlight?.done;
    }
    await sideChats.remove(id);
    send({ type: 'sideChat', chat: { sessionId: id, messages: [], omittedTurns: 0 } });
  },
  sideChatContinue: async (id, answerId) => {
    text(id, 100);
    text(answerId, 100);
    store.assertWritable();
    const original = store.session(id);
    const chat = await sideChats.read(id);
    const index = chat.messages.findIndex((m) => m.id === answerId && m.role === 'assistant');
    if (index < 1) throw new Error('这条侧边回答已被清空，请重新选择');
    const session = store.createSession(original.projectId);
    session.title = '从侧边对话继续';
    const question = splitMessageQuotes(chat.messages[index - 1].content);
    session.draftQuotes = question.quotes;
    session.draft = `原问题：\n${question.text}\n\n侧边回答：\n${chat.messages[index].content}\n\n继续提问：`;
    store.selectSession(session.id);
    await save();
    return session;
  },
  rendererReady: () => {
    workbenchReady = true;
    if (appDialogsReady) void acknowledgeUpdateHealth(app.getVersion()).catch(() => {});
  },
  retryStorage: () => store.retrySave(),
  clearLocalData: async () => {
    if (service.hasPendingWork || activeOperations > 1) throw new Error('请先停止所有任务并完成待处理操作');
    for (const session of store.state.sessions) await assertTerminalClosed(session.id);
    const result = await showAppDialog({
      type: 'warning',
      message: '清除桌面本地数据并重启？',
      detail: `将永久清除 ${store.dir} 中的会话索引、草稿、草稿图片、备份、代码快照、桌面会话文件和独立对话工作目录。外部项目源码、Pi 外部历史和供应商登录凭据不在此范围内。请先导出需要保留的内容。`,
      buttons: ['取消', '清除并重启'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return;
    if (service.hasPendingWork || activeOperations > 1) throw new Error('任务状态已变化，请停止任务后重试');
    quitting = true;
    try {
      for (const session of store.state.sessions) await assertTerminalClosed(session.id);
      store.stopRecovery();
      const flight = sideFlight;
      if (flight) flight.cancelled = true;
      await service.dispose();
      await flight?.done;
      await workspaceCleanup;
      await configurationWrites;
      await store.flush().catch(() => {}); // Explicit erasure also works after an unrecoverable save failure.
      await clearDesktopRecords(store.dir);
      await window?.webContents.session.clearStorageData();
      await window?.webContents.session.clearCache();
      app.relaunch();
      app.exit(0);
    } catch (error) {
      quitting = false;
      throw error;
    }
  },
  appDialogsReady: () => {
    appDialogsReady = true;
    rendererResponsive = true;
    if (workbenchReady) void acknowledgeUpdateHealth(app.getVersion()).catch(() => {});
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
    void refreshEnvironment().catch(() => {});
    service.resync();
    return {
      ...stateSnapshot(),
      runtime: service.runtime,
      environment:
        environmentSnapshot?.key === environmentSettingsKey(store.state.settings)
          ? environmentSnapshot.value
          : undefined,
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
    if (sideFlight?.sessionId === id) {
      const flight = sideFlight;
      flight.cancelled = true;
      await service.get(id).stopSideChat();
      await flight.done;
    }
    const result = await showAppDialog({
      type: 'warning',
      message: `删除会话“${s.title}”？`,
      detail:
        (s.file ? 'Pi 会话文件会移到回收站，可从回收站恢复。' : '会话将从列表移除。') +
        '此会话的检查点、临时草稿和备份草稿将永久清理。',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return false;
    if (!store.state.sessions.includes(s)) return false;
    let removedFile = false;
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
      if (exists) {
        await shell.trashItem(s.file);
        removedFile = true;
      }
    }
    await workspace.removeSession(id);
    await sideChats.remove(id);
    await removeSessionScratch(store.dir, id);
    store.removeSessions([id]);
    if (store.state.selectedSessionId === id) {
      const next =
        store.durableSessions().find((x) => x.projectId === s.projectId) ??
        store.durableSessions().find((x) => !x.projectId) ??
        store.createPlaceholder(s.projectId);
      store.selectSession(next.id);
    }
    await save();
    await store.purgeDeletedSession(id);
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
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    try {
      return await searchSessionContents(store.durableSessions(), query, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return [];
      throw error;
    }
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
  setEntryLabel: async (id, entryId, label) => {
    text(id, 100);
    text(entryId, 100);
    text(label, 200);
    await service.get(id).admin(id, 'set_label', { entryId, label });
  },
  saveDraft: async (id, draft, attachments, images, snippets, quotes) => {
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
    if (quotes !== undefined && (!Array.isArray(quotes) || !quotes.every(isDraftQuote)))
      throw new Error('引用内容无效，请移除后重新引用');
    const s = store.session(id);
    if (draft || attachments.length || images?.length || snippets?.length || quotes?.length)
      store.promoteSession(id);
    s.draft = draft;
    s.attachments = attachments;
    if (snippets !== undefined) s.draftSnippets = snippets;
    if (quotes !== undefined) s.draftQuotes = quotes;
    if (images !== undefined) s.images = images;
    await store.scheduleSave();
  },
  flushDraft: () => store.flush(),
  consumeDraft: async (id, expected, attachments, images) => {
    text(id, 100);
    text(expected);
    strings(attachments);
    validateImages(images);
    const s = store.session(id);
    if (store.matchesDraft(s, expected, attachments, images)) {
      if (
        s.draft ||
        s.attachments.length ||
        s.images?.length ||
        s.draftSnippets?.length ||
        s.draftQuotes?.length
      )
        store.promoteSession(id);
      s.draft = '';
      s.attachments = [];
      s.images = [];
      s.draftSnippets = [];
      s.draftQuotes = [];
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
  readDraftImages: (id) => {
    text(id, 100);
    return store.draftImages(id);
  },
  detect: refreshEnvironment,
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
      'updateProxy',
      'updateMirror',
    ] as const)
      if (key in value) {
        text(value[key], 4096);
        next[key] = value[key];
      }
    if (value.theme !== undefined) {
      if (!(THEMES as readonly unknown[]).includes(value.theme)) throw new Error('主题无效');
      next.theme = value.theme;
    }
    for (const [key, min, max] of [
      ['fontScale', 1, 2],
      ['sidebarWidth', 180, 360],
      ['inspectorWidth', 300, 720],
      ['sideChatWidth', 300, 560],
      ['inspectorSplit', 15, 70],
    ] as const)
      if (value[key] !== undefined) {
        if (!Number.isFinite(value[key])) throw new Error('尺寸无效');
        next[key] = Math.max(min, Math.min(max, value[key]));
      }
    if (typeof value.onboardingDone === 'boolean') next.onboardingDone = value.onboardingDone;
    if (typeof value.expandThinking === 'boolean') next.expandThinking = value.expandThinking;
    if (typeof value.notifyOnFinish === 'boolean') next.notifyOnFinish = value.notifyOnFinish;
    if (typeof value.notifyOnApproval === 'boolean') next.notifyOnApproval = value.notifyOnApproval;
    if (typeof value.notifyOnError === 'boolean') next.notifyOnError = value.notifyOnError;
    updateFeed(next.updateMirror);
    updateProxy(next.updateProxy, {});
    if (value.autoDownloadUpdates !== undefined) {
      if (typeof value.autoDownloadUpdates !== 'boolean') throw new Error('自动下载更新设置无效');
      next.autoDownloadUpdates = value.autoDownloadUpdates;
    }
    const modelsChanged = (
      ['piPath', 'nodePath', 'agentDir', 'provider', 'modelId', 'thinking'] as const
    ).some((key) => next[key] !== store.state.settings[key]);
    store.state.settings = next;
    await save();
    if (modelsChanged) service.invalidateModels();
    nativeTheme.themeSource = nativeThemeSource(next.theme);
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
  openGoal: async (id) => {
    text(id, 100);
    await service.get(id).openGoal(id);
  },
  goalAction: async (id, action) => {
    text(id, 100);
    validateGoalAction(action);
    const agent = service.get(id);
    if (action.action === 'clear' && agent.runtime.goal?.status !== 'completed') {
      const result = await showAppDialog({
        type: 'question',
        message: '清除 Goal？',
        detail: '清除后不再自动继续，已完成的修改保留',
        buttons: ['取消', '清除'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return;
    }
    await agent.goalAction(id, action);
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
    if (document.error) throw new Error(`配置格式有误，请在完整 Pi 配置中修复：${document.path}`);
    const values = toggleResourceSetting(JSON.parse(document.text), found, enabled);
    await config.save(id, 'settings', local, { ...document, text: JSON.stringify(values) });
    await service.reloadConfiguration(id, local);
  },
  packageAction: async (id, action, source, local) => {
    text(id, 100);
    text(source, 4096);
    if (typeof local !== 'boolean') throw new Error('请选择资源包的作用范围');
    source = source.trim();
    if (!['install', 'remove', 'update'].includes(action)) throw new Error('包操作无效');
    if (action !== 'update' && (!source.trim() || source.startsWith('-')))
      throw new Error('请输入有效包来源');
    if (source.startsWith('-')) throw new Error('包来源不能是命令参数');
    const s = store.session(id);
    if (local && (!s.projectId || !store.project(s.projectId).trusted)) throw new Error('请先启用项目');
    const cwd = await store.sessionDirectory(id);
    if (action === 'remove') {
      const result = await showAppDialog({
        type: 'warning',
        message: `移除资源包“${source}”？`,
        detail: '移除后，使用此范围配置的会话将无法继续使用其中的扩展、技能或模板。',
        buttons: ['取消', '移除'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
    } else {
      // Pi updates configured packages in both scopes; --local applies only to install/remove.
      const scope =
        action === 'update'
          ? `个人配置，以及工作目录（${cwd}）中 Pi 已信任的项目配置`
          : local
            ? `当前项目：${store.project(s.projectId!).path}`
            : '个人配置（影响使用此配置的所有会话）';
      const result = await showAppDialog({
        type: 'warning',
        message: action === 'install' ? '安装资源包并允许执行其代码？' : '更新资源包并允许执行其代码？',
        detail: `来源：${source || '上述范围内所有已配置的资源包'}\n范围：${scope}\n\n安装和更新可能执行 npm 安装脚本，包内扩展也会以你的用户权限运行并访问文件和网络。请仅继续使用你信任的来源。`,
        buttons: ['取消', action === 'install' ? '安装并允许执行' : '更新并允许执行'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
    }
    await requireSupportedPi(store.state.settings, developmentRoot);
    const pi = await resolvePi(store.state.settings, developmentRoot);
    const args = [
      ...pi.spec.args,
      action,
      ...(action === 'update' ? ['--extensions'] : []),
      ...(source ? [source] : []),
      ...(local && action !== 'update' ? ['--local'] : []),
    ];
    await service.updatePackages(id, action === 'update' ? false : local, async () =>
      exec(pi.spec.command, args, {
        cwd,
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory(store.state.settings), PI_TELEMETRY: '0' },
      }),
    );
    await service.get(id).connect(id);
    return true;
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
    const result = await showAppDialog({
      type: 'warning',
      message: `退出供应商“${provider}”的登录？`,
      detail: '将移除本机保存的登录凭据。之后使用此供应商时需要重新登录或配置密钥。',
      buttons: ['取消', '退出登录'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return false;
    await service.get(id).admin(id, 'logout', { provider });
    return true;
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
    const directory = await store.sessionDirectory(id);
    if (!(await fs.stat(directory)).isDirectory())
      throw new Error('工作目录已变成文件，请在项目设置中选择有效目录');
    const error = await shell.openPath(directory);
    if (error) throw new Error(`无法打开工作目录：${error}`);
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
      detail:
        '所有正在运行的会话都将停止，未发送的队列内容会恢复到各自草稿。通过 nohup、后台运行等方式脱离 Pi 的服务可能继续运行，请到终端停止这些服务并释放端口。',
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
      detail:
        '会尝试终止 Pi 及其子进程，已写入的项目文件将保留。已脱离进程树的后台服务可能继续占用端口，请到终端停止。',
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
    // On macOS a window close only hides it. Quit must enter the normal persistence/install barrier.
    app.quit();
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
  const { background, ...titleBarOverlay } = windowTheme(
    nativeTheme.shouldUseDarkColors,
    store?.state.settings.theme,
  );
  window = new BrowserWindow({
    width: saved.bounds?.width ?? 1440,
    height: saved.bounds?.height ?? 900,
    ...(saved.bounds ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: 800,
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
  window.webContents.on('context-menu', (_event, { isEditable, editFlags }) => {
    if (!isEditable) return;
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销', enabled: editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: editFlags.canCut },
      { role: 'copy', label: '复制', enabled: editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选', enabled: editFlags.canSelectAll },
    ]).popup({ window });
  });
  const rendererLost = () => {
    workbenchReady = false;
    workspaceHandlers?.cancelActiveDiff();
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
    window?.webContents.setZoomFactor(saved.zoom ?? 1);
    if (saved.maximized) window?.maximize();
    window?.show();
    if (!closing && !quitting && store.storage.writable)
      workspaceCleanup = workspace.cleanup().catch((error) => {
        dialog.showErrorBox(
          '检查点清理未完成',
          `应用可以继续使用，请检查本地数据目录的权限和磁盘空间。\n\n${String(error)}`,
        );
      });
  });
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const)
    window.on(event as 'resize', () => void rememberWindow());
  window.webContents.on('zoom-changed', (_event, direction) => changeZoom(direction === 'in' ? 1 : -1));
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
        if (service.requiresStopConfirmation || sideFlight) {
          const result = await showAppDialog(
            {
              type: 'question',
              message: service.requiresStopConfirmation ? 'Pi 仍在执行任务' : '侧边对话正在回答，将被停止',
              detail: service.requiresStopConfirmation
                ? '停止并退出会将未发送的队列内容恢复到草稿，已写入文件将保留。通过 nohup、后台运行等方式脱离 Pi 的服务可能继续运行，请到终端停止这些服务并释放端口。'
                : '停止后保留已收到的侧边回答，随后退出应用。',
              buttons: ['留在窗口', '停止并退出'],
              defaultId: 0,
              cancelId: 0,
            },
            true,
          );
          if (result.response !== 1) return;
          try {
            if (sideFlight) sideFlight.cancelled = true;
            await service.stop();
            await sideFlight?.done;
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
        store.stopRecovery();
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
        await workspaceCleanup;
        await finalWindowWrite;
        await updates.prepareForQuit(
          !sessionEnding && (store.storage.writable || !!store.storage.newerFormat),
        );
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
      void loadLoginShellPath();
      store = new Store(app.getPath('userData'), app.getVersion());
      sideChats = new SideChats(store.dir);
      await store.load();
      nativeTheme.themeSource = nativeThemeSource(store.state.settings.theme);
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
      service = new SessionAgents(
        store,
        workspace,
        developmentRoot,
        path.join(__dirname, 'pi-bridge.mjs'),
        (id) => terminalOpen(terminalLock(id)),
      );
      workspaceHandlers = createWorkspaceHandlers({
        store,
        service,
        workspace,
        text,
        strings,
        send,
        showAppDialog,
      });
      const ipcHandlers: Record<keyof ApiMap, (...args: any[]) => any> = {
        ...handlers,
        ...workspaceHandlers.handlers,
      };
      await watchSelectedProject();
      service.on('runtimePatch', (patch) => {
        send({ type: 'runtimePatch', patch });
      });
      service.on('attention', notifyAttention);
      service.on('runtimeRemoved', (sessionId) => {
        attention.delete(sessionId);
        updateAttentionBadge();
        send({ type: 'runtimeRemoved', sessionId });
      });
      service.on('state', (state) => send({ type: 'state', state }));
      store.on('storage', (storage) => send({ type: 'storage', storage }));
      const installation = updateInstallation(process.platform, app.isPackaged, process.env);
      const updateEnabled = app.isPackaged && !process.env.PI_DESKTOP_DATA_DIR;
      const updateAttempts =
        updateEnabled && ['nsis', 'appimage', 'mac'].includes(installation)
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
          updateEnabled && (installation === 'nsis' || installation === 'appimage' || installation === 'mac')
            ? createNativeUpdateDriver(installation, () => store.state.settings)
            : undefined,
        fetchRelease: async () => {
          const session = electronSession.fromPartition('electron-updater');
          await session.setProxy(updateProxy(store.state.settings.updateProxy));
          await session.closeAllConnections();
          const info = await readSignedUpdate(
            updateFeed(store.state.settings.updateMirror),
            process.platform,
            session.fetch.bind(session),
          );
          return {
            version: info.version,
            notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
          };
        },
        busy: () => service.hasPendingWork || updatingConfiguration || activeOperations > 0,
        beforeInstall: async () => {
          if (closing || sessionEnding) throw new Error('应用正在退出，请下次启动后重试更新');
          if (!store.storage.writable && !store.storage.newerFormat) store.assertWritable();
          if (sideFlight) {
            const result = await showAppDialog({
              type: 'question',
              message: '侧边对话正在回答，将被停止',
              detail: '停止后保留已收到的侧边回答，随后重启更新。',
              buttons: ['取消', '停止并更新'],
              defaultId: 0,
              cancelId: 0,
            });
            if (result.response !== 1) throw new Error('已取消重启更新');
            const flight = sideFlight;
            if (flight) {
              flight.cancelled = true;
              await service.get(flight.sessionId).stopSideChat();
              await flight.done;
            }
          }
          await service.disconnect();
          await workspaceCleanup;
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
          !Object.prototype.hasOwnProperty.call(ipcHandlers, method) ||
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
            'clearLocalData',
            'rendererReady',
            'retryStorage',
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
            'sideChatRead',
            'sideChatStop',
            'readDraftImages',
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
            'cancelDiff',
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
              'flushDraft',
              'saveView',
              'readHistory',
              'readDraftImages',
              'cancelDiff',
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
              'clearLocalData',
              'connect',
              'readModels',
              'recover',
              'send',
              'openGoal',
              'goalAction',
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
          const invoke = () => ipcHandlers[method as keyof ApiMap](...args);
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
          // eslint-disable-next-line preserve-caught-error -- The unsanitized cause must not cross the IPC boundary.
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
                      click: () => send({ type: 'action', action: 'settings' }),
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
              { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => changeZoom(0) },
              { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => changeZoom(1) },
              { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-1) },
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
