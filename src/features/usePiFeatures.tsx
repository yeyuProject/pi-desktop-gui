import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  type ConfigDocument,
  type ConfigKind,
  type Runtime,
  type Session,
  type TreeEntry,
  type ResourceCatalog,
  type ProviderInfo,
  type Environment,
  type StorageStatus,
} from '../../shared/types';
import { emptyRuntime } from '../../shared/types';
import { configSaveNotice, piFeatureAvailability } from '../lib/pi-features';
import type { LocalUsageSummary } from '../../shared/usage';
const api = window.desktop;
export function usePiFeatures({
  session,
  runtime,
  initialTab,
  close,
  environment,
  storage,
  projectEnabled,
}: {
  session: Session;
  runtime: Runtime;
  initialTab: string;
  close: () => void;
  environment?: Environment;
  storage: StorageStatus;
  projectEnabled: boolean;
}) {
  const [tab, setTab] = useState(initialTab),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false),
    [readingConfig, setReadingConfig] = useState(false),
    [deferred, setDeferred] = useState(false);
  const requestVersion = useRef(0);
  const actionPending = useRef(false);
  const currentRuntime = runtime.sessionId === session.id ? runtime : emptyRuntime();
  const [tree, setTree] = useState<TreeEntry[]>([]),
    [filter, setFilter] = useState(''),
    [treeMode, setTreeMode] = useState<'conversation' | 'user' | 'labeled' | 'all'>('conversation'),
    [labeling, setLabeling] = useState<{ id: string; text: string }>(),
    [instructions, setInstructions] = useState(''),
    [summarize, setSummarize] = useState(false);
  const [catalog, setCatalog] = useState<ResourceCatalog>(),
    [source, setSource] = useState(''),
    [local, setLocal] = useState(false);
  const [resourceQuery, setResourceQuery] = useState('');
  const [usage, setUsage] = useState<LocalUsageSummary>();
  const [imageModel, setImageModel] = useState(false),
    [reasoningModel, setReasoningModel] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]),
    [provider, setProvider] = useState(''),
    [providerQuery, setProviderQuery] = useState('');
  const [kind, setKind] = useState<ConfigKind>(
      initialTab === 'mcp' ? 'mcp' : initialTab === 'providers' ? 'models' : 'settings',
    ),
    [document, setDocument] = useState<ConfigDocument>(),
    [jsonDirty, setDirty] = useState(false),
    [formDirty, setFormDirty] = useState(false);
  const dirty = jsonDirty || formDirty;
  const [providerId, setProviderId] = useState(''),
    [baseUrl, setBaseUrl] = useState(''),
    [apiType, setApiType] = useState('openai-completions'),
    [apiKey, setApiKey] = useState(''),
    [modelIds, setModelIds] = useState('');
  const [serverName, setServerName] = useState(''),
    [serverType, setServerType] = useState('http'),
    [serverTarget, setServerTarget] = useState(''),
    [serverArgs, setServerArgs] = useState('[]');
  const { operationReason, prerequisiteReason, engineReason, idleReason } = piFeatureAvailability({
    runtime: currentRuntime,
    pending,
    environment,
    storage,
    projectEnabled,
  });
  const disabled = Boolean(engineReason) || loading;
  const reportError = (e: unknown) =>
    setError(
      String(e instanceof Error ? e.message : e).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        '',
      ),
    );
  const run = async (fn: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      reportError(e);
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };
  const read = async (k = kind, scope = local) => {
    const version = ++requestVersion.current;
    setReadingConfig(true);
    setLoading(true);
    try {
      const doc = await api.invoke('configRead', session.id, k, scope);
      if (version !== requestVersion.current) return;
      setDocument(doc);
      setLocal(scope);
      setDirty(false);
    } finally {
      if (version === requestVersion.current) {
        setReadingConfig(false);
        setLoading(false);
      }
    }
  };
  const refresh = async () => {
    const version = ++requestVersion.current;
    const current = () => version === requestVersion.current;
    setLoading(true);
    setReadingConfig(['settings', 'mcp', 'providers'].includes(tab) && !jsonDirty);
    setDeferred(false);
    setError('');
    try {
      if (['settings', 'mcp', 'providers'].includes(tab) && !jsonDirty) {
        const doc = await api.invoke(
          'configRead',
          session.id,
          tab === 'providers' ? 'models' : tab === 'mcp' ? 'mcp' : 'settings',
          tab === 'providers' ? false : local,
        );
        if (!current()) return;
        setDocument(doc);
        setDirty(false);
        setReadingConfig(false);
      }
      if (tab === 'prefs' || tab === 'settings' || tab === 'mcp' || tab === 'help') return;
      if (tab === 'session') {
        const summary = await api.invoke('usageSummary');
        if (!current()) return;
        setUsage(summary);
        if (currentRuntime.connected) return;
      }
      if (engineReason) {
        setDeferred(true);
        return;
      }
      if (tab === 'tree') {
        const entries = await api.invoke('sessionTree', session.id);
        if (current()) setTree(entries);
      } else if (tab === 'resources') {
        const resources = await api.invoke('resources', session.id);
        if (current()) setCatalog(resources);
      } else if (tab === 'providers') {
        const available = await api.invoke('providers', session.id);
        if (current()) setProviders(available);
      } else if (tab === 'session') await api.invoke('connect', session.id);
    } catch (e) {
      if (current()) reportError(e);
    } finally {
      if (current()) {
        setLoading(false);
        setReadingConfig(false);
      }
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      requestVersion.current++;
    };
  }, [tab, session.id]);
  useEffect(() => {
    if (deferred && !engineReason && !dirty) void refresh();
  }, [deferred, engineReason, dirty]);
  const exportFile = (format: 'html' | 'jsonl') =>
    run(async () => {
      const file = await api.invoke('exportSession', session.id, format);
      if (file) setNotice('已导出：' + file);
    });
  const addJson = (key: string, id: string, value: unknown) => {
    if (!document || !id.trim() || ['__proto__', 'constructor', 'prototype'].includes(id))
      throw new Error('请输入有效名称');
    const config = JSON.parse(document.text);
    if (config[key]?.[id]) throw new Error('名称已存在，请在配置中编辑，或使用新名称');
    config[key] = { ...config[key], [id]: value };
    setDocument({ ...document, text: JSON.stringify(config, null, 2) });
    setDirty(true);
  };
  const configEditor = (k: ConfigKind) => (
    <div className="config-editor">
      <div className="button-row">
        {session.projectId && k !== 'models' && (
          <label>
            范围{' '}
            <select
              aria-label="配置范围"
              value={local ? 'project' : 'user'}
              disabled={pending || readingConfig || dirty}
              onChange={(e) => {
                const scope = e.target.value === 'project';
                void run(() => read(k, scope));
              }}
            >
              <option value="user">个人</option>
              <option value="project" disabled={!projectEnabled}>
                当前项目{!projectEnabled ? '（请先信任并启用）' : ''}
              </option>
            </select>
          </label>
        )}
        <button disabled={pending || readingConfig} onClick={() => void run(() => read(k))}>
          <RefreshCw size={14} />
          {dirty ? '放弃修改并重新读取' : '重新读取'}
        </button>
        <button
          disabled={Boolean(operationReason) || loading || !dirty || !document}
          title={
            operationReason ||
            (loading
              ? '正在读取此页数据，请稍候'
              : !dirty
                ? '修改配置后即可保存'
                : !document
                  ? '请先重新读取配置'
                  : '')
          }
          className="primary"
          onClick={() =>
            void run(async () => {
              const version = requestVersion.current;
              const result = await api.invoke('configSave', session.id, k, local, document!);
              if (version !== requestVersion.current) return;
              setApiKey('');
              setNotice(configSaveNotice(result));
              // Persistence succeeded. Do not retry with the old revision if the subsequent read fails.
              setDirty(false);
              setDocument(undefined);
              await read(k);
            })
          }
        >
          保存并应用
        </button>
      </div>
      <p className="settings-copy">
        {document?.path}
        <br />
        {!document?.error && '已有密钥显示为占位符，保存时保留原值。'}
        修改前会保留备份；运行中可保存，相关会话空闲后加载。加载失败时保留配置并显示原因。
      </p>
      {document?.error && (
        <p className="environment-note" role="alert">
          {document.error}
        </p>
      )}
      <textarea
        className="json-editor"
        aria-label="Pi 配置 JSON"
        spellCheck={false}
        value={document?.text ?? ''}
        disabled={pending || readingConfig || !document}
        onChange={(e) => {
          setDocument((d) => (d ? { ...d, text: e.target.value } : d));
          setDirty(true);
        }}
      />
      {dirty && (
        <p className="environment-note">配置尚未保存。请保存或放弃修改后切换页面；关闭窗口将放弃本次编辑。</p>
      )}
    </div>
  );
  return {
    session,
    runtime: currentRuntime,
    usage,
    close,
    setNotice,
    instructions,
    setInstructions,
    disabled,
    configEditingDisabled: pending || readingConfig || !document,
    operationReason,
    prerequisiteReason,
    engineReason,
    idleReason,
    idleDisabled: Boolean(idleReason) || loading,
    loading,
    reportError,
    projectEnabled,
    run,
    exportFile,
    tree,
    setTree,
    filter,
    setFilter,
    treeMode,
    setTreeMode,
    labeling,
    setLabeling,
    summarize,
    setSummarize,
    refresh,
    catalog,
    setCatalog,
    source,
    setSource,
    local,
    setLocal,
    resourceQuery,
    setResourceQuery,
    kind,
    imageModel,
    setImageModel,
    reasoningModel,
    setReasoningModel,
    providers,
    provider,
    setProvider,
    providerQuery,
    setProviderQuery,
    document,
    providerId,
    setProviderId,
    baseUrl,
    setBaseUrl,
    apiType,
    setApiType,
    apiKey,
    setApiKey,
    modelIds,
    setModelIds,
    addJson,
    configEditor,
    setDocument,
    setDirty,
    serverName,
    setServerName,
    serverType,
    setServerType,
    serverTarget,
    setServerTarget,
    serverArgs,
    setServerArgs,
    setFormDirty,
    tab,
    setTab,
    pending,
    error,
    notice,
    setKind,
    dirty,
  };
}
export type FeatureModel = ReturnType<typeof usePiFeatures>;
