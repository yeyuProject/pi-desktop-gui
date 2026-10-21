import { useRuntime } from './useRuntime';
import { useDraft } from './useDraft';
import { useShortcuts } from './useShortcuts';
import { useWorkspace } from './useWorkspace';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { builtinCommands } from '../lib/commands';
import {
  busy,
  messageText,
  type Session,
  type Message,
  type ToolActivity,
  type Settings,
  type ContentBlock,
  type MessageAction,
} from '../../shared/types';

import { readableError } from '../lib/format';
import { hideRecoveredErrors } from '../lib/conversation-layout';
import { PI_SOURCE_URL } from '../../shared/pi-version';

import { useFocusScope } from './useFocusScope';
import { type MessageContext } from '../components/conversation/ChatMessage';
const api = window.desktop;
const noTools: ToolActivity[] = [];
const noMessages: Message[] = [];
export function useWorkbench() {
  const [history, setHistory] = useState<{ sessionId: string; messages: Message[] }>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(false),
    [settingsTab, setSettingsTab] = useState('environment'),
    [prefs, setPrefs] = useState<Settings>();
  const {
    state,
    stateRevision = 0,
    receivedState,
    receiveState,
    runtime,
    anyRunning,
    environment,
    setEnvironment,
    storage,
    update,
  } = useRuntime(setError, setPrefs);
  const [pendingSessions, setPendingSessions] = useState<Record<string, number>>({});
  const [selectionTransition, setSelectionTransition] = useState<{
    request: number;
    revision?: number;
    error?: string;
  }>();
  const [featureTab, setFeatureTab] = useState('');
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('pi.sidebar') !== 'hidden'),
    [compact, setCompact] = useState(false),
    [inspector, setInspector] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]),
    [messageLimit, setMessageLimit] = useState(80),
    [newContent, setNewContent] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false),
    [searchQuery, setSearchQuery] = useState(''),
    [rename, setRename] = useState<{ kind: 'project' | 'session'; id: string; name: string }>(),
    [menuId, setMenuId] = useState('');
  const [seenNotification, setSeenNotification] = useState(Number.MAX_SAFE_INTEGER),
    [dismissed, setDismissed] = useState<number[]>([]),
    [, setTick] = useState(0);
  const [testResult, setTestResult] = useState(''),
    [diagnostic, setDiagnostic] = useState(''),
    [elapsed, setElapsed] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false),
    [dragging, setDragging] = useState(false);

  const thread = useRef<HTMLDivElement>(null),
    columns = useRef<HTMLDivElement>(null),
    inspectorPanel = useRef<HTMLElement>(null),
    autoScroll = useRef(true),
    stateRef = useRef(state),
    runtimeRef = useRef(runtime);
  const selectionRequest = useRef(0);
  const renderedSelectionRequest = selectionRequest.current;
  stateRef.current = state;
  runtimeRef.current = runtime;
  const selected = state?.sessions.find((s) => s.id === state.selectedSessionId),
    project = state?.projects.find((p) => p.id === state.selectedProjectId);
  const pending = Boolean(pendingSessions[selected?.id ?? '']);
  // Confirm current main state, then wait for that snapshot or a newer revision
  // to commit. Operation result IDs do not determine the selected session.
  const selectionChanging = Boolean(
    selectionTransition &&
    (selectionTransition.revision === undefined ||
      stateRevision < selectionTransition.revision ||
      stateRevision < (receivedState?.current.revision ?? stateRevision)),
  );
  useEffect(() => {
    if (selectionTransition && !selectionChanging)
      setSelectionTransition((current) =>
        current?.request === selectionTransition.request ? undefined : current,
      );
  }, [selectionTransition, selectionChanging]);
  function beginSelection() {
    const request = ++selectionRequest.current;
    setSelectionTransition({ request });
    return request;
  }
  async function settleSelection(request: number) {
    if (request !== selectionRequest.current) return false;
    try {
      const confirmed = await api.invoke('navigationState');
      if (request !== selectionRequest.current) return false;
      receiveState(confirmed.state, confirmed.revision);
      setSelectionTransition({ request, revision: confirmed.revision });
      return true;
    } catch (error) {
      if (request === selectionRequest.current)
        setSelectionTransition({
          request,
          error: `无法确认当前会话，请重新选择会话。${readableError(error)}`,
        });
      return false;
    }
  }
  const error = selectionTransition?.error ?? errors[selected?.id ?? ''] ?? errors[''] ?? '';
  function setError(value: string, id = selected?.id ?? '') {
    setErrors((previous) => ({ ...previous, '': '', [id]: value }));
  }
  function setPending(value: boolean, id = selected?.id ?? '') {
    setPendingSessions((previous) => ({
      ...previous,
      [id]: Math.max(0, (previous[id] ?? 0) + (value ? 1 : -1)),
    }));
  }
  const sessionEnabled =
    !selectionChanging &&
    storage.writable &&
    (!runtime.crash || runtime.crash.cleanup === 'confirmed') &&
    Boolean(selected && (!selected.projectId || project?.trusted));
  const ownRuntime = runtime.sessionId === selected?.id,
    running = busy(runtime.status),
    ownRunning = ownRuntime && running;
  const modelLocked = !sessionEnabled || !runtime.models.length || (pending && !running);
  const draftState = useDraft({
    state,
    stateRef,
    selected,
    project,
    runtime,
    compact,
    inspector,
    setInspector,
    attempt,
    setError,
    setNotice,
  });
  const {
    draft,
    attachments,
    images,
    sendMode,
    setSendMode,
    fileQuery,
    setFileQuery,
    fileResults,
    setFileResults,
    commandIndex,
    setCommandIndex,
    setHideCommands,
    recall,
    input,
    commandList,
    commandOptions,
    activeCommand,
    completeCommand,
    persistDraft,
    onDraft,
    focusComposer,
    addAttachment,
    chooseImages,
    acceptDrop,
    composeDraft,
    snippets,
  } = draftState;
  const workspace = useWorkspace({
    state,
    selected,
    project,
    runtime,
    ownRunning,
    setInspector,
    attempt,
    action,
    setNotice,
  });
  const { tab, setTab, inspectFile, checkpoints, openCheckpoint } = workspace;
  const [checkpointRevision, setCheckpointRevision] = useState(0);
  useEffect(() => {
    setCheckpointRevision((value) => value + 1);
  }, [checkpoints]);
  const messages = useMemo(
    () =>
      hideRecoveredErrors(
        ownRuntime && (runtime.connected || runtime.messages.length)
          ? runtime.messages
          : history?.sessionId === selected?.id
            ? (history?.messages ?? noMessages)
            : noMessages,
      ),
    [ownRuntime, runtime.connected, runtime.messages, history, selected?.id],
  );
  const approvals = runtime.dialogs.filter((d) => d.approval);
  const prompts = runtime.dialogs.filter((d) => !d.approval);
  const lastAssistant = messages.findLast((m) => m.role === 'assistant');
  const actionsLocked = pending || running || !sessionEnabled;
  const visibleMessages = messages.slice(-messageLimit);
  const sentPrompts = messages
    .filter((m) => m.role === 'user')
    .map((m) => {
      const t = messageText(m),
        cut = t.indexOf('\n\n<project_file path=');
      return (cut < 0 ? t : t.slice(0, cut)).trim();
    })
    .filter((t, i, all) => t && t !== all[i - 1]);

  useFocusScope(inspectorPanel, inspector && compact, () => setInspector(false));
  async function attempt<T>(fn: () => Promise<T>, sessionId = selected?.id ?? ''): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      setError(readableError(e), sessionId);
      return undefined;
    }
  }
  async function action(fn: () => Promise<unknown>, sessionId = selected?.id ?? '') {
    setPending(true, sessionId);
    try {
      await attempt(fn, sessionId);
    } finally {
      setPending(false, sessionId);
    }
  }

  useEffect(() => {
    localStorage.setItem('pi.sidebar', sidebar ? 'visible' : 'hidden');
    if (!sidebar && document.activeElement?.closest('.sidebar')) {
      document.querySelector<HTMLButtonElement>('[aria-controls="project-sidebar"]')?.focus();
    }
  }, [sidebar]);
  useEffect(() => {
    if (!columns.current) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 900));
    observer.observe(columns.current);
    return () => observer.disconnect();
  }, [Boolean(state)]);

  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.platform = api.platform;
    document.documentElement.style.setProperty('--font-scale', String(state.settings.fontScale));
    document.documentElement.style.setProperty('--sidebar-width', state.settings.sidebarWidth + 'px');
    document.documentElement.style.setProperty('--inspector-width', state.settings.inspectorWidth + 'px');
  }, [state?.settings]);

  useEffect(() => {
    document.title = runtime.title || 'Pi Desktop';
  }, [runtime.title]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    recall.current = -1;
    setHistory({ sessionId: selected.id, messages: [] });
    setFileQuery(null);
    setFileResults([]);
    if (!selected.projectId) setInspector(false);
    setMessageLimit(80);
    setExpanded(selected.expandedTools ?? []);
    autoScroll.current = !(selected.scrollTop && selected.scrollTop > 0);
    api
      .invoke('readHistory', selected.id)
      .then((m) => {
        if (active) setHistory({ sessionId: selected.id, messages: m });
      })
      .catch((e) => {
        if (active) setError(readableError(e), selected.id);
      });
    const timer = setTimeout(() => {
      if (thread.current) thread.current.scrollTop = selected.scrollTop ?? thread.current.scrollHeight;
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected?.id]);
  useLayoutEffect(() => {
    if (!thread.current) return;
    if (autoScroll.current) {
      thread.current.scrollTop = thread.current.scrollHeight;
      setNewContent(false);
    } else setNewContent(true);
  }, [messages, runtime.tools]);
  useEffect(() => {
    const timer = setInterval(
      () => setElapsed(runtime.startedAt ? Math.floor((Date.now() - runtime.startedAt) / 1000) : 0),
      1000,
    );
    return () => clearInterval(timer);
  }, [runtime.startedAt]);

  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 3500);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    if (!menuId) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.context-menu') && !target.closest('[aria-expanded="true"]')) setMenuId('');
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuId('');
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuId]);

  const toasts = (runtime.notifications ?? []).filter(
    (n) => n.id > seenNotification && !dismissed.includes(n.id),
  );
  useEffect(() => {
    const timers = toasts
      .filter((n) => n.level !== 'error')
      .map((n) =>
        setTimeout(() => setDismissed((v) => [...v, n.id].slice(-20)), n.level === 'warning' ? 9000 : 5000),
      );
    return () => timers.forEach(clearTimeout);
  }, [toasts.map((n) => n.id).join(',')]);
  useEffect(() => {
    setSeenNotification(Math.max(0, ...(runtime.notifications ?? []).map((n) => n.id)));
    setDismissed([]);
  }, [runtime.sessionId]);
  useEffect(() => {
    if (runtime.status !== 'retrying' || !runtime.retry) return;
    const timer = setInterval(() => setTick((v) => v + 1), 500);
    return () => clearInterval(timer);
  }, [runtime.status, runtime.retry?.startedAt]);

  async function send() {
    if (!environment?.supported) {
      setError(environment?.errors.join('\n') || '正在检测 Pi 运行环境，请稍候');
      return;
    }
    if (!storage.writable) {
      setError(storage.problem ?? '本地数据不可写，请检查目录权限后重新启动');
      return;
    }
    const sent = composeDraft();
    if (!selected || (!sent.trim() && !images.length) || pending) return;
    setError('');
    setPending(true);
    await attempt(async () => {
      if (await handleBuiltin(sent)) {
        await api.invoke('consumeDraft', selected.id, sent);
        setHideCommands(true);
      } else if (/^\/\/\S/.test(sent)) {
        await api.invoke('send', selected.id, sent.slice(1), attachments, sendMode, images);
        await api.invoke('consumeDraft', selected.id, sent);
      } else await api.invoke('send', selected.id, sent, attachments, sendMode, images);
    });
    setPending(false);
    autoScroll.current = true;
    input.current?.focus();
  }
  async function handleBuiltin(value: string) {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value.trim());
    if (!match || !selected || !builtinCommands.some((c) => c.name === match[1])) return false;
    if (images.length || attachments.length) throw new Error('桌面命令不能附带附件，请先移除附件');
    const [_, cmd, arg = ''] = match;
    if (['tree', 'fork'].includes(cmd)) setFeatureTab('tree');
    else if (cmd === 'find') {
      if (compact) setInspector(false);
      window.dispatchEvent(new CustomEvent('pi:find'));
    } else if (cmd === 'new') await createSession(selected.projectId);
    else if (cmd === 'resume') setSearchOpen(true);
    else if (cmd === 'name') {
      if (arg) await api.invoke('renameSession', selected.id, arg);
      else setRename({ kind: 'session', id: selected.id, name: selected.title });
    } else if (cmd === 'clone') await api.invoke('branchSession', selected.id, 'clone');
    else if (cmd === 'compact') {
      const r = await api.invoke('compact', selected.id, arg);
      setNotice('压缩完成：' + r.tokensBefore + ' tokens');
    } else if (cmd === 'session') setFeatureTab('session');
    else if (cmd === 'settings' || cmd === 'scoped-models') setFeatureTab('settings');
    else if (cmd === 'login' || cmd === 'logout') setFeatureTab('providers');
    else if (cmd === 'config') setFeatureTab('resources');
    else if (cmd === 'mcp') {
      if (arg) {
        await api.invoke('send', selected.id, value, [], 'steer');
      } else setFeatureTab('mcp');
    } else if (cmd === 'reload') {
      await api.invoke('reloadPi', selected.id);
      setNotice('已重新加载');
    } else if (cmd === 'model' || cmd === 'thinking') openSettings('models');
    else if (cmd === 'copy') {
      await api.invoke(
        'copy',
        messageText(messages.findLast((m) => m.role === 'assistant') ?? { content: '' }),
      );
      setNotice('最后回复已复制');
    } else if (cmd === 'import') await api.invoke('importSession', selected.projectId);
    else if (cmd === 'export')
      await api.invoke('exportSession', selected.id, arg === 'jsonl' ? 'jsonl' : 'html');
    else if (cmd === 'share') {
      const url = await api.invoke('shareSession', selected.id);
      if (url) setNotice('链接已复制：' + url);
    } else if (cmd === 'terminal') await api.invoke('openPiTerminal', selected.id);
    else if (cmd === 'quit') await api.invoke('quit');
    else if (cmd === 'trust') {
      if (project) await api.invoke('trustProject', project.id);
    } else if (cmd === 'bug') openSettings('diagnostic');
    else if (cmd === 'hotkeys') setShortcutsOpen(true);
    else if (cmd === 'changelog') await api.invoke('openLink', PI_SOURCE_URL + '/CHANGELOG.md');
    else setFeatureTab('help');
    return true;
  }

  async function addProject() {
    await action(async () => {
      const p = await api.invoke('addProject');
      if (p) setNotice('项目已添加');
    });
  }
  async function selectSession(s: Session) {
    const request = beginSelection();
    setSearchOpen(false);
    setError('', s.id);
    setPending(true, s.id);
    try {
      // The selected-ID effect owns history; late IPC replies cannot replace it.
      await api.invoke('selectSession', s.id);
      await settleSelection(request);
    } catch (error) {
      if (request === selectionRequest.current) {
        setError(readableError(error), s.id);
        await settleSelection(request);
      }
    } finally {
      setPending(false, s.id);
    }
  }
  async function createSession(projectId?: string) {
    const request = beginSelection();
    const session = await attempt(() => api.invoke('newSession', projectId));
    const confirmed = await settleSelection(request);
    if (session && confirmed && request === selectionRequest.current) focusComposer();
  }
  function openSettings(tabName = 'environment') {
    setPrefs(stateRef.current?.settings);
    setSettingsTab(tabName);
    setSettingsOpen(true);
  }
  async function detect() {
    const e = await attempt(() => api.invoke('detect'));
    if (e) setEnvironment(e);
  }
  async function saveSettings() {
    if (!prefs) return;
    await action(async () => {
      await api.invoke('saveSettings', prefs);
      await detect();
      setNotice('设置已保存');
    });
  }
  function currentModelTarget() {
    // The ref also rejects a captured click before navigation's next React render.
    return Boolean(
      selected &&
      selected.id === stateRef.current?.selectedSessionId &&
      selected.id === (receivedState?.current.state ?? stateRef.current)?.selectedSessionId &&
      renderedSelectionRequest === selectionRequest.current &&
      !selectionChanging &&
      sessionEnabled &&
      !(pending && !ownRunning),
    );
  }
  async function connect() {
    if (!selected || !currentModelTarget() || pending || ownRunning) return;
    setError('');
    await action(() => api.invoke('connect', selected.id));
    void detect();
  }
  async function readModels() {
    if (!selected || !currentModelTarget() || pending || ownRunning) return;
    setError('');
    await action(() => api.invoke('readModels', selected.id));
  }
  async function chooseSettingPath(kind: 'pi' | 'node' | 'agent' | 'editor') {
    const p = await attempt(() => api.invoke('choosePath', kind));
    if (p)
      setPrefs((prev) =>
        prev
          ? {
              ...prev,
              [({ pi: 'piPath', node: 'nodePath', agent: 'agentDir', editor: 'editorPath' } as const)[kind]]:
                p,
            }
          : prev,
      );
  }
  async function setModel(key: string) {
    if (!selected || !currentModelTarget()) return;
    const [provider, modelId] = key.split('::');
    await action(async () => {
      await api.invoke('setSessionModel', selected.id, provider, modelId);
      setPrefs((prev) => (prev ? { ...prev, provider, modelId } : prev));
    });
  }
  async function setThinking(thinking: string) {
    if (!selected || !currentModelTarget()) return;
    setPrefs((prev) => (prev ? { ...prev, thinking } : prev));
    await action(() => api.invoke('setSessionThinking', selected.id, thinking));
  }
  async function copy(value: string, label = '已复制') {
    await attempt(() => api.invoke('copy', value));
    setNotice(label);
  }
  async function rerunCommand(command: string, includeContext: boolean) {
    if (!selected || pending || busy(runtimeRef.current.status) || !sessionEnabled) return;
    if ((ownRuntime ? runtime.approvalMode : selected.approvalMode) === 'readonly') {
      setError('只读模式不能执行命令，请先切换审批模式。');
      return;
    }
    await action(() =>
      api.invoke('send', selected.id, (includeContext ? '!' : '!!') + command, [], 'steer', []),
    );
  }
  function askHunk(attachment: string | undefined, prompt: string) {
    persistDraft(
      draft + (draft ? '\n' : '') + prompt,
      attachment ? [...new Set([...attachments, attachment])] : attachments,
    );
    focusComposer();
  }
  async function messageAction(m: Message, kind: MessageAction) {
    if (!selected || !m.timestamp) return;
    await action(async () => {
      await api.invoke('messageAction', selected.id, kind, m.role as 'user' | 'assistant', m.timestamp!);
      if (kind === 'edit') {
        setNotice('已回到这条消息之前，修改后发送即可；原内容保留在会话树中');
        focusComposer();
      }
      if (kind === 'fork') setNotice('已从这条消息创建分支会话');
    });
    autoScroll.current = true;
  }
  const toggleTool = (id: string, open: boolean) => {
    setExpanded((v) => {
      if (v.includes(id) === open) return v;
      const next = open ? [...new Set([...v, id])] : v.filter((x) => x !== id);
      if (storage.writable && selected)
        void attempt(() => api.invoke('saveView', selected.id, thread.current?.scrollTop ?? 0, next));
      return next;
    });
  };
  const checkpointFor = (message: Message) => {
    const checkpoint = checkpoints.find((item) => item.timestamp === message.timestamp);
    return checkpoint
      ? { turn: checkpoint.turn, disabledReason: checkpoint.available ? undefined : checkpoint.invalidReason }
      : undefined;
  };
  const latest = useRef({
    toggleTool,
    inspectFile,
    copy,
    messageAction,
    rerunCommand,
    askHunk,
    checkpointFor,
    openCheckpoint,
  });
  latest.current = {
    toggleTool,
    inspectFile,
    copy,
    messageAction,
    rerunCommand,
    askHunk,
    checkpointFor,
    openCheckpoint,
  };
  const stableHandlers = useMemo(
    () => ({
      toggleTool: (id: string, open: boolean) => latest.current.toggleTool(id, open),
      openFile: (p: string) => void latest.current.inspectFile(p, 'files'),
      copy: (text: string) => void latest.current.copy(text, '消息已复制'),
      act: (m: Message, kind: MessageAction) => void latest.current.messageAction(m, kind),
      rerun: (command: string, includeContext: boolean) =>
        void latest.current.rerunCommand(command, includeContext),
      askHunk: (attachment: string | undefined, prompt: string) => latest.current.askHunk(attachment, prompt),
      checkpointFor: (message: Message) => latest.current.checkpointFor(message),
      undo: (message: Message) => {
        if (message.timestamp) void latest.current.openCheckpoint(message.timestamp);
      },
    }),
    [],
  );
  const liveTools = ownRuntime ? runtime.tools : noTools;
  const liveToolIdKey = JSON.stringify(liveTools.map((t) => t.id));
  const liveToolIds = useMemo(() => new Set<string>(JSON.parse(liveToolIdKey)), [liveToolIdKey]);
  const historyTools = useRef(new WeakMap<Message, { call: ContentBlock | undefined; tool: ToolActivity }>());
  const toolLookup = useMemo(() => {
    const byId = new Map(liveTools.map((t) => [t.id, t]));
    const calls = new Map<string, ContentBlock>();
    for (const m of messages)
      if (Array.isArray(m.content))
        for (const b of m.content) if (b.type === 'toolCall' && b.id) calls.set(String(b.id), b);
    return (message: Message): ToolActivity => {
      const observed = byId.get(message.toolCallId ?? '');
      if (observed) return observed;
      const call = calls.get(message.toolCallId ?? '');
      const cached = historyTools.current.get(message);
      let t = cached?.tool;
      if (!t || cached?.call !== call) {
        const details = message.details;
        t = {
          id: message.toolCallId ?? '',
          name: message.toolName ?? call?.name ?? 'tool',
          args: call?.arguments ?? {},
          status: message.isError ? 'error' : 'done',
          output: messageText(message),
          startedAt: message.timestamp ?? 0,
          durationMs: typeof message.durationMs === 'number' ? message.durationMs : undefined,
          patch:
            details && typeof details === 'object' && 'patch' in details && typeof details.patch === 'string'
              ? details.patch
              : undefined,
        };
        historyTools.current.set(message, { call, tool: t });
      }
      return t;
    };
  }, [liveTools, messages]);
  const canRerun =
    !actionsLocked && (ownRuntime ? runtime.approvalMode : selected?.approvalMode) !== 'readonly';
  const messageContext: MessageContext = useMemo(
    () => ({
      running: ownRunning,
      locked: actionsLocked,
      expanded,
      liveToolIds,
      toolFor: toolLookup,
      canRerun,
      checkpointRevision,
      ...stableHandlers,
    }),
    [
      ownRunning,
      actionsLocked,
      expanded,
      liveToolIds,
      toolLookup,
      stableHandlers,
      canRerun,
      checkpointRevision,
    ],
  );
  const stopArmed = useShortcuts({
    state,
    selected,
    runtime,
    compact,
    inspector,
    ownRunning,
    createSession,
    openSettings,
    action,
    attempt,
    setSearchOpen,
    setSidebar,
    setShortcutsOpen,
    setInspector,
    setTab,
  });
  return {
    ...workspace,
    ...draftState,
    askHunk,
    rerunCommand,
    update,
    state,
    storage,
    runtime,
    environment,
    history,
    pending,
    selectionChanging,
    selectionRevision: renderedSelectionRequest,
    setFeatureTab,
    compact,
    inspector,
    expanded,
    messageLimit,
    setMessageLimit,
    newContent,
    setNewContent,
    thread,
    autoScroll,
    selected,
    project,
    sessionEnabled,
    ownRuntime,
    running,
    anyRunning,
    modelLocked,
    messages,
    approvals,
    lastAssistant,
    visibleMessages,
    attempt,
    selectSession,
    openSettings,
    connect,
    readModels,
    toggleTool,
    messageContext,
    error,
    setError,
    setNotice,
    elapsed,
    setShortcutsOpen,
    stopArmed,
    dragging,
    setDragging,
    ownRunning,
    sentPrompts,
    send,
    setModel,
    setThinking,
    sidebar,
    setSearchOpen,
    setRename,
    menuId,
    setMenuId,
    addProject,
    createSession,
    setSidebar,
    setInspector,
    inspectorPanel,
    copy,
    notice,
    setDismissed,
    toasts,
    featureTab,
    searchOpen,
    searchQuery,
    setSearchQuery,
    rename,
    shortcutsOpen,
    prompts,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    prefs,
    setPrefs,
    testResult,
    setTestResult,
    diagnostic,
    setDiagnostic,
    action,
    detect,
    saveSettings,
    chooseSettingPath,
    latest,
    columns,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
