import { PlanCard } from './conversation/PlanCard';
import { AskPanel } from './conversation/AskPanel';
import { goalCommandPreview } from '../../shared/goal-input';
import { MAX_GOAL_OBJECTIVE_LENGTH } from '../../shared/goal';
import { GoalBudgetPicker } from './GoalBudgetPicker';
import { topLayer } from '../hooks/useLayer';
import {
  ArrowUp,
  ListEnd,
  CornerDownRight,
  Square,
  Search,
  X,
  FileText,
  LoaderCircle,
  Paperclip,
  ImagePlus,
  Target,
} from 'lucide-react';
import { mod } from '../lib/platform';
import { commandSourceNames } from '../lib/commands';
import { IconButton } from './IconButton';
import { ErrorFeedback } from './ErrorFeedback';
import { noticeDuration } from '../lib/notice-store';
import { ComposerFeedback, ComposerFooter } from './conversation/ComposerStatus';
import { ComposerResize } from './conversation/ComposerResize';
import { ModelPicker } from './ModelPicker';
import { ApprovalSwitch } from './Approval';
import { Suspense, useMemo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Lightbox } from '../lib/lazy-dialogs';
import { Modal } from './Modal';
import { SearchHighlight } from './conversation/SearchHighlight';
import { sessionModelState } from '../lib/session-model';
import { PromptArguments } from './conversation/PromptArguments';
import { parseArgumentHint, parsePromptArguments } from '../lib/prompt-arguments';
import { shouldCollapsePaste, textBytes, textLines } from '../lib/draft-snippets';
import type { ModelErrorAction } from '../../shared/errors';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { AppState } from '../../shared/types';
import { quoteLabel } from '../../shared/message-content';
import { GoalCard, useGoalCard } from './conversation/GoalCard';

export type ComposerProps = Pick<
  Workbench,
  | 'state'
  | 'storage'
  | 'environment'
  | 'runtime'
  | 'messages'
  | 'outgoing'
  | 'expanded'
  | 'toggleTool'
  | 'error'
  | 'setError'
  | 'pending'
  | 'attachmentsPending'
  | 'selectionChanging'
  | 'selectionRevision'
  | 'modelPickerRequest'
  | 'draft'
  | 'draftGoal'
  | 'openGoalComposer'
  | 'exitGoalMode'
  | 'editGoal'
  | 'setGoalBudget'
  | 'attachments'
  | 'sendMode'
  | 'setSendMode'
  | 'images'
  | 'setFeatureTab'
  | 'commandIndex'
  | 'setCommandIndex'
  | 'setHideCommands'
  | 'fileQuery'
  | 'setFileQuery'
  | 'fileResults'
  | 'fileIndex'
  | 'setFileIndex'
  | 'fileList'
  | 'snippets'
  | 'draftQuotes'
  | 'removeQuote'
  | 'pasteText'
  | 'expandSnippet'
  | 'removeSnippet'
  | 'attachmentInfo'
  | 'attachmentBytes'
  | 'inputMaxHeight'
  | 'setInputMaxHeight'
  | 'setShortcutsOpen'
  | 'stopArmed'
  | 'dragging'
  | 'setDragging'
  | 'recall'
  | 'input'
  | 'commandList'
  | 'selected'
  | 'project'
  | 'sessionEnabled'
  | 'ownRuntime'
  | 'running'
  | 'modelLocked'
  | 'ownRunning'
  | 'sentPrompts'
  | 'commandOptions'
  | 'activeCommand'
  | 'completeCommand'
  | 'attempt'
  | 'persistDraft'
  | 'onDraft'
  | 'addAttachment'
  | 'send'
  | 'chooseImages'
  | 'acceptDrop'
  | 'openSettings'
  | 'connect'
  | 'readModels'
  | 'setModel'
  | 'setThinking'
  | 'inspectFile'
> & { state: AppState };
/** Running send modes: join the current turn now, or wait until it finishes. */
const sendModes = [
  { mode: 'steer', label: '立即补充', hint: '插入正在进行的这一轮', Icon: CornerDownRight },
  { mode: 'followUp', label: '完成后执行', hint: '排在这一轮结束之后', Icon: ListEnd },
] as const;
export function Composer(props: ComposerProps) {
  const {
    state,
    storage,
    environment,
    runtime,
    setError,
    pending,
    selectionChanging,
    selectionRevision,
    draft,
    draftGoal,
    openGoalComposer,
    exitGoalMode,
    editGoal,
    setGoalBudget,
    attachments,
    sendMode,
    setSendMode,
    images,
    setFeatureTab,
    commandIndex,
    setCommandIndex,
    setHideCommands,
    fileQuery,
    setFileQuery,
    fileResults,
    fileIndex,
    setFileIndex,
    fileList,
    snippets,
    draftQuotes,
    removeQuote,
    pasteText,
    expandSnippet,
    removeSnippet,
    attachmentInfo,
    attachmentBytes,
    inputMaxHeight,
    setInputMaxHeight,
    stopArmed,
    dragging,
    setDragging,
    recall,
    input,
    commandList,
    selected,
    project,
    sessionEnabled,
    ownRuntime,
    running,
    modelLocked,
    ownRunning,
    sentPrompts,
    commandOptions,
    activeCommand,
    completeCommand,
    attempt,
    persistDraft,
    onDraft,
    addAttachment,
    send,
    chooseImages,
    acceptDrop,
    openSettings,
    readModels,
    setModel,
    setThinking,
    inspectFile,
  } = props;
  const modelState = sessionModelState(runtime, selected, state.settings);
  const goal = ownRuntime ? runtime.goal : null;
  const ask = ownRuntime ? runtime.dialogs.find((dialog) => dialog.ask) : undefined;
  const editingGoal = draftGoal?.kind === 'edit';
  const goalPreview = editingGoal || ask ? undefined : goalCommandPreview(draft);
  const goalMode = Boolean(draftGoal || goalPreview);
  const answering = Boolean(ask && !goalMode);
  const goalObjective = goalPreview?.objective ?? draft;
  const goalBudget =
    goalPreview?.tokenBudget ?? (draftGoal?.kind === 'start' ? draftGoal.tokenBudget : undefined);
  const localGoalCommand = /^\s*\/goal(?:\s+edit)?\s*$/.test(draft) && !editingGoal;
  const goalEmpty = goalMode && !localGoalCommand && !goalObjective.trim();
  const goalError =
    goalMode && !localGoalCommand
      ? goalPreview?.error ||
        (goalObjective.length > MAX_GOAL_OBJECTIVE_LENGTH
          ? '目标超过 4000 字，请把要求写进项目文件并引用它'
          : '')
      : '';
  const goalView = useGoalCard(
    goal,
    selected?.id,
    props.expanded,
    props.toggleTool,
    runtime.goalOpenRequest,
    goalMode,
  );
  const connecting = ownRunning && !runtime.connected;
  const openGoal = () => {
    if (!selected || selectionChanging || pending || !sessionEnabled || !storage.writable) return;
    if (!goalMode && goal && goal.status !== 'completed') goalView.reveal();
    else openGoalComposer();
  };
  useEffect(() => {
    if (!goalMode) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || topLayer()) return;
      event.preventDefault();
      event.stopPropagation();
      if (commandOptions.length) setHideCommands(true);
      else if (fileQuery !== null) setFileQuery(null);
      else exitGoalMode();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [goalMode, commandOptions.length, fileQuery, exitGoalMode]);
  const [modelPickerOwner, setModelPickerOwner] = useState<{ sessionId: string; revision: number }>();
  // Ownership hides a stale picker during render; the effect only discards its state.
  const modelPickerOpen = Boolean(
    selected &&
    modelPickerOwner?.sessionId === selected.id &&
    modelPickerOwner.revision === selectionRevision &&
    !selectionChanging,
  );
  const setModelPickerOpen = (open: boolean) =>
    setModelPickerOwner(
      open && selected ? { sessionId: selected.id, revision: selectionRevision } : undefined,
    );
  const modelPickerDisabledReason = selectionChanging
    ? '会话切换中…'
    : !sessionEnabled
      ? project && !project.trusted
        ? '请先启用项目'
        : '当前会话暂不可用'
      : pending && !ownRunning && !modelPickerOpen
        ? '正在处理操作…'
        : '';
  useLayoutEffect(
    () => setModelPickerOpen(false),
    [selected?.id, selectionChanging, modelPickerDisabledReason],
  );
  useEffect(() => {
    if (props.modelPickerRequest) setModelPickerOpen(true);
  }, [props.modelPickerRequest]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null),
    [snippetId, setSnippetId] = useState('');
  const [parameterError, setParameterError] = useState('');
  const [approvalFeedback, setApprovalFeedback] = useState<{ text: string }>();
  useEffect(() => {
    if (!approvalFeedback) return;
    const timer = setTimeout(() => setApprovalFeedback(undefined), noticeDuration(approvalFeedback.text));
    return () => clearTimeout(timer);
  }, [approvalFeedback]);
  const parameterPick = useRef<((path: string) => void) | null>(null);
  useEffect(() => {
    setParameterError('');
    parameterPick.current = null;
  }, [selected?.id, activeCommand?.name]);
  const selectFile = (file: string) => {
    if (props.attachmentsPending) return;
    if (parameterPick.current) {
      parameterPick.current(file);
      parameterPick.current = null;
      setFileQuery(null);
    } else void addAttachment(file);
  };
  const fileKey = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (fileQuery === null || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (fileResults.length)
        setFileIndex(
          (index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + fileResults.length) % fileResults.length,
        );
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setFileQuery(null);
      parameterPick.current = null;
      return true;
    }
    if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) {
      event.preventDefault();
      if (fileResults[fileIndex]) selectFile(fileResults[fileIndex]);
      return true;
    }
    return false;
  };
  const sendComposer = () => {
    if (
      goalEmpty ||
      Boolean(goalError) ||
      props.attachmentsPending ||
      selectionChanging ||
      !sessionEnabled ||
      pending ||
      runtime.status === 'stopping'
    )
      return;
    if (answering) {
      void send();
      return;
    }
    if (fileQuery !== null) {
      if (fileResults[fileIndex]) selectFile(fileResults[fileIndex]);
      return;
    }
    if (parameterError) {
      setError(parameterError);
      return;
    }
    if (activeCommand?.source === 'prompt' && activeCommand.argumentHint) {
      const values = parsePromptArguments(
        draft.slice(activeCommand.prefix.length + activeCommand.name.length).trim(),
      );
      const missing = parseArgumentHint(activeCommand.argumentHint).find(
        (field, index) => field.required && !values[index],
      );
      if (missing) {
        setError(`请填写模板参数：${missing.label}`);
        return;
      }
    }
    void send();
  };
  const snippet = snippets.find((item) => item.id === snippetId);
  const attachmentSizes = useMemo(
    () => [
      ...attachmentInfo.map((info) => ({ name: info.spec, bytes: info.bytes })),
      ...snippets.map((item) => ({ name: '粘贴片段', bytes: textBytes(item.text) })),
      ...draftQuotes.map((item) => ({ name: '对话引用', bytes: textBytes(item.text) })),
    ],
    [attachmentInfo, snippets, draftQuotes],
  );
  const largest = useMemo(
    () =>
      [...attachmentSizes, { name: '草稿正文', bytes: textBytes(draft) }].sort(
        (a, b) => b.bytes - a.bytes,
      )[0],
    [attachmentSizes, draft],
  );
  const sessionDisabledReason = selectionChanging
    ? '正在切换会话，稍等一下'
    : !storage.writable
      ? '本地数据暂时无法保存，请先处理上方的存储提示'
      : !selected
        ? '请先新建或选择一个会话'
        : runtime.crash && runtime.crash.cleanup !== 'confirmed'
          ? '上次的命令可能还在运行，结束它们并重启应用后才能继续'
          : !sessionEnabled
            ? '这个项目还没启用，先点上方“启用项目”'
            : '';
  const sendDisabledReason =
    sessionDisabledReason ||
    (!localGoalCommand && !environment?.supported && !runtime.connected
      ? 'Pi 还没准备好，先完成开始前检查'
      : runtime.status === 'stopping'
        ? '正在停止，稍等一下'
        : pending
          ? '上一个操作还没完成'
          : props.attachmentsPending
            ? '附件还在读取'
            : !editingGoal && attachmentBytes > 1024 * 1024
              ? `内容超过 1 MiB，请移除“${largest.name}”或改为按行引用`
              : goalEmpty
                ? '请填写目标'
                : goalError ||
                  (!answering && parameterError) ||
                  (!draft.trim() && !images.length && !snippets.length && !draftQuotes.length
                    ? '先输入内容'
                    : ''));
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Floating controls above the input (「回到最新」) follow the composer's real height:
    // feedback cards, Goal and plan cards and a resized textarea all push its top up.
    const composer = wrap.current;
    const container = composer?.closest<HTMLElement>('.conversation');
    if (!composer || !container) return;
    const measure = () =>
      container.style.setProperty(
        '--composer-offset',
        `${Math.max(0, container.getBoundingClientRect().bottom - composer.getBoundingClientRect().top)}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      container.style.removeProperty('--composer-offset');
    };
  }, []);
  const sendLabel = answering
    ? '发送回答'
    : editingGoal
      ? '保存修改'
      : goalMode && !localGoalCommand
        ? '开始 Goal'
        : '发送任务';
  // While running, the button keeps its icon; the mode menu beside it and the tooltip say what it does.
  const sendHint =
    ownRunning && sendLabel === '发送任务' ? (sendMode === 'steer' ? '立即补充' : '完成后执行') : sendLabel;
  const explainSend = () => {
    if (selectionChanging) return;
    const target = !storage.writable
      ? document.querySelector<HTMLElement>('.storage-banner button')
      : runtime.crash && runtime.crash.cleanup !== 'confirmed'
        ? document.querySelector<HTMLElement>('.crash-card')
        : !sessionEnabled
          ? document.getElementById('enable-project')
          : !environment?.supported && !runtime.connected
            ? document.querySelector<HTMLElement>('.readiness')
            : parameterError
              ? document.querySelector<HTMLElement>('.prompt-arguments [aria-invalid="true"]')
              : input.current;
    target?.scrollIntoView({ block: 'nearest' });
    target?.focus();
  };
  const handleModelError = async (action: ModelErrorAction) => {
    if (action === 'providers') setFeatureTab('providers');
    else if (action === 'proxy') setFeatureTab('prefs');
    else if (action === 'model') setModelPickerOpen(true);
    else if (selected && action === 'compact') await api.invoke('compact', selected.id, '');
    else if (selected && action === 'regenerate') {
      const message = runtime.messages.findLast((item) => item.role === 'assistant');
      if (!message?.timestamp) throw new Error('找不到对应的回复，请重新发送提问。');
      await api.invoke('messageAction', selected.id, 'regenerate', 'assistant', message.timestamp);
    }
  };

  return (
    <div className="composer-wrap" ref={wrap}>
      <ComposerFeedback {...props} handleModelError={handleModelError} />
      {goal && goalView.visible && (
        <GoalCard
          key={`${selected?.id}:${goal.id}`}
          goal={goal}
          messages={props.messages}
          view={goalView}
          disabled={pending || selectionChanging || !storage.writable}
          action={(action) => api.invoke('goalAction', selected!.id, action)}
          openProviders={() => setFeatureTab('providers')}
          edit={() => editGoal(goal)}
          replace={() => openGoalComposer(true)}
        />
      )}
      {ask && selected && (
        <AskPanel
          key={`${selected.id}:${ask.id}`}
          sessionId={selected.id}
          dialog={ask}
          disabled={pending || selectionChanging || !storage.writable || runtime.status === 'stopping'}
          respond={(values) => api.invoke('respond', selected.id, ask.id, values)}
        />
      )}
      {!ask && !goalView.visible && ownRuntime && runtime.plan && (
        <PlanCard
          key={`${selected?.id}:${runtime.plan.turnId}`}
          plan={runtime.plan}
          running={ownRunning}
          updateRequest={runtime.planUpdateRequest}
          expanded={props.expanded}
          toggle={props.toggleTool}
          composing={goalMode}
        />
      )}
      <div
        className={'composer ' + (!selected ? 'disabled' : '') + (dragging ? ' dragging' : '')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (selected) void acceptDrop(Array.from(e.dataTransfer.files));
        }}
      >
        {goalMode && (
          <div
            className={'goal-mode-bar' + (goalPreview ? ' preview' : '')}
            role="group"
            aria-label="Goal 输入模式"
          >
            <Target size={14} />
            <strong>{editingGoal ? '正在修改目标' : 'Goal'}</strong>
            <span>{editingGoal ? '原草稿和附件已保留' : '持续执行直到完成'}</span>
            {!editingGoal && (
              <GoalBudgetPicker
                key={selected?.id}
                messages={props.messages}
                initialBudget={goalBudget}
                disabled={pending}
                submit={setGoalBudget}
              />
            )}
            <button aria-label={editingGoal ? '取消修改目标' : '退出 Goal 模式'} onClick={exitGoalMode}>
              <X size={14} />
            </button>
            {goalError && <small role="status">{goalError}</small>}
          </div>
        )}
        <ComposerResize maximum={inputMaxHeight} change={setInputMaxHeight} />
        {dragging && (
          <div className="drop-hint" aria-hidden="true">
            {project ? '松开以添加图片或引用项目文件' : '松开以添加图片'}
          </div>
        )}
        {!editingGoal && !!images.length && (
          <div className="image-attachments">
            {images.map((img, imageIndex) => (
              <div key={img.id}>
                <button
                  className="draft-image-preview"
                  aria-label={`查看图片 ${img.name}`}
                  onClick={() => setLightboxIndex(imageIndex)}
                >
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
                </button>
                <button
                  aria-label={'移除图片 ' + img.name}
                  onClick={() =>
                    persistDraft(
                      draft,
                      attachments,
                      images.filter((i) => i.id !== img.id),
                    )
                  }
                >
                  ×
                </button>
                <small>{img.name}</small>
              </div>
            ))}
          </div>
        )}
        {!editingGoal && attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a) => (
              <span
                key={a}
                title={(() => {
                  const info = attachmentInfo.find((item) => item.spec === a);
                  return info ? `${(info.bytes / 1024).toFixed(1)} KiB · ${info.lines} 行` : '正在计算大小…';
                })()}
              >
                <FileText size={13} />
                <button title="预览引用文件" onClick={() => void inspectFile(a, 'files')}>
                  {a}
                </button>
                <IconButton
                  title={`移除引用 ${a}`}
                  onClick={() =>
                    persistDraft(
                      draft,
                      attachments.filter((v) => v !== a),
                    )
                  }
                >
                  <X size={12} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        {!editingGoal && !!draftQuotes.length && (
          <div className="attachments draft-quotes">
            {draftQuotes.map((quote) => (
              <span key={quote.id} title={quote.text.slice(0, 2000)}>
                <button onClick={() => window.dispatchEvent(new CustomEvent('pi:quote', { detail: quote }))}>
                  ❝ {quoteLabel(quote)} · {Array.from(quote.text).slice(0, 40).join('')}
                  {Array.from(quote.text).length > 40 ? '…' : ''}
                  {quote.truncated ? '（已截断）' : ''}
                </button>
                <IconButton title="移除对话引用" onClick={() => removeQuote(quote.id)}>
                  <X size={12} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        {!editingGoal && !!snippets.length && (
          <div className="attachments pasted-snippets">
            {snippets.map((item) => (
              <span
                key={item.id}
                title={`${textLines(item.text)} 行 · ${(textBytes(item.text) / 1024).toFixed(1)} KiB`}
              >
                <button onClick={() => setSnippetId(item.id)}>
                  粘贴片段 · {textLines(item.text)} 行（{(textBytes(item.text) / 1024).toFixed(1)} KiB）
                </button>
                <IconButton title="移除粘贴片段" onClick={() => removeSnippet(item.id)}>
                  <X size={12} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        {!answering && activeCommand?.source === 'prompt' && activeCommand.argumentHint && (
          <PromptArguments
            key={selected?.id + activeCommand.name}
            command={activeCommand.prefix + activeCommand.name}
            hint={activeCommand.argumentHint}
            draft={draft}
            update={persistDraft}
            error={setParameterError}
            chooseFile={(query, picked) => {
              parameterPick.current = picked;
              setFileQuery(query);
            }}
            onFileKeyDown={fileKey}
          />
        )}
        <ErrorFeedback as="div" message={!answering && parameterError} />
        <textarea
          ref={input}
          aria-label="任务输入"
          placeholder={
            answering
              ? '也可以直接输入回答…'
              : goalMode
                ? '描述你想达成的目标…'
                : ownRunning
                  ? sendMode === 'steer'
                    ? 'Enter 立即补充…'
                    : 'Enter 完成后执行…'
                  : project
                    ? '描述你想完成的任务，@ 引用文件…'
                    : '给 Pi 发消息…'
          }
          value={draft}
          disabled={!selected || !storage.writable}
          onChange={(e) => {
            parameterPick.current = null;
            onDraft(e.target.value);
          }}
          onPaste={(e) => {
            if (editingGoal) {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                setError('请先保存或取消目标修改');
              }
              return;
            }
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void acceptDrop(files);
            } else {
              const text = e.clipboardData.getData('text/plain');
              if (shouldCollapsePaste(text, draft)) {
                e.preventDefault();
                pasteText(text);
              }
            }
          }}
          onKeyDown={(e) => {
            if (topLayer()) return;
            if (answering) {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendComposer();
              }
              return;
            }
            if (fileKey(e)) return;
            if (commandOptions.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setCommandIndex(
                  (i) =>
                    (i + (e.key === 'ArrowDown' ? 1 : -1) + commandOptions.length) % commandOptions.length,
                );
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                const picked = commandOptions[commandIndex];
                const exact = picked && draft === picked.prefix + picked.name;
                if (e.key === 'Tab' || !exact || picked.argumentHint) {
                  e.preventDefault();
                  if (picked) completeCommand(picked);
                  return;
                }
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setHideCommands(true);
                return;
              }
            }
            if (e.key === 'Escape' && goalMode && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              exitGoalMode();
              return;
            }
            if (e.key === 'Escape' && fileQuery !== null) {
              e.preventDefault();
              setFileQuery(null);
            }
            if (
              !goalMode &&
              (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
              !e.shiftKey &&
              !e.altKey &&
              !mod(e) &&
              !e.nativeEvent.isComposing &&
              fileQuery === null &&
              sentPrompts.length &&
              (draft === '' || (recall.current >= 0 && draft === sentPrompts.at(-1 - recall.current)))
            ) {
              const next = recall.current + (e.key === 'ArrowUp' ? 1 : -1);
              if (next >= sentPrompts.length || next < -1) return;
              e.preventDefault();
              const value = next < 0 ? '' : sentPrompts.at(-1 - next)!;
              persistDraft(value);
              recall.current = next;
              setHideCommands(true);
              requestAnimationFrame(() => {
                input.current?.setSelectionRange(value.length, value.length);
              });
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (fileQuery !== null && fileResults[0]) selectFile(fileResults[0]);
              else sendComposer();
            }
          }}
        />
        {!answering && !!commandOptions.length && (
          <div className="command-picker" role="listbox" aria-label="Pi 命令" ref={commandList}>
            {commandOptions.map((c, i) => (
              <div key={c.prefix + c.name} role="presentation">
                {(i === 0 || commandOptions[i - 1].source !== c.source) && (
                  <div className="command-group">{commandSourceNames[c.source] ?? c.source}</div>
                )}
                <button
                  role="option"
                  aria-selected={commandIndex === i}
                  onMouseDown={(e) => e.preventDefault()}
                  // Not mouseenter: keyboard scrolling must not hand the selection to a resting pointer.
                  onMouseMove={() => setCommandIndex(i)}
                  onClick={() => completeCommand(c)}
                >
                  <code>
                    {c.prefix}
                    {c.name}
                  </code>
                  {c.argumentHint && <em>{c.argumentHint}</em>}
                  <span>{c.description || c.source}</span>
                  {c.sourceInfo?.scope === 'project' && <i>项目</i>}
                </button>
              </div>
            ))}
            <small>
              ↑↓ 选择 · Tab / Enter 补全 · 与桌面命令同名的 Pi 命令用 <code>//</code> 调用
            </small>
          </div>
        )}
        {activeCommand && (activeCommand.argumentHint || activeCommand.description) && (
          <div className="command-hint" aria-live="polite">
            <code>
              {activeCommand.prefix}
              {activeCommand.name}
            </code>
            {activeCommand.argumentHint && <em>{activeCommand.argumentHint}</em>}
            <span>{activeCommand.description}</span>
          </div>
        )}
        {!answering && fileQuery !== null && (
          <div className="file-picker" role="listbox" aria-label="项目文件" ref={fileList}>
            <div className="file-picker-header">
              <Search size={13} />
              引用项目文件
              <IconButton title="关闭文件选择" onClick={() => setFileQuery(null)}>
                <X size={13} />
              </IconButton>
            </div>
            {fileResults.length ? (
              fileResults.map((f, index) => (
                <button
                  key={f}
                  role="option"
                  aria-selected={index === fileIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectFile(f)}
                >
                  <FileText size={14} />
                  <SearchHighlight text={f} query={fileQuery.replace(/(?:#L|:)\d.*$/, '')} />
                </button>
              ))
            ) : (
              <p>没有匹配的文件</p>
            )}
          </div>
        )}
        <div className="composer-toolbar">
          <div>
            <IconButton
              title="添加图片"
              disabled={!selected || editingGoal}
              onClick={() => void chooseImages()}
            >
              <ImagePlus size={17} />
            </IconButton>
            {project && (
              <IconButton
                title="引用文件"
                onClick={() => {
                  parameterPick.current = null;
                  setFileQuery('');
                  input.current?.focus();
                }}
                disabled={!project || editingGoal}
              >
                <Paperclip size={17} />
              </IconButton>
            )}
            <button
              className="goal-button"
              aria-pressed={goalMode}
              aria-label="Goal 目标管理"
              title="设置目标，或查看、暂停和恢复当前目标"
              disabled={!selected || !sessionEnabled || !storage.writable || selectionChanging || pending}
              onClick={() => void openGoal()}
            >
              <Target size={14} />
              Goal
            </button>
            {goal?.status === 'completed' && (
              <button
                className="goal-previous-result"
                aria-label="查看上个 Goal 结果"
                title="查看上个 Goal 结果"
                onClick={goalView.reveal}
              >
                <i className="goal-completed-dot" aria-label="Goal 已完成" />
              </button>
            )}
            <ApprovalSwitch
              grants={ownRuntime ? runtime.approvalGrants : []}
              revoke={(id) => selected && void attempt(() => api.invoke('revokeApproval', selected.id, id))}
              mode={(ownRuntime && runtime.approvalMode) || selected?.approvalMode || 'auto'}
              disabled={!selected || !sessionEnabled}
              change={(mode) =>
                selected &&
                void attempt(async () => {
                  await api.invoke('setApprovalMode', selected.id, mode);
                  setApprovalFeedback({
                    text: running
                      ? '审批模式用于后续工具调用；已开始的命令和已有审批不变'
                      : mode === 'auto'
                        ? 'Pi 将直接修改文件和执行命令'
                        : mode === 'confirm'
                          ? '修改文件和执行命令前会先询问你'
                          : '只读：Pi 只能读取和分析项目内文件，不能修改或执行',
                  });
                })
              }
            />
            <ModelPicker
              open={modelPickerOpen}
              disabledReason={modelPickerDisabledReason}
              setOpen={setModelPickerOpen}
              runtime={modelState.runtime}
              fallback={modelState.label}
              locked={modelLocked}
              thinkingLocked={modelLocked}
              canConnect={sessionEnabled && !running && !pending}
              loadModels={() => void readModels()}
              pick={(key) => void setModel(key)}
              setThinking={(level) => void setThinking(level)}
              manage={(target) =>
                target === 'providers' ? setFeatureTab('providers') : openSettings('models')
              }
            />
          </div>
          <div>
            {!editingGoal && attachmentBytes > 512 * 1024 && (
              <span
                className={
                  'attachment-capacity ' +
                  (attachmentBytes > 1024 * 1024 ? 'over' : attachmentBytes >= 850 * 1024 ? 'warning' : '')
                }
                title={`预估容量；发送时按实际文件内容校验。占用最多：${largest.name}（${(largest.bytes / 1024).toFixed(1)} KiB）${attachmentBytes > 1024 * 1024 ? '。请移除附件或改用行范围引用。' : ''}`}
                role="status"
              >
                预计已用 {(attachmentBytes / 1024).toFixed(0)} KiB / 1 MiB
                {attachmentBytes > 1024 * 1024 && <small>占用最多：{largest.name}；请移除或按行引用</small>}
              </span>
            )}
            {ownRunning && !connecting && !goalMode && !ask ? (
              <div
                className="send-mode"
                role="radiogroup"
                aria-label="运行中发送方式"
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                  event.preventDefault();
                  const next = sendMode === 'steer' ? 'followUp' : 'steer';
                  setSendMode(next);
                  event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
                }}
              >
                {sendModes.map(({ mode, label, hint, Icon }) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    data-mode={mode}
                    aria-checked={sendMode === mode}
                    aria-label={label}
                    title={`${label}：${hint}`}
                    tabIndex={sendMode === mode ? 0 : -1}
                    className={sendMode === mode ? 'active' : undefined}
                    onClick={() => setSendMode(mode)}
                  >
                    <Icon size={14} />
                  </button>
                ))}
              </div>
            ) : (
              <span className="composer-hint">
                <kbd>↵</kbd> 发送
              </span>
            )}
            {ownRunning && (
              <button
                className={'stop-button' + (stopArmed ? ' armed' : '')}
                title={
                  connecting
                    ? '取消本次连接（连按两次 Esc）'
                    : '停止当前会话（连按两次 Esc）；已脱离 Pi 的后台服务需在终端单独停止'
                }
                onClick={() => selected && void attempt(() => api.invoke('stop', selected.id))}
                disabled={runtime.status === 'stopping'}
              >
                <Square size={12} fill="currentColor" />
                {runtime.status === 'stopping' ? '停止中' : connecting ? '取消连接' : '停止任务'}
              </button>
            )}
            <span
              className="send-wrapper"
              role={sendDisabledReason ? 'button' : undefined}
              tabIndex={sendDisabledReason ? 0 : undefined}
              aria-label={sendDisabledReason || undefined}
              title={sendDisabledReason || undefined}
              onClick={sendDisabledReason ? explainSend : undefined}
              onKeyDown={(event) => {
                if (sendDisabledReason && ['Enter', ' '].includes(event.key)) {
                  event.preventDefault();
                  explainSend();
                }
              }}
            >
              <span id="send-disabled-reason" hidden>
                {sendDisabledReason}
              </span>
              <button
                aria-describedby={sendDisabledReason ? 'send-disabled-reason' : undefined}
                className={'send-button' + (goalMode && !localGoalCommand ? ' goal-send-button' : '')}
                aria-label={sendLabel}
                title={sendDisabledReason || sendHint}
                disabled={
                  (!draft.trim() && !images.length && !snippets.length && !draftQuotes.length) ||
                  (!editingGoal && attachmentBytes > 1024 * 1024) ||
                  goalEmpty ||
                  Boolean(goalError) ||
                  (!answering && Boolean(parameterError)) ||
                  !selected ||
                  pending ||
                  props.attachmentsPending ||
                  !sessionEnabled ||
                  (!localGoalCommand && !environment?.supported && !runtime.connected) ||
                  runtime.status === 'stopping'
                }
                onClick={sendComposer}
              >
                {pending ? (
                  <LoaderCircle size={18} className="spin" />
                ) : goalMode && !localGoalCommand ? (
                  editingGoal ? (
                    '保存修改'
                  ) : (
                    '开始 Goal'
                  )
                ) : (
                  <ArrowUp size={19} />
                )}
              </button>
            </span>
          </div>
        </div>
      </div>
      <ErrorFeedback className="approval-mode-feedback" role="status" message={approvalFeedback?.text} />
      <ComposerFooter {...props} />
      {lightboxIndex !== null && images.length > 0 && (
        <Suspense fallback={null}>
          <Lightbox
            images={images.map((img) => ({ src: `data:${img.mimeType};base64,${img.data}`, alt: img.name }))}
            initialIndex={lightboxIndex}
            close={() => setLightboxIndex(null)}
          />
        </Suspense>
      )}
      {snippet && (
        <Modal title={`粘贴片段 · ${textLines(snippet.text)} 行`} close={() => setSnippetId('')}>
          <div className="modal-body snippet-preview">
            <pre>{snippet.text}</pre>
            <button
              onClick={() => {
                expandSnippet(snippet.id);
                setSnippetId('');
              }}
            >
              展开到输入框
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
