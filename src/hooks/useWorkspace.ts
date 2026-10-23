import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppState, Changes, FileDiff, FilePreview, Project, Runtime, Session } from '../../shared/types';
import type { CheckpointPreview, CheckpointSummary } from '../../shared/checkpoints';
import { parseAttachmentSpec } from '../../shared/attachments';

const api = window.desktop;
interface WorkspaceOptions {
  state: AppState | undefined;
  selected: Session | undefined;
  project: Project | undefined;
  runtime: Runtime;
  ownRunning: boolean;
  setInspector: Dispatch<SetStateAction<boolean>>;
  attempt: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  action: (fn: () => Promise<unknown>) => Promise<void>;
  setNotice: (value: string) => void;
}

export function useWorkspace(options: WorkspaceOptions) {
  const { selected, project, runtime, ownRunning, setInspector, attempt, action, setNotice } = options;
  const [tab, setTab] = useState<'changes' | 'files' | 'output'>('changes');
  const [changeMode, setChangeMode] = useState<'all' | 'run'>('all');
  const [changes, setChanges] = useState<Changes>();
  const [selectedFile, setSelectedFile] = useState('');
  const [filePreview, setFilePreview] = useState<FilePreview>();
  const [fileDiff, setFileDiff] = useState<FileDiff>();
  const [split, setSplit] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [checkpointId, setCheckpointId] = useState('');
  const [previewStale, setPreviewStale] = useState(false);
  const [previewRange, setPreviewRange] = useState<{ startLine: number; endLine: number }>();
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [checkpointPreview, setCheckpointPreview] = useState<CheckpointPreview>();
  const [checkpointRestoredCount, setCheckpointRestoredCount] = useState<number>();
  const generation = useRef(0),
    refreshGeneration = useRef(0);
  const diffRequest = useRef<string | undefined>(undefined);
  const previewRevision = useRef(0);
  function cancelDiff() {
    if (!diffRequest.current) return;
    const id = diffRequest.current;
    diffRequest.current = undefined;
    void api.invoke('cancelDiff', id).catch(() => {});
  }
  async function requestDiff(projectId: string, relative: string, mode: 'all' | 'run') {
    cancelDiff();
    const id = crypto.randomUUID();
    diffRequest.current = id;
    try {
      return await api.invoke('diff', projectId, relative, mode, context(), id);
    } finally {
      if (diffRequest.current === id) diffRequest.current = undefined;
    }
  }
  const focused = useRef(document.hasFocus()),
    loading = useRef(false),
    reloadRequested = useRef(false);
  const latest = useRef({ ...options, tab, changeMode, selectedFile, checkpointId, filePreview, fileDiff });
  latest.current = { ...options, tab, changeMode, selectedFile, checkpointId, filePreview, fileDiff };
  const context = () =>
    latest.current.selected
      ? { sessionId: latest.current.selected.id, checkpointId: latest.current.checkpointId || undefined }
      : undefined;
  const updateCheckpoints = (value: CheckpointSummary[]) =>
    setCheckpoints((previous) => (JSON.stringify(previous) === JSON.stringify(value) ? previous : value));

  async function refreshChanges() {
    const current = latest.current;
    if (!current.project) return;
    if (loading.current) {
      reloadRequested.current = true;
      return;
    }
    const token = ++refreshGeneration.current;
    loading.current = true;
    await current.attempt(async () => {
      const value = await api.invoke('changes', current.project!.id, current.changeMode, context());
      if (
        token === refreshGeneration.current &&
        latest.current.project?.id === current.project!.id &&
        latest.current.selected?.id === current.selected?.id &&
        latest.current.checkpointId === current.checkpointId &&
        latest.current.changeMode === current.changeMode
      ) {
        setChanges(value);
        updateCheckpoints(value.checkpoints);
      }
    });
    loading.current = false;
    if (reloadRequested.current) {
      reloadRequested.current = false;
      void refreshChanges();
    }
  }

  async function refreshCheckpoints() {
    const current = latest.current;
    if (!current.selected?.projectId) {
      updateCheckpoints([]);
      return [];
    }
    const value = await current.attempt(() => api.invoke('checkpoints', current.selected!.id));
    if (value && latest.current.selected?.id === current.selected.id) updateCheckpoints(value);
    return value ?? [];
  }

  async function readPreview(refresh: boolean) {
    const current = latest.current;
    if (!current.project || !current.selectedFile) return;
    // A focus/watcher check must not cancel the initial preview and leave its loader behind.
    if (!refresh && diffRequest.current) return;
    const token = ++generation.current;
    const revision = previewRevision.current;
    const valid = () =>
      token === generation.current &&
      latest.current.project?.id === current.project!.id &&
      latest.current.selected?.id === current.selected?.id &&
      latest.current.selectedFile === current.selectedFile &&
      latest.current.tab === current.tab &&
      latest.current.changeMode === current.changeMode &&
      latest.current.checkpointId === current.checkpointId;
    if (current.tab === 'changes') {
      const value = await current.attempt(() =>
        requestDiff(current.project!.id, current.selectedFile, current.changeMode),
      );
      if (!value || !valid()) return;
      if (refresh) {
        setFileDiff(value);
        setPreviewStale(revision !== previewRevision.current);
      } else
        setPreviewStale(
          revision !== previewRevision.current ||
            value.before !== current.fileDiff?.before ||
            value.after !== current.fileDiff?.after ||
            value.unavailable !== current.fileDiff?.unavailable,
        );
    } else if (current.tab === 'files') {
      const value = await current.attempt(() =>
        api.invoke('preview', current.project!.id, current.selectedFile),
      );
      if (!value || !valid()) {
        if (!value && valid()) setPreviewStale(true);
        return;
      }
      if (refresh) {
        setFilePreview(value);
        setPreviewStale(revision !== previewRevision.current);
      } else
        setPreviewStale(
          revision !== previewRevision.current ||
            value.text !== current.filePreview?.text ||
            value.size !== current.filePreview?.size ||
            value.binary !== current.filePreview?.binary,
        );
    }
  }

  async function inspectFile(name: string, mode: typeof tab = latest.current.tab) {
    const current = latest.current;
    if (!current.project) return;
    await current.attempt(async () => {
      const spec = parseAttachmentSpec(name);
      const normalized = spec.path.replaceAll('\\', '/'),
        prefix = current.project!.path.replaceAll('\\', '/') + '/';
      const insensitive = api.platform === 'win32' || api.platform === 'darwin';
      const withinProject = insensitive
        ? normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
        : normalized.startsWith(prefix);
      const relative = withinProject ? normalized.slice(prefix.length) : normalized;
      const token = ++generation.current;
      const revision = previewRevision.current;
      cancelDiff();
      setInspector(true);
      setSelectedFile(relative);
      setTab(mode);
      setFileDiff(undefined);
      setFilePreview(undefined);
      setPreviewStale(false);
      setPreviewRange(spec.startLine ? { startLine: spec.startLine, endLine: spec.endLine! } : undefined);
      const sessionId = current.selected?.id;
      if (mode === 'changes') {
        const value = await requestDiff(current.project!.id, relative, current.changeMode);
        if (token === generation.current && latest.current.selected?.id === sessionId) {
          setFileDiff(value);
          setPreviewStale(revision !== previewRevision.current);
        }
      } else {
        const value = await api.invoke('preview', current.project!.id, relative);
        if (token === generation.current && latest.current.selected?.id === sessionId) setFilePreview(value);
      }
    });
  }

  useEffect(() => {
    generation.current++;
    refreshGeneration.current++;
    setSelectedFile('');
    setFilePreview(undefined);
    setFileDiff(undefined);
    setPreviewStale(false);
    setPreviewRange(undefined);
    setCheckpointId('');
    setCheckpoints([]);
    setCheckpointPreview(undefined);
    setCheckpointRestoredCount(undefined);
    if (!project) setChanges(undefined);
    return () => {
      generation.current++;
      cancelDiff();
    };
  }, [selected?.id, project?.id]);

  const lastUserTimestamp =
    runtime.sessionId === selected?.id
      ? runtime.messages.findLast((message) => message.role === 'user')?.timestamp
      : undefined;
  useEffect(() => {
    void refreshChanges();
  }, [project?.id, selected?.id, changeMode, checkpointId, lastUserTimestamp]);
  useEffect(() => {
    if (latest.current.tab !== 'changes' || !latest.current.selectedFile) return;
    generation.current++;
    setFileDiff(undefined);
    setPreviewStale(false);
    void readPreview(true);
  }, [changeMode, checkpointId]);
  useEffect(() => {
    const checkPreview = () => {
      if (latest.current.selectedFile) void readPreview(false);
    };
    const onFocus = () => {
      focused.current = true;
      if (latest.current.project) {
        void refreshChanges();
        checkPreview();
      }
    };
    const onBlur = () => {
      focused.current = false;
    };
    const onVisibility = () => {
      if (!document.hidden && focused.current) onFocus();
    };
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== 'workspaceChanged' || event.projectId !== latest.current.project?.id) return;
      setWorkspaceRevision((value) => value + 1);
      const previewAffected =
        !event.changedPaths ||
        event.changedPaths.some((name) => name === latest.current.selectedFile || name.startsWith('.git/'));
      if (previewAffected) previewRevision.current++;
      if ((!document.hidden && focused.current) || latest.current.ownRunning) {
        void refreshChanges();
        if (previewAffected) checkPreview();
      } else if (previewAffected && latest.current.selectedFile) setPreviewStale(true);
    });
    const timer = setInterval(() => {
      if ((!document.hidden && focused.current) || latest.current.ownRunning) void refreshChanges();
    }, 60_000);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  async function openCheckpoint(timestamp: number) {
    const current = latest.current;
    if (!current.selected) return;
    await current.attempt(async () => {
      const list = await refreshCheckpoints(),
        target = list.find((checkpoint) => checkpoint.timestamp === timestamp);
      if (!target) throw new Error('这条消息的检查点已经清理，无法撤销');
      const preview = await api.invoke('checkpointPreview', current.selected!.id, target.id);
      if (latest.current.selected?.id !== current.selected!.id) return;
      setCheckpointRestoredCount(undefined);
      setCheckpointPreview(preview);
    });
  }
  async function revert(only: string[] | null) {
    const current = latest.current;
    if (!current.project || !current.selected) return;
    await current.attempt(async () => {
      const list = await refreshCheckpoints();
      const target = current.checkpointId
        ? list.find((checkpoint) => checkpoint.id === current.checkpointId)
        : list.at(-1);
      if (target) {
        const preview = await api.invoke('checkpointPreview', current.selected!.id, target.id);
        if (latest.current.selected?.id !== current.selected!.id) return;
        setCheckpointRestoredCount(undefined);
        setCheckpointPreview(
          only ? { ...preview, files: preview.files.filter((file) => only.includes(file.path)) } : preview,
        );
      } else
        await current.action(async () => {
          const reverted = await api.invoke('revertChanges', current.project!.id, only, {
            sessionId: current.selected!.id,
          });
          if (reverted.length) {
            current.setNotice(`已撤销 ${reverted.length} 个文件的修改`);
            await refreshChanges();
            setSelectedFile('');
            setFileDiff(undefined);
          }
        });
    });
  }
  async function confirmCheckpoint(paths: string[], revision: string) {
    if (!checkpointPreview || !selected) return;
    const preview = checkpointPreview,
      sessionId = selected.id;
    await action(async () => {
      const restored = await api.invoke('revertCheckpoint', sessionId, preview.id, paths, revision);
      if (latest.current.selected?.id !== sessionId) return;
      setCheckpointRestoredCount(restored.length);
      setNotice(`已把 ${restored.length} 个文件恢复到第 ${preview.turn} 轮之前`);
      setSelectedFile('');
      setFileDiff(undefined);
      setFilePreview(undefined);
      setPreviewStale(false);
      await refreshChanges();
    });
  }
  async function returnToCheckpointMessage() {
    if (!checkpointPreview?.timestamp || !selected) return;
    await action(async () => {
      await api.invoke('messageAction', selected.id, 'edit', 'user', checkpointPreview.timestamp!);
      setCheckpointPreview(undefined);
      setNotice('已回到这条消息之前，原内容保留在会话树中');
    });
  }
  function saveInspectorSplit(value: number) {
    void attempt(() => api.invoke('saveSettings', { inspectorSplit: Math.max(15, Math.min(70, value)) }));
  }
  function selectTab(value: typeof tab) {
    generation.current++;
    cancelDiff();
    setTab(value);
    setSelectedFile('');
    setFilePreview(undefined);
    setFileDiff(undefined);
    setPreviewStale(false);
    setPreviewRange(undefined);
    setInspector(true);
  }
  return {
    tab,
    setTab,
    selectTab,
    changeMode,
    setChangeMode,
    changes,
    setChanges,
    selectedFile,
    setSelectedFile,
    filePreview,
    setFilePreview,
    fileDiff,
    setFileDiff,
    split,
    setSplit,
    checkpoints,
    checkpointId,
    setCheckpointId,
    previewStale,
    refreshPreview: () => readPreview(true),
    workspaceRevision,
    previewRange,
    inspectFile,
    revert,
    saveInspectorSplit,
    checkpointPreview,
    checkpointRestoredCount,
    openCheckpoint,
    confirmCheckpoint,
    closeCheckpoint: () => setCheckpointPreview(undefined),
    returnToCheckpointMessage,
    refreshChanges,
    diffLines: useMemo(() => fileDiff?.patch.split('\n') ?? [], [fileDiff]),
  };
}
