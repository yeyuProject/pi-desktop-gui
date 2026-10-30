import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  session as electronSession,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  shell,
  type Rectangle,
} from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyModelError } from '../shared/errors';
import { goalNotificationTitle } from '../shared/goal';
import { isDraftQuote, splitMessageQuotes } from '../shared/message-content';
import {
  sideChatContext,
  sideChatPrompt,
  type SideChat,
  type SideChatInput,
  type SideChatRequest,
} from '../shared/side-chat';
import {
  busy,
  messageText,
  type ApiMap,
  type AppEvent,
  type Runtime,
  type Settings,
  type StateSnapshot,
} from '../shared/types';
import { nativeThemeSource, windowTheme } from '../shared/window-theme';
import { redact } from './agent';
import { AppDialogRequests, type DialogOptions } from './app-dialogs';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import { agentDirectory, detectEnvironment } from './environment';
import { validateImages } from './images';
import { createAgentHandlers, type AgentHandlerName } from './ipc/agent-handlers';
import { createDraftHandlers, type DraftHandlerName } from './ipc/draft-handlers';
import { invocationPolicy } from './ipc/policy';
import { createSessionHandlers, type SessionHandlerName } from './ipc/session-handlers';
import { createSettingsHandlers, type SettingsHandlerName } from './ipc/settings-handlers';
import { createWorkspaceHandlers, type WorkspaceHandlerName } from './ipc/workspace-handlers';
import { clearDesktopRecords } from './local-data';
import { isMac, loadLoginShellPath, pathKey, samePath, terminalOpen } from './platform';
import { SessionAgents } from './session-agents';
import { SideChats } from './side-chats';
import { readSignedUpdate } from './signed-update-provider';
import { readSessionFile, Store } from './store';
import { UpdateAttemptFile } from './update-attempt';
import { createNativeUpdateDriver, release as updateRelease } from './update-driver';
import { acknowledgeUpdateHealth } from './update-health';
import { updateFeed, updateProxy } from './update-network';
import { updateInstallation, UpdateService } from './updater';
import { Workspace } from './workspace';
import { WorkspaceWatcher } from './workspace-watch';

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
    store?.state.settings.uiStyle,
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
const attention = new Map<
  string,
  { status: string; dialogs: number; goalKey?: string; goalOutcome?: { title: string; body: string } }
>();
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
  const finished = !!previous && busy(previous.status) && !busy(runtime.status);
  const goal = runtime.goal;
  const goalKey = goal ? `${goal.id}:${goal.revision}:${goal.status}` : undefined;
  const goalTitle = goal && goalNotificationTitle(goal.status);
  const goalOutcome =
    goalTitle && goal && previous?.goalKey !== goalKey
      ? { title: goalTitle, body: redact(goal.reason || goal.summary || '点击查看结果').slice(0, 160) }
      : previous?.goalOutcome;
  attention.set(runtime.sessionId, {
    status: runtime.status,
    dialogs: runtime.dialogs.length,
    goalKey,
    goalOutcome: !finished && busy(runtime.status) ? goalOutcome : undefined,
  });
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
  let title: string, body: string;
  if (runtime.dialogs.length > previous.dialogs) {
    if (store.state.settings.notifyOnApproval === false) return;
    title = 'Pi 需要你的回复';
    body = runtime.dialogs.at(-1)?.title || session.title;
  } else if (finished && goalOutcome) {
    if (!store.state.settings.notifyOnFinish) return;
    title = goalOutcome.title + ' · ' + session.title;
    body = goalOutcome.body;
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
const handlers: Record<
  Exclude<
    keyof ApiMap,
    WorkspaceHandlerName | SessionHandlerName | DraftHandlerName | AgentHandlerName | SettingsHandlerName
  >,
  (...args: any[]) => any
> = {
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
    store?.state.settings.uiStyle,
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
      const handlerContext = {
        store,
        service,
        workspace,
        text,
        strings,
        save,
        send,
        showAppDialog,
        developmentRoot,
      };
      const ipcHandlers: Record<keyof ApiMap, (...args: any[]) => any> = {
        ...handlers,
        ...workspaceHandlers.handlers,
        ...createSessionHandlers({
          ...handlerContext,
          get window() {
            return window;
          },
          sideChats,
          getSideFlight: () => sideFlight,
          newSession,
          chooseFile,
          adoptSessionFile,
          sessionRoots,
          assertTerminalClosed,
          assertWorkspaceTerminalsClosed,
        }),
        ...createDraftHandlers({
          ...handlerContext,
          get window() {
            return window;
          },
          protectSessionOperation,
        }),
        ...createAgentHandlers({ ...handlerContext, inSessionWorkspace, terminalLock }),
        ...createSettingsHandlers({
          ...handlerContext,
          get window() {
            return window;
          },
          get updates() {
            return updates;
          },
          refreshEnvironment,
          updateWindowTheme,
          chooseFile,
        }),
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
          return updateRelease(info);
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
          const policy = invocationPolicy(method as keyof ApiMap, args, store.state.settings);
          if (updates.state.installing && !policy.duringUpdate) throw new Error('正在准备重启更新，请稍候');
          if (!store.storage.writable && policy.access === 'write') store.assertWritable();
          // Autosaves already scheduled before a dialog opened may still finish safely.
          if (appDialogs.size && !policy.duringDialog) throw new Error('请先完成当前确认');
          trackedOperation = policy.tracked;
          if (trackedOperation) activeOperations++;
          const invoke = () => ipcHandlers[method as keyof ApiMap](...args);
          const execute = async () => {
            const projectId =
              policy.workspace === 'project'
                ? (args[0] as string)
                : policy.workspace === 'checkpoint'
                  ? store.session(args[0] as string).projectId
                  : undefined;
            if (projectId) {
              const root = store.project(projectId).path;
              return service.inWorkspace(root, true, async () => {
                await assertWorkspaceTerminalsClosed(root);
                return invoke();
              });
            }
            if (policy.workspace === 'session') {
              const id = args[0] as string;
              await protectSessionOperation(method, args);
              return inSessionWorkspace(id, invoke);
            }
            return invoke();
          };
          if (policy.configuration) {
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
