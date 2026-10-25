import {
  FolderOpen,
  X,
  GitBranch,
  CheckCircle2,
  LoaderCircle,
  Copy,
  Terminal,
  Files,
  GitCompareArrows,
  RefreshCw,
  ExternalLink,
  Download,
  Paperclip,
  Undo2,
  Maximize2,
  Minimize2,
  Play,
  Send,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { IconButton } from './IconButton';
import { FileTree } from './FileTree';
import { DiffView } from './DiffView';
import { AnsiOutput } from './AnsiOutput';
import { stripAnsi } from '../../shared/ansi';
import type { AgentRulesFile } from '../../shared/workspace';
import '../styles/workspace-v014.css';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import { busy, type AppState } from '../../shared/types';
import { directoryTaskReason } from '../../shared/workspace';

export function Inspector(
  props: Pick<
    Workbench,
    | 'runtime'
    | 'pending'
    | 'compact'
    | 'inspector'
    | 'setInspector'
    | 'tab'
    | 'setTab'
    | 'selectTab'
    | 'changeMode'
    | 'setChangeMode'
    | 'changes'
    | 'setChanges'
    | 'selectedFile'
    | 'setSelectedFile'
    | 'filePreview'
    | 'setFilePreview'
    | 'fileDiff'
    | 'setFileDiff'
    | 'split'
    | 'setSplit'
    | 'inspectorPanel'
    | 'project'
    | 'ownRunning'
    | 'diffLines'
    | 'attempt'
    | 'persistDraft'
    | 'focusComposer'
    | 'addAttachment'
    | 'copy'
    | 'revert'
    | 'inspectFile'
    | 'checkpoints'
    | 'checkpointId'
    | 'setCheckpointId'
    | 'previewStale'
    | 'refreshPreview'
    | 'workspaceRevision'
    | 'previewRange'
    | 'askHunk'
    | 'rerunCommand'
    | 'saveInspectorSplit'
  > & { state: AppState },
) {
  const {
    runtime,
    pending,
    compact,
    inspector,
    setInspector,
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
    fileDiff,
    setFileDiff,
    split,
    setSplit,
    inspectorPanel,
    project,
    attempt,
    addAttachment,
    copy,
    revert,
    inspectFile,
    checkpoints,
    checkpointId,
    setCheckpointId,
    previewStale,
    refreshPreview,
    workspaceRevision,
    previewRange,
    askHunk,
    rerunCommand,
    saveInspectorSplit,
  } = props;
  const [maximized, setMaximized] = useState(false),
    [fullDiff, setFullDiff] = useState(false);
  const [selection, setSelection] = useState<{ startLine: number; endLine: number }>();
  const [outputQuery, setOutputQuery] = useState(''),
    [failedOnly, setFailedOnly] = useState(false);
  const [rules, setRules] = useState<AgentRulesFile>(),
    [rulesLoaded, setRulesLoaded] = useState(false);
  const anchor = useRef(1);
  const fileIndex = changes?.files.findIndex((file) => file.path === selectedFile) ?? -1;
  const nextFile = (direction: number) => {
    const files = changes?.files ?? [];
    if (!files.length || pending) return;
    const index = Math.max(0, Math.min(files.length - 1, fileIndex + direction));
    void inspectFile(files[index].path, 'changes');
    requestAnimationFrame(() =>
      inspectorPanel.current?.querySelector<HTMLElement>('.review-navigation')?.focus(),
    );
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !inspector ||
        tab !== 'changes' ||
        event.isComposing ||
        event.defaultPrevented ||
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        !(event.target instanceof Node) ||
        !inspectorPanel.current?.contains(event.target)
      )
        return;
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        nextFile(event.key === 'PageDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [inspector, tab, selectedFile, changes, pending]);
  const drag = useRef<{ y: number; split: number; height: number; value: number } | null>(null);
  const splitValue = props.state.settings.inspectorSplit;
  const selectedSession = props.state.sessions.find(
    (session) => session.id === props.state.selectedSessionId,
  );
  const directoryReason = project
    ? directoryTaskReason(props.state, project, api.platform === 'win32' || api.platform === 'darwin')
    : '';
  const canRerun =
    !pending &&
    !busy(runtime.status) &&
    runtime.sessionId === selectedSession?.id &&
    selectedSession?.approvalMode !== 'readonly';
  const outputs = useMemo(
    () =>
      runtime.tools.filter(
        (tool) =>
          (!failedOnly || tool.status === 'error') &&
          (!outputQuery.trim() ||
            `${tool.name}\n${String(tool.args.command ?? '')}\n${stripAnsi(tool.output)}`
              .toLocaleLowerCase()
              .includes(outputQuery.trim().toLocaleLowerCase())),
      ),
    [runtime.tools, failedOnly, outputQuery],
  );
  useEffect(() => {
    setMaximized(false);
    setSelection(undefined);
  }, [selectedFile, tab]);
  useEffect(() => {
    if (!previewRange || !filePreview) return;
    setSelection(previewRange);
    anchor.current = previewRange.startLine;
    requestAnimationFrame(() =>
      inspectorPanel.current
        ?.querySelector(`[data-source-line="${previewRange.startLine}"]`)
        ?.scrollIntoView({ block: 'center' }),
    );
  }, [previewRange, filePreview?.path]);
  useEffect(() => {
    if (!project) {
      setTab('output');
      return;
    }
    let alive = true;
    setRulesLoaded(false);
    void attempt(async () => {
      const value = await api.invoke('projectRules', project.id);
      if (alive) {
        setRules(value);
        setRulesLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [project?.id, workspaceRevision]);
  function updateSplit(value: number, persist = false) {
    const next = Math.max(15, Math.min(70, value));
    inspectorPanel.current?.style.setProperty('--inspector-split', next + '%');
    if (persist) saveInspectorSplit(next);
    return next;
  }
  async function refreshKeepingPosition() {
    const positions = Array.from(
      inspectorPanel.current?.querySelectorAll<HTMLElement>('.source-preview,.unified-diff,.diff-pane') ?? [],
    ).map((element) => ({ top: element.scrollTop, left: element.scrollLeft }));
    await refreshPreview();
    requestAnimationFrame(() =>
      Array.from(
        inspectorPanel.current?.querySelectorAll<HTMLElement>('.source-preview,.unified-diff,.diff-pane') ??
          [],
      ).forEach((element, index) => {
        if (positions[index]) {
          element.scrollTop = positions[index].top;
          element.scrollLeft = positions[index].left;
        }
      }),
    );
  }
  const divider =
    selectedFile && !maximized ? (
      <div
        className="inspector-divider"
        role="separator"
        aria-label="调整文件列表与预览高度"
        aria-orientation="horizontal"
        aria-valuemin={15}
        aria-valuemax={70}
        aria-valuenow={splitValue}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            y: event.clientY,
            split: splitValue,
            value: splitValue,
            height: inspectorPanel.current?.clientHeight ?? 1,
          };
        }}
        onPointerMove={(event) => {
          if (drag.current)
            drag.current.value = updateSplit(
              drag.current.split + ((event.clientY - drag.current.y) / drag.current.height) * 100,
            );
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          updateSplit(drag.current.value, true);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          updateSplit(splitValue);
        }}
        onDoubleClick={() => updateSplit(40, true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            updateSplit(
              splitValue +
                (event.key === 'ArrowDown' ? 1000 : -1000) / (inspectorPanel.current?.clientHeight ?? 1),
              true,
            );
          }
        }}
      />
    ) : null;
  const maximizeButton = (
    <IconButton title={maximized ? '恢复列表' : '最大化预览'} onClick={() => setMaximized((value) => !value)}>
      {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </IconButton>
  );
  const staleNotice = previewStale && (
    <div className="preview-stale">
      <span>文件已在外部更新</span>
      <button onClick={() => void refreshKeepingPosition()}>刷新</button>
    </div>
  );

  return (
    <>
      {inspector && (
        <button
          className="inspector-scrim"
          tabIndex={-1}
          aria-label="关闭工作区面板"
          onClick={() => setInspector(false)}
        />
      )}
      {inspector && (
        <aside
          ref={inspectorPanel}
          className={'inspector ' + (maximized && selectedFile ? 'preview-maximized' : '')}
          style={{ '--inspector-split': `${splitValue}%` } as CSSProperties}
          id="workspace-inspector"
          aria-label="工作区检查"
          role={compact ? 'dialog' : undefined}
          aria-modal={compact || undefined}
        >
          <div className="inspector-tabs">
            {(
              [
                ['changes', GitCompareArrows, '变更'],
                ['files', Files, '文件'],
                ['output', Terminal, '输出'],
              ] as const
            )
              .filter(([key]) => project || key === 'output')
              .map(([key, Icon, label]) => (
                <button
                  key={key}
                  aria-pressed={tab === key}
                  className={tab === key ? 'active' : ''}
                  onClick={() => selectTab(key)}
                >
                  <Icon size={15} />
                  {label}
                  {key === 'changes' && !!changes?.files.length && (
                    <span className="count">{changes.files.length}</span>
                  )}
                </button>
              ))}
            <IconButton
              title="关闭面板"
              onClick={() => {
                setInspector(false);
                if (!compact) document.querySelector<HTMLButtonElement>('.workspace-toggle')?.focus();
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
          {maximized && selectedFile && (
            <button className="preview-return" onClick={() => setMaximized(false)}>
              返回列表{tab === 'changes' ? `（共 ${changes?.files.length ?? 0} 项）` : ''}
            </button>
          )}
          {!project && tab !== 'output' ? (
            <div className="inspector-empty">
              <FolderOpen size={28} />
              <p>
                打开项目后
                <br />
                在这里查看文件与变更
              </p>
            </div>
          ) : project && tab === 'changes' ? (
            <>
              <div className="change-controls">
                <select
                  aria-label="变更范围"
                  value={changeMode === 'run' && checkpointId ? `checkpoint:${checkpointId}` : changeMode}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCheckpointId(value.startsWith('checkpoint:') ? value.slice(11) : '');
                    setChangeMode(value === 'all' ? 'all' : 'run');
                    setSelectedFile('');
                    setFileDiff(undefined);
                  }}
                >
                  <option value="all">全部未提交变更</option>
                  <option value="run">运行期间变更（本轮）</option>
                  {checkpoints.map((checkpoint) => (
                    <option
                      key={checkpoint.id}
                      value={`checkpoint:${checkpoint.id}`}
                      disabled={!checkpoint.available}
                    >
                      自第 {checkpoint.turn} 轮起{checkpoint.available ? '' : '（分支已变化）'}
                    </option>
                  ))}
                </select>
                <IconButton
                  title="刷新变更"
                  onClick={() =>
                    void attempt(async () => {
                      setChanges(
                        await api.invoke(
                          'changes',
                          project.id,
                          changeMode,
                          selectedSession
                            ? { sessionId: selectedSession.id, checkpointId: checkpointId || undefined }
                            : undefined,
                        ),
                      );
                      if (selectedFile) await inspectFile(selectedFile, 'changes');
                    })
                  }
                >
                  <RefreshCw size={14} />
                </IconButton>
                {changeMode === 'run' && changes?.baselineAvailable && !!changes.files.length && (
                  <button
                    className="revert-all"
                    disabled={Boolean(directoryReason) || pending}
                    title={directoryReason || '把本轮修改过的文件恢复到任务开始前'}
                    onClick={() => void revert(null)}
                  >
                    <Undo2 size={13} />
                    {checkpointId ? '撤销此轮起' : '撤销本轮'}
                  </button>
                )}
              </div>
              {!changes ? (
                <div className="inspector-empty">
                  <LoaderCircle size={23} className="spin" />
                  <p>正在读取工作区状态…</p>
                </div>
              ) : !changes.git ? (
                <div className="inspector-empty">
                  <GitBranch size={27} />
                  <h3>{changes.error ? 'Git 状态尚未读取' : '当前目录没有 Git 仓库'}</h3>
                  <p>{changes.error ?? '仍然可以与 Pi 对话和浏览文件。'}</p>
                </div>
              ) : changeMode === 'run' && !changes.baselineAvailable ? (
                <div className="inspector-empty">
                  <GitCompareArrows size={27} />
                  <h3>{changes.baselineInvalid ? 'Git 基线已变化' : '还没有运行基线'}</h3>
                  <p>
                    {changes.baselineInvalid
                      ? 'Git 分支已切换，当前检查点不可用。请查看全部未提交变更。'
                      : '发送第一条任务后，会记录运行开始时的文件内容。'}
                  </p>
                </div>
              ) : (
                <>
                  {!!changes.files.length && (
                    <nav tabIndex={-1} className="review-navigation" aria-label="逐个审查变更">
                      <button
                        disabled={pending || fileIndex <= 0}
                        onClick={() => nextFile(-1)}
                        title="Alt+PageUp"
                      >
                        上一个文件
                      </button>
                      <span aria-live="polite">
                        {Math.max(0, fileIndex + 1)} / {changes.files.length}
                      </span>
                      <button
                        disabled={pending || fileIndex >= changes.files.length - 1}
                        onClick={() => nextFile(1)}
                        title="Alt+PageDown"
                      >
                        {fileIndex < 0 ? '开始逐个审查' : '下一个文件'}
                      </button>
                    </nav>
                  )}
                  <div className={'change-list ' + (selectedFile ? 'has-preview' : '')}>
                    {changes.files.length === 0 ? (
                      <div className="clean-state">
                        <CheckCircle2 size={25} />
                        <h3>工作区干净</h3>
                        <p>文件有变化时，会显示在这里。</p>
                      </div>
                    ) : (
                      changes.files.map((f) => (
                        <button
                          key={f.path}
                          className={'change-row ' + (selectedFile === f.path ? 'active' : '')}
                          onClick={() => void inspectFile(f.path, 'changes')}
                        >
                          <span className={'change-symbol ' + f.status}>
                            {f.status === '新增' ? '+' : f.status === '删除' ? '−' : 'M'}
                          </span>
                          <span title={f.path}>
                            {f.path}
                            <small>
                              {f.existedBeforeRun ? '运行前已修改' : f.staged ? '已暂存' : f.status}
                            </small>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  {changes.omitted.length > 0 && (
                    <details className="omitted">
                      <summary>{changes.omitted.length} 个路径未纳入运行基线</summary>
                      <p>包含超过扫描上限或无法安全恢复的路径；/** 表示整个子目录。</p>
                      <textarea
                        className="input"
                        rows={8}
                        aria-label="未纳入运行基线的路径"
                        readOnly
                        value={changes.omitted.join('\n')}
                      />
                    </details>
                  )}
                  {changes.error && <p className="inline-error">{changes.error}</p>}
                </>
              )}
              {divider}
              {selectedFile && (
                <div className="file-preview">
                  <div
                    className="preview-toolbar"
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest('button')) setMaximized((value) => !value);
                    }}
                  >
                    <strong title={selectedFile}>{selectedFile.split('/').at(-1)}</strong>
                    <button onClick={() => setSplit((v) => !v)}>{split ? '统一' : '对照'}</button>
                    {split && (
                      <button onClick={() => setFullDiff((value) => !value)}>
                        {fullDiff ? '仅看改动上下文' : '展开完整文件'}
                      </button>
                    )}
                    {maximizeButton}
                    <IconButton
                      title="在编辑器中打开或定位文件"
                      onClick={() => void attempt(() => api.invoke('openFile', project.id, selectedFile))}
                    >
                      <ExternalLink size={14} />
                    </IconButton>
                  </div>
                  {staleNotice}
                  {!fileDiff ? (
                    <p className="empty-small">加载差异…</p>
                  ) : fileDiff.unavailable ? (
                    <p className="empty-small">{fileDiff.unavailable}</p>
                  ) : (
                    <DiffView {...fileDiff} split={split} full={fullDiff} onAskHunk={askHunk} />
                  )}
                  <div className="preview-foot">
                    <button onClick={() => void copy(selectedFile, '路径已复制')}>
                      <Copy size={12} />
                      路径
                    </button>
                    {changeMode === 'run' && changes?.files.some((f) => f.path === selectedFile) && (
                      <button
                        className="danger"
                        disabled={Boolean(directoryReason) || pending}
                        title={directoryReason || '撤销此文件在所选任务中的修改'}
                        onClick={() => void revert([selectedFile])}
                      >
                        <Undo2 size={12} />
                        撤销此文件
                      </button>
                    )}
                    <button
                      onClick={() => {
                        askHunk(selectedFile, `请检查 ${selectedFile} 的这处变更：`);
                      }}
                    >
                      继续提问
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : project && tab === 'files' ? (
            <>
              {rulesLoaded && (
                <div className="project-rules-bar">
                  {rules ? (
                    <>
                      <button onClick={() => void inspectFile(rules.relativePath, 'files')}>
                        项目规则：{rules.relativePath}
                      </button>
                      <IconButton
                        title="用默认编辑器打开项目规则"
                        onClick={() => void attempt(() => api.invoke('editProjectRules', project.id))}
                      >
                        <ExternalLink size={13} />
                      </IconButton>
                    </>
                  ) : (
                    <>
                      <span>尚未配置 AGENTS.md，可固定构建、测试命令与代码规范。</span>
                      <button
                        disabled={Boolean(directoryReason)}
                        title={directoryReason || '创建项目规则文件并打开编辑器'}
                        onClick={() =>
                          void attempt(async () => {
                            const created = await api.invoke('createAgentRules', project.id);
                            setRules(created);
                            await inspectFile(created.relativePath, 'files');
                          })
                        }
                      >
                        生成模板草稿
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className={'file-tree-scroll ' + (selectedFile ? 'has-preview' : '')}>
                <FileTree
                  project={project}
                  selectedFile={selectedFile}
                  changes={changes?.files}
                  revision={workspaceRevision}
                  onSelect={(p) => void inspectFile(p, 'files')}
                />
              </div>
              {divider}
              {selectedFile && (
                <div className="file-preview">
                  <div
                    className="preview-toolbar"
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest('button')) setMaximized((value) => !value);
                    }}
                  >
                    <strong title={selectedFile}>{selectedFile.split('/').at(-1)}</strong>
                    {selection && (
                      <button
                        onClick={() =>
                          void addAttachment(`${selectedFile}#L${selection.startLine}-L${selection.endLine}`)
                        }
                      >
                        引用 L{selection.startLine}–L{selection.endLine}
                      </button>
                    )}
                    {maximizeButton}
                    <IconButton title="引用此文件" onClick={() => void addAttachment(selectedFile)}>
                      <Paperclip size={14} />
                    </IconButton>
                    <IconButton
                      title="在编辑器中打开或定位文件"
                      onClick={() => void attempt(() => api.invoke('openFile', project.id, selectedFile))}
                    >
                      <ExternalLink size={14} />
                    </IconButton>
                  </div>
                  {staleNotice}
                  {!filePreview ? (
                    <p className="empty-small">读取文件…</p>
                  ) : filePreview.binary ? (
                    <p className="empty-small">这是二进制文件，请在外部应用中打开。</p>
                  ) : (
                    <>
                      <pre className="source-preview numbered-source">
                        {filePreview.text.split(/\r?\n/).map((line, index) => (
                          <div
                            data-source-line={index + 1}
                            key={index}
                            className={
                              selection && index + 1 >= selection.startLine && index + 1 <= selection.endLine
                                ? 'selected'
                                : ''
                            }
                          >
                            <button
                              aria-label={`选择第 ${index + 1} 行`}
                              onClick={(event) => {
                                const number = index + 1;
                                if (!event.shiftKey) anchor.current = number;
                                setSelection({
                                  startLine: Math.min(anchor.current, number),
                                  endLine: Math.max(anchor.current, number),
                                });
                              }}
                            >
                              {index + 1}
                            </button>
                            <code>{line || ' '}</code>
                          </div>
                        ))}
                      </pre>
                      {filePreview.truncated && <p className="empty-small">预览已截断，文件超过 1 MiB。</p>}
                    </>
                  )}
                  <div className="preview-foot">
                    <span>{filePreview && (filePreview.size / 1024).toFixed(1) + ' KiB'}</span>
                    <button onClick={() => void api.invoke('copy', selectedFile)}>
                      <Copy size={12} />
                      复制路径
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="output-header">
                <span>
                  {runtime.sessionId === selectedSession?.id
                    ? '当前连接会话的工具输出'
                    : '其他会话的工具输出，重跑前请先切回该会话'}
                </span>
                {runtime.tools.length > 0 && (
                  <IconButton
                    title="导出已接收的工具输出"
                    onClick={() =>
                      props.state.selectedSessionId &&
                      void attempt(() => api.invoke('exportOutput', props.state.selectedSessionId!))
                    }
                  >
                    <Download size={15} />
                  </IconButton>
                )}
              </div>
              <div className="output-filters">
                <input
                  aria-label="筛选工具输出"
                  placeholder="筛选命令或输出…"
                  value={outputQuery}
                  onChange={(event) => setOutputQuery(event.target.value)}
                />
                <button aria-pressed={failedOnly} onClick={() => setFailedOnly((value) => !value)}>
                  只看失败（{runtime.tools.filter((tool) => tool.status === 'error').length}）
                </button>
              </div>
              <div className="output-scroll">
                {outputs.length ? (
                  outputs.map((t) => (
                    <section key={t.id}>
                      <h4>
                        {t.name}
                        <span>{t.status === 'done' ? '完成' : t.status === 'error' ? '失败' : '运行中'}</span>
                      </h4>
                      {typeof t.args.command === 'string' && (
                        <div className="output-command">
                          <code>{t.args.command}</code>
                          {canRerun && (t.name === 'bash' || t.name === 'powershell') && (
                            <div>
                              <IconButton
                                title="本地重跑（不发给模型）"
                                onClick={() => rerunCommand(t.args.command as string, false)}
                              >
                                <Play size={13} />
                              </IconButton>
                              <IconButton
                                title="重跑并发给 Pi"
                                onClick={() => rerunCommand(t.args.command as string, true)}
                              >
                                <Send size={13} />
                              </IconButton>
                            </div>
                          )}
                        </div>
                      )}
                      <AnsiOutput text={t.output || '等待输出…'} />
                    </section>
                  ))
                ) : (
                  <div className="inspector-empty">
                    <Terminal size={27} />
                    <p>
                      {runtime.tools.length ? '没有匹配的输出' : '执行命令后'}
                      <br />
                      在这里查看输出
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}
