import { useWorkbench } from './hooks/useWorkbench';
import { LoaderCircle } from 'lucide-react';
import { Conversation as ConversationView } from './components/Conversation';
import { Sidebar as SidebarView } from './components/Sidebar';
import { WorkspaceHeader as WorkspaceHeaderView } from './components/WorkspaceHeader';
import { Inspector as InspectorView } from './components/Inspector';
import { Toasts as ToastsView } from './components/Toasts';
import { WorkbenchDialogs as WorkbenchDialogsView } from './components/WorkbenchDialogs';
import { Composer as ComposerView } from './components/Composer';
import { StorageBanner } from './components/StorageBanner';
import { Suspense, memo, useEffect, useMemo, useState } from 'react';
import { UpdateBadge } from './components/Updates';
import { ResizeHandle } from './components/ResizeHandle';
import {
  AboutUpdates,
  preloadDialogs,
  SettingsModal,
  CheckpointDialog,
  SideChatPanel,
  UpdateDialog,
  CrashCard,
  AutomaticUpdate,
} from './lib/lazy-dialogs';
const Sidebar = memo(SidebarView);
const WorkspaceHeader = memo(WorkspaceHeaderView);
const Inspector = memo(
  InspectorView,
  (before, after) =>
    before.runtime.sessionId === after.runtime.sessionId &&
    before.runtime.status === after.runtime.status &&
    before.runtime.tools === after.runtime.tools &&
    (Object.keys(before) as (keyof typeof before)[]).every(
      (key) => key === 'runtime' || Object.is(before[key], after[key]),
    ),
);
const Toasts = memo(ToastsView);
const WorkbenchDialogs = memo(WorkbenchDialogsView);
const Composer = memo(ComposerView);
const Conversation = memo(ConversationView);
function pick<T, K extends keyof T>(model: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, model[key]])) as Pick<T, K>;
}
export default function App() {
  useEffect(() => {
    const idle = window.requestIdleCallback(() => preloadDialogs());
    return () => window.cancelIdleCallback(idle);
  }, []);
  const model = useWorkbench();
  const [updateOpen, setUpdateOpen] = useState(false);
  const { state, compact, columns, error } = model;
  useEffect(() => {
    if (!state) return;
    const frame = requestAnimationFrame(() => {
      void window.desktop.invoke('rendererReady').catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [Boolean(state)]);
  const updateBadge = useMemo(
    () => <UpdateBadge updates={model.updates} open={() => setUpdateOpen(true)} />,
    [model.updates],
  );
  const recovery = useMemo(
    () =>
      model.ownRuntime && model.runtime.crash && model.selected ? (
        <Suspense fallback={<p role="status">正在读取中断的任务…</p>}>
          <CrashCard
            key={model.runtime.crash.at}
            crash={model.runtime.crash}
            projectId={model.project?.id}
            sessionId={model.selected.id}
            disabled={model.pending || model.running || !model.storage.writable}
            recover={(prompt) =>
              model.action(() => window.desktop.invoke('recover', model.selected!.id, prompt))
            }
            inspect={() => {
              model.setChangeMode('run');
              model.setTab('changes');
              model.setInspector(true);
            }}
            undo={() => model.revert(null)}
            diagnostic={() => model.openSettings('diagnostic')}
          />
        </Suspense>
      ) : null,
    [
      model.ownRuntime,
      model.runtime.crash,
      model.selected?.id,
      model.project?.id,
      model.pending,
      model.running,
      model.storage.writable,
      model.action,
      model.setChangeMode,
      model.setTab,
      model.setInspector,
      model.revert,
      model.openSettings,
    ],
  );
  if (!state)
    return (
      <main className="loading-screen">
        <div className="brand-mark">π</div>
        <h2>Pi Desktop</h2>
        {error ? (
          <p className="inline-error">{error}</p>
        ) : (
          <p>
            <LoaderCircle size={15} className="spin" /> 正在准备 Pi…
          </p>
        )}
      </main>
    );
  const updateBusy = model.anyRunning || model.pending;
  const installUpdate = async () => {
    await model.flushDraft();
    if (model.selected && model.storage.writable)
      await window.desktop.invoke(
        'saveDraft',
        model.selected.id,
        model.draft,
        model.attachments,
        model.images,
        model.snippets,
      );
    await window.desktop.invoke('installUpdate');
  };
  const updatePanel = (
    <AboutUpdates
      updates={model.updates}
      busy={updateBusy}
      install={installUpdate}
      autoDownload={state.settings.autoDownloadUpdates}
      readOnly={!model.storage.writable}
      saveAutoDownload={async (value) => {
        await window.desktop.invoke('saveSettings', { autoDownloadUpdates: value });
        model.setPrefs((previous) => previous && { ...previous, autoDownloadUpdates: value });
      }}
    />
  );
  const saveWidth = (key: 'sidebarWidth' | 'inspectorWidth' | 'sideChatWidth', width: number) => {
    model.setPrefs((previous) => previous && { ...previous, [key]: width });
    void model.attempt(() => window.desktop.invoke('saveSettings', { [key]: width }));
  };
  return (
    <div className="app-shell">
      <Suspense fallback={null}>
        <AutomaticUpdate
          updates={model.updates}
          busy={updateBusy}
          install={installUpdate}
          flushDraft={model.flushDraft}
        />
      </Suspense>
      <Sidebar
        {...pick(model, [
          'activities',
          'environment',
          'setNotice',
          'sidebar',
          'compact',
          'inspector',
          'setSearchOpen',
          'setRename',
          'menuId',
          'setMenuId',
          'selected',
          'project',
          'attempt',
          'addProject',
          'selectSession',
          'createSession',
          'openSettings',
        ])}
        state={state}
        updateBadge={updateBadge}
      />
      {model.sidebar && !compact && (
        <ResizeHandle
          label="项目侧栏宽度"
          variable="--sidebar-width"
          value={state.settings.sidebarWidth}
          min={180}
          max={360}
          defaultValue={240}
          direction={1}
          save={(width) => saveWidth('sidebarWidth', width)}
        />
      )}
      <main className="workspace">
        <StorageBanner
          storage={model.storage}
          openDirectory={() => void model.attempt(() => window.desktop.invoke('revealData'))}
        />
        <WorkspaceHeader
          {...pick(model, [
            'activities',
            'state',
            'selectSession',
            'setFeatureTab',
            'sidebar',
            'setSidebar',
            'compact',
            'inspector',
            'setInspector',
            'changes',
            'selected',
            'project',
            'ownRuntime',
            'running',
          ])}
        />
        <div ref={columns} className={'workspace-columns' + (compact ? ' compact' : '')}>
          <section className="conversation" inert={model.inspector && compact}>
            <Conversation
              {...pick(model, [
                'storage',
                'runtime',
                'environment',
                'pending',
                'setFeatureTab',
                'expanded',
                'messageLimit',
                'setMessageLimit',
                'newContent',
                'setNewContent',
                'thread',
                'input',
                'autoScroll',
                'selected',
                'project',
                'sessionEnabled',
                'ownRuntime',
                'running',
                'messages',
                'approvals',
                'lastAssistant',
                'visibleMessages',
                'attempt',
                'persistDraft',
                'focusComposer',
                'selectSession',
                'openSettings',
                'connect',
                'openModelPicker',
                'inspectFile',
                'toggleTool',
                'messageContext',
                'addQuote',
                'setNotice',
                'setNoticeAction',
              ])}
              state={state}
              recovery={recovery}
            />
            <Composer
              {...pick(model, [
                'messages',
                'expanded',
                'toggleTool',
                'storage',
                'environment',
                'runtime',
                'error',
                'setError',
                'setNotice',
                'pending',
                'attachmentsPending',
                'selectionChanging',
                'selectionRevision',
                'modelPickerRequest',
                'draft',
                'draftGoal',
                'openGoalComposer',
                'exitGoalMode',
                'editGoal',
                'setGoalBudget',
                'attachments',
                'sendMode',
                'setSendMode',
                'images',
                'setFeatureTab',
                'commandIndex',
                'setCommandIndex',
                'setHideCommands',
                'fileQuery',
                'setFileQuery',
                'fileResults',
                'fileIndex',
                'setFileIndex',
                'fileList',
                'snippets',
                'draftQuotes',
                'removeQuote',
                'pasteText',
                'expandSnippet',
                'removeSnippet',
                'attachmentInfo',
                'attachmentBytes',
                'inputMaxHeight',
                'setInputMaxHeight',
                'setShortcutsOpen',
                'stopArmed',
                'dragging',
                'setDragging',
                'recall',
                'input',
                'commandList',
                'selected',
                'project',
                'sessionEnabled',
                'ownRuntime',
                'running',
                'modelLocked',
                'ownRunning',
                'sentPrompts',
                'commandOptions',
                'activeCommand',
                'completeCommand',
                'attempt',
                'persistDraft',
                'onDraft',
                'addAttachment',
                'send',
                'chooseImages',
                'acceptDrop',
                'openSettings',
                'connect',
                'readModels',
                'setModel',
                'setThinking',
                'inspectFile',
              ])}
              state={state}
            />
          </section>
          {model.sideChat.open && (
            <>
              <ResizeHandle
                label="侧边对话宽度"
                variable="--side-chat-width"
                value={state.settings.sideChatWidth ?? 360}
                min={300}
                max={560}
                defaultValue={360}
                direction={-1}
                save={(width) => saveWidth('sideChatWidth', width)}
              />
              <Suspense fallback={null}>
                <SideChatPanel
                  {...pick(model, ['sideChat', 'runtime', 'selected', 'openSettings', 'connect', 'copy'])}
                />
              </Suspense>
            </>
          )}
          {model.inspector && !compact && (
            <ResizeHandle
              label="文件面板宽度"
              variable="--inspector-width"
              value={state.settings.inspectorWidth}
              min={300}
              max={720}
              defaultValue={380}
              direction={-1}
              save={(width) => saveWidth('inspectorWidth', width)}
            />
          )}
          <Inspector
            {...pick(model, [
              'runtime',
              'pending',
              'compact',
              'inspector',
              'setInspector',
              'tab',
              'setTab',
              'selectTab',
              'changeMode',
              'setChangeMode',
              'changes',
              'setChanges',
              'selectedFile',
              'setSelectedFile',
              'filePreview',
              'setFilePreview',
              'fileDiff',
              'setFileDiff',
              'split',
              'setSplit',
              'inspectorPanel',
              'project',
              'ownRunning',
              'diffLines',
              'attempt',
              'persistDraft',
              'focusComposer',
              'addAttachment',
              'copy',
              'revert',
              'inspectFile',
              'checkpoints',
              'checkpointId',
              'setCheckpointId',
              'previewStale',
              'refreshPreview',
              'workspaceRevision',
              'previewRange',
              'askHunk',
              'rerunCommand',
              'saveInspectorSplit',
            ])}
            state={state}
          />
        </div>
      </main>
      <Toasts {...pick(model, ['notice', 'noticeAction', 'setDismissed', 'setToastsPaused', 'toasts'])} />
      {(model.searchOpen ||
        model.shortcutsOpen ||
        model.rename ||
        model.settingsOpen ||
        model.featureTab ||
        model.runtime.auth ||
        model.prompts.length > 0) && (
        <Suspense fallback={null}>
          <WorkbenchDialogs
            {...pick(model, [
              'runtime',
              'environment',
              'storage',
              'featureTab',
              'setFeatureTab',
              'searchOpen',
              'setSearchOpen',
              'searchQuery',
              'setSearchQuery',
              'rename',
              'setRename',
              'shortcutsOpen',
              'setShortcutsOpen',
              'selected',
              'prompts',
              'onAuthenticated',
              'attempt',
              'selectSession',
            ])}
            state={state}
            settings={
              model.settingsOpen ? (
                <SettingsModal
                  {...pick(model, [
                    'state',
                    'runtime',
                    'environment',
                    'error',
                    'setError',
                    'setNotice',
                    'settingsOpen',
                    'setSettingsOpen',
                    'settingsTab',
                    'setSettingsTab',
                    'prefs',
                    'setPrefs',
                    'pending',
                    'setFeatureTab',
                    'testResult',
                    'setTestResult',
                    'diagnostic',
                    'setDiagnostic',
                    'selected',
                    'sessionEnabled',
                    'running',
                    'modelLocked',
                    'attempt',
                    'action',
                    'detect',
                    'saveSettings',
                    'connect',
                    'chooseSettingPath',
                    'setModel',
                    'setThinking',
                  ])}
                  updatePanel={updatePanel}
                />
              ) : null
            }
          />
        </Suspense>
      )}
      {model.checkpointPreview && (
        <Suspense fallback={null}>
          <CheckpointDialog
            key={model.checkpointPreview.id + model.checkpointPreview.revision}
            preview={model.checkpointPreview}
            pending={model.pending}
            restoredCount={model.checkpointRestoredCount}
            onClose={model.closeCheckpoint}
            onConfirm={(paths, revision) => void model.confirmCheckpoint(paths, revision)}
            onReturnToMessage={() => void model.returnToCheckpointMessage()}
            onUndoRestore={() => void model.undoLastRestore()}
          />
        </Suspense>
      )}
      {updateOpen && (
        <Suspense fallback={null}>
          <UpdateDialog
            updates={model.updates}
            busy={updateBusy}
            install={installUpdate}
            close={() => setUpdateOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
