import {
  FolderOpen,
  X,
  Check,
  CheckCircle2,
  AlertCircle,
  LoaderCircle,
  Terminal,
  RefreshCw,
  ExternalLink,
  Download,
  Sun,
  Moon,
  Monitor,
  CircleHelp,
  Link2,
  Trash2,
} from 'lucide-react';
import { platform } from '../lib/platform';
import { readableError } from '../lib/format';
import { IconButton } from './IconButton';
import { Modal } from './Modal';
import { CodeBlock } from './conversation/Markdown';
import { compatibilityLabels, PI_INSTALL_COMMAND, PI_SOURCE_URL } from '../../shared/pi-version';
import { PiCompatibilityNotice } from './PiCompatibilityNotice';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { ReactNode } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
const draftKeys = [
  'piPath',
  'nodePath',
  'agentDir',
  'editorPath',
  'theme',
  'fontScale',
  'sidebarWidth',
  'inspectorWidth',
  'inspectorSplit',
  'notifyOnFinish',
] as const;

export function SettingsModal(
  props: Pick<
    Workbench,
    | 'state'
    | 'runtime'
    | 'environment'
    | 'error'
    | 'setError'
    | 'setNotice'
    | 'settingsOpen'
    | 'setSettingsOpen'
    | 'settingsTab'
    | 'setSettingsTab'
    | 'prefs'
    | 'setPrefs'
    | 'pending'
    | 'setFeatureTab'
    | 'testResult'
    | 'setTestResult'
    | 'diagnostic'
    | 'setDiagnostic'
    | 'selected'
    | 'sessionEnabled'
    | 'running'
    | 'modelLocked'
    | 'attempt'
    | 'action'
    | 'detect'
    | 'saveSettings'
    | 'connect'
    | 'chooseSettingPath'
    | 'setModel'
    | 'setThinking'
  > & { updatePanel: ReactNode },
) {
  const {
    runtime,
    environment,
    error,
    setError,
    setNotice,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    prefs,
    setPrefs,
    pending,
    setFeatureTab,
    testResult,
    setTestResult,
    diagnostic,
    setDiagnostic,
    selected,
    sessionEnabled,
    running,
    modelLocked,
    attempt,
    action,
    detect,
    saveSettings,
    connect,
    chooseSettingPath,
    setModel,
    setThinking,
  } = props;
  const dirty = Boolean(
    settingsOpen &&
    prefs &&
    props.state &&
    draftKeys.some((key) => prefs[key] !== props.state!.settings[key]),
  );
  const guard = useUnsavedChanges(dirty);
  const requestClose = () => {
    if (!pending) guard.confirmLeave(() => setSettingsOpen(false));
  };

  return (
    <>
      {settingsOpen && prefs && (
        <Modal wide title="设置" subtitle="连接你的 Pi，保留你的工作方式。" close={requestClose}>
          <div className="settings-layout">
            <nav>
              {[
                ['environment', '运行环境', Terminal],
                ['models', '模型连接', Link2],
                ['appearance', '外观与编辑器', Monitor],
                ['diagnostic', '诊断与数据', CircleHelp],
                ['updates', '关于与更新', Download],
              ].map(([key, label, Icon]) => (
                <button
                  key={String(key)}
                  className={settingsTab === key ? 'active' : ''}
                  onClick={() => setSettingsTab(String(key))}
                >
                  {typeof Icon !== 'string' && <Icon size={16} />}
                  <span>{String(label)}</span>
                </button>
              ))}
            </nav>
            <div className="settings-content">
              {settingsTab === 'updates' && props.updatePanel}
              {error && (
                <div className="error-banner" role="alert">
                  <AlertCircle size={16} />
                  <span>{error}</span>
                  <IconButton title="关闭设置错误" onClick={() => setError('')}>
                    <X size={14} />
                  </IconButton>
                </div>
              )}
              {settingsTab === 'environment' && (
                <>
                  <div className="settings-heading">
                    <h3>本机运行环境</h3>
                    <button disabled={pending} onClick={() => void action(detect)}>
                      <RefreshCw size={14} />
                      重新检测
                    </button>
                  </div>
                  <div className="environment-status">
                    <div>
                      <span>Pi 版本</span>
                      <strong>
                        {environment?.version || '未检测到'}
                        {environment &&
                          environment.compatibility !== 'unverified' &&
                          ` · ${compatibilityLabels[environment.compatibility]}`}
                      </strong>
                      {environment?.supported ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    </div>
                    <div>
                      <span>Git</span>
                      <strong>{environment?.git ? '已找到' : '未找到'}</strong>
                    </div>
                    <div>
                      <span>Git Bash</span>
                      <strong>{environment?.bash ? '已找到' : '未找到'}</strong>
                    </div>
                  </div>
                  {environment && <PiCompatibilityNotice environment={environment} />}
                  {environment?.errors.map((e) => (
                    <p className="environment-note" key={e}>
                      {e}
                    </p>
                  ))}
                  <label className="field-label">
                    Pi 入口 <small>留空自动检测，支持 cli.js 与官方可执行文件</small>
                  </label>
                  <div className="path-field">
                    <input
                      aria-label="Pi 入口"
                      value={prefs.piPath}
                      placeholder={environment?.piPath || '自动检测'}
                      onChange={(e) => setPrefs({ ...prefs, piPath: e.target.value })}
                    />
                    <button onClick={() => void chooseSettingPath('pi')}>选择</button>
                  </div>
                  <label className="field-label">
                    Node.js 入口 <small>用于启动 JavaScript 版 Pi</small>
                  </label>
                  <div className="path-field">
                    <input
                      aria-label="Node.js 入口"
                      value={prefs.nodePath}
                      placeholder={environment?.nodePath || '自动检测'}
                      onChange={(e) => setPrefs({ ...prefs, nodePath: e.target.value })}
                    />
                    <button onClick={() => void chooseSettingPath('node')}>选择</button>
                  </div>
                  <label className="field-label">
                    Pi 配置目录 <small>复用已有模型、凭据和扩展</small>
                  </label>
                  <div className="path-field">
                    <input
                      aria-label="Pi 配置目录"
                      value={prefs.agentDir}
                      placeholder={environment?.agentDir}
                      onChange={(e) => setPrefs({ ...prefs, agentDir: e.target.value })}
                    />
                    <button onClick={() => void chooseSettingPath('agent')}>选择</button>
                  </div>
                  <div className="button-row">
                    <button
                      disabled={!selected || !sessionEnabled || pending || running}
                      onClick={() => {
                        guard.confirmLeave(() => {
                          setSettingsOpen(false);
                          setFeatureTab('resources');
                        });
                      }}
                    >
                      管理 Skills、扩展与提示词模板
                    </button>
                  </div>
                  <details className="setup-guide">
                    <summary>还没有安装 Pi？</summary>
                    <p>在终端安装受支持的版本线，再回到这里重新检测：</p>
                    <CodeBlock>{PI_INSTALL_COMMAND}</CodeBlock>
                    <button
                      className="text-button"
                      onClick={() => void api.invoke('openLink', 'https://pi.dev/docs/latest')}
                    >
                      查看官方安装说明 <ExternalLink size={13} />
                    </button>
                  </details>
                </>
              )}
              {settingsTab === 'models' && (
                <>
                  <div className="settings-heading">
                    <h3>模型与凭据</h3>
                    <button disabled={!sessionEnabled || pending || running} onClick={connect}>
                      <Link2 size={14} />
                      连接 Pi
                    </button>
                  </div>
                  <p className="settings-copy">使用 Pi 已保存的凭据。模型请求直接发往你配置的服务商。</p>
                  <div className="credential-status">
                    <span className={'connection-dot ' + (environment?.authExists ? 'ready' : '')} />
                    {environment?.authExists
                      ? '已发现凭据配置，连接状态以实际请求为准'
                      : '尚未发现 Pi 凭据文件；也可以使用环境变量配置'}
                  </div>
                  {!selected && <p className="environment-note">请先新建对话，再连接 Pi 获取模型列表。</p>}
                  <label className="field-label">当前模型</label>
                  <select
                    className="input"
                    aria-label="选择模型"
                    disabled={modelLocked || !runtime.models.length}
                    value={
                      (runtime.nextTask?.model ?? runtime.model)
                        ? `${(runtime.nextTask?.model ?? runtime.model)!.provider}::${(runtime.nextTask?.model ?? runtime.model)!.id}`
                        : ''
                    }
                    onChange={(e) => void setModel(e.target.value)}
                  >
                    <option value="" disabled>
                      {runtime.models.length ? '选择模型' : '连接 Pi 后读取可用模型'}
                    </option>
                    {runtime.models.map((m) => (
                      <option key={m.provider + '::' + m.id} value={m.provider + '::' + m.id}>
                        {m.provider} / {m.name || m.id}
                      </option>
                    ))}
                  </select>
                  <p className="settings-copy">
                    运行中修改模型和推理级别，将在下次发送新任务时生效。工具继续推理和补充要求沿用本轮设置，无需点击保存设置。
                  </p>
                  {runtime.nextTask && (
                    <p className="environment-note">
                      本轮：{runtime.model?.id} · {runtime.thinking}；下次新任务：{runtime.nextTask.model.id}{' '}
                      · {runtime.nextTask.thinking}
                    </p>
                  )}
                  <label className="field-label">推理级别</label>
                  <select
                    className="input"
                    aria-label="推理级别"
                    disabled={
                      !(runtime.nextTask?.thinkingLevels ?? runtime.thinkingLevels).length || modelLocked
                    }
                    value={runtime.nextTask?.thinking ?? runtime.thinking ?? ''}
                    onChange={(e) => void setThinking(e.target.value)}
                  >
                    {(runtime.nextTask?.thinkingLevels ?? runtime.thinkingLevels).length ? (
                      (runtime.nextTask?.thinkingLevels ?? runtime.thinkingLevels).map((v) => (
                        <option key={v}>{v}</option>
                      ))
                    ) : (
                      <option>当前模型未提供可选级别</option>
                    )}
                  </select>
                  <div className="connection-test">
                    <button
                      disabled={
                        !runtime.model ||
                        pending ||
                        running ||
                        !selected ||
                        !sessionEnabled ||
                        !environment?.supported
                      }
                      onClick={() =>
                        void action(async () => {
                          setTestResult('正在连接…');
                          try {
                            const r = await api.invoke('testConnection', selected!.id);
                            setTestResult(`连接成功 · ${r.elapsed} ms · ${r.text.slice(0, 100)}`);
                          } catch (e) {
                            setTestResult('连接失败：' + readableError(e));
                          }
                        })
                      }
                    >
                      <RefreshCw size={15} />
                      测试模型连接
                    </button>
                    <small>将发送一次简短请求，可能产生模型费用。</small>
                  </div>
                  {testResult && <p className="test-result">{testResult}</p>}
                  <details className="setup-guide" open={!environment?.authExists}>
                    <summary>登录或配置模型</summary>
                    <button
                      onClick={() => {
                        guard.confirmLeave(() => {
                          setSettingsOpen(false);
                          setFeatureTab('providers');
                        });
                      }}
                    >
                      管理供应商与登录
                    </button>
                    <CodeBlock>
                      {environment?.piPath && /\.m?js$/i.test(environment.piPath)
                        ? `& '${(environment.nodePath || 'node').replaceAll("'", "''")}' '${environment.piPath.replaceAll("'", "''")}'`
                        : 'pi'}
                    </CodeBlock>
                    <p>可在供应商管理中登录、保存 API Key 或编辑自定义模型。已有密钥不会回显。</p>
                    <button
                      className="text-button"
                      onClick={() => void api.invoke('openLink', PI_SOURCE_URL + '/docs/providers.md')}
                    >
                      查看凭据配置说明 <ExternalLink size={13} />
                    </button>
                  </details>
                </>
              )}
              {settingsTab === 'appearance' && (
                <>
                  <h3>界面外观</h3>
                  <label className="field-label">主题</label>
                  <div className="theme-options">
                    {(
                      [
                        ['light', '浅色', Sun],
                        ['dark', '深色', Moon],
                        ['system', '跟随系统', Monitor],
                        ['sepia', '护眼米黄', null],
                        ['green', '豆沙绿', null],
                        ['navy', '深蓝', null],
                      ] as const
                    ).map(([key, label, Icon]) => (
                      <button
                        className={prefs.theme === key ? 'active' : ''}
                        key={key}
                        onClick={() => {
                          setPrefs({ ...prefs, theme: key });
                        }}
                      >
                        {Icon ? <Icon size={23} /> : <span className="theme-swatch" data-theme={key} />}
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="field-label">
                    字号比例 <span>{Math.round(prefs.fontScale * 100)}%</span>
                  </label>
                  <input
                    type="range"
                    aria-label="字号比例"
                    min="1"
                    max="2"
                    step="0.1"
                    value={prefs.fontScale}
                    onChange={(e) => {
                      const fontScale = Number(e.target.value);
                      setPrefs({ ...prefs, fontScale });
                    }}
                  />
                  <label className="field-label">
                    项目侧栏宽度 <span>{prefs.sidebarWidth} px</span>
                  </label>
                  <input
                    type="range"
                    aria-label="侧栏宽度"
                    min="180"
                    max="360"
                    step="10"
                    value={prefs.sidebarWidth}
                    onChange={(e) => {
                      const sidebarWidth = Number(e.target.value);
                      setPrefs({ ...prefs, sidebarWidth });
                    }}
                  />
                  <label className="field-label">
                    文件面板宽度 <span>{prefs.inspectorWidth} px</span>
                  </label>
                  <input
                    type="range"
                    aria-label="面板宽度"
                    min="300"
                    max="720"
                    step="10"
                    value={prefs.inspectorWidth}
                    onChange={(e) => {
                      const inspectorWidth = Number(e.target.value);
                      setPrefs({ ...prefs, inspectorWidth });
                    }}
                  />
                  <label className="field-label">
                    文件列表高度 <span>{prefs.inspectorSplit}%</span>
                  </label>
                  <input
                    type="range"
                    aria-label="文件列表高度"
                    min="15"
                    max="70"
                    step="1"
                    value={prefs.inspectorSplit}
                    onChange={(e) => {
                      const inspectorSplit = Number(e.target.value);
                      setPrefs({ ...prefs, inspectorSplit });
                    }}
                  />
                  <label className="field-label">
                    代码编辑器 <small>留空时在{platform.fileManager}中定位文件</small>
                  </label>
                  <div className="path-field">
                    <input
                      aria-label="代码编辑器"
                      value={prefs.editorPath}
                      onChange={(e) => setPrefs({ ...prefs, editorPath: e.target.value })}
                    />
                    <button onClick={() => void chooseSettingPath('editor')}>选择</button>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={prefs.notifyOnFinish}
                      onChange={(e) => {
                        const notifyOnFinish = e.target.checked;
                        setPrefs({ ...prefs, notifyOnFinish });
                      }}
                    />
                    <span>
                      窗口在后台时发送系统通知
                      <small>任务完成、失败或 Pi 等待你回复时提醒，并闪烁任务栏图标</small>
                    </span>
                  </label>
                </>
              )}
              {settingsTab === 'diagnostic' && (
                <>
                  <h3>诊断与本地数据</h3>
                  <p className="settings-copy">
                    诊断仅包含环境路径、状态和已过滤的错误，不包含对话正文。导出前请检查下方内容。
                  </p>
                  <div className="button-row">
                    <button
                      onClick={() => void attempt(async () => setDiagnostic(await api.invoke('diagnostics')))}
                    >
                      <RefreshCw size={14} />
                      生成预览
                    </button>
                    <button
                      disabled={!diagnostic}
                      onClick={() => void attempt(() => api.invoke('exportDiagnostics'))}
                    >
                      <Download size={14} />
                      导出诊断
                    </button>
                  </div>
                  {diagnostic && <pre className="diagnostic-preview">{diagnostic}</pre>}
                  <button
                    className="text-button"
                    onClick={() => void attempt(() => api.invoke('revealData'))}
                  >
                    <FolderOpen size={15} />
                    打开应用数据目录
                  </button>
                  <p className="settings-copy">
                    运行差异基线保留 7 天，总计不超过 200 MiB。清理基线不影响项目与 Pi 会话文件。
                  </p>
                  <h3>旧空会话</h3>
                  <p className="settings-copy">
                    新建后未使用的占位不会成为长期历史。旧版本留下的空会话可在这里手动清理；草稿、附件、图片、自定义设置和正在使用的会话会保留。
                  </p>
                  <button
                    disabled={pending}
                    onClick={() =>
                      void attempt(async () => {
                        const count = await api.invoke('cleanupEmptySessions');
                        setNotice(
                          count
                            ? `已清理 ${count} 个空会话`
                            : '未清理会话；有内容、自定义设置或正在使用的会话会保留。',
                        );
                      })
                    }
                  >
                    <Trash2 size={15} />
                    清理空会话
                  </button>
                </>
              )}
            </div>
          </div>
          <footer>
            <span className="settings-footer-note">
              {dirty
                ? '有尚未保存的修改。外观为预览，保存后长期生效。'
                : '设置已保存。运行环境路径在下一次启动对应进程时生效。'}
            </span>
            <button disabled={pending} onClick={requestClose}>
              关闭
            </button>
            <button className="primary" disabled={pending && !running} onClick={saveSettings}>
              {pending ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存设置
            </button>
          </footer>
        </Modal>
      )}
      {guard.confirmation}
    </>
  );
}
