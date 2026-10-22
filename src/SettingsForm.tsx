import { useEffect, useRef, useState } from 'react';
import type { ConfigDocument, Session } from '../shared/types';
import { configSaveNotice } from './lib/pi-features';

type Field =
  | { key: string; label: string; hint?: string; kind: 'bool'; fallback: boolean; userOnly?: boolean }
  | {
      key: string;
      label: string;
      hint?: string;
      kind: 'number';
      fallback: number;
      min: number;
      max: number;
      step?: number;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      kind: 'choice';
      fallback: string;
      options: [string, string][];
      userOnly?: boolean;
    }
  | { key: string; label: string; hint?: string; kind: 'text'; placeholder: string; userOnly?: boolean }
  | { key: string; label: string; hint?: string; kind: 'tools' };

const groups: { title: string; fields: Field[] }[] = [
  {
    title: '上下文与压缩',
    fields: [
      { key: 'compaction.enabled', label: '自动压缩上下文', kind: 'bool', fallback: true },
      {
        key: 'compaction.reserveTokens',
        label: '为回复预留',
        hint: '剩余空间低于这个值时开始压缩',
        kind: 'number',
        fallback: 16384,
        min: 1024,
        max: 200000,
        step: 1024,
      },
      {
        key: 'compaction.keepRecentTokens',
        label: '保留最近内容',
        hint: '压缩时原样保留的最近 tokens',
        kind: 'number',
        fallback: 20000,
        min: 0,
        max: 400000,
        step: 1000,
      },
      { key: 'branchSummary.skipPrompt', label: '切换分支时默认不总结', kind: 'bool', fallback: false },
    ],
  },
  {
    title: '失败重试',
    fields: [
      { key: 'retry.enabled', label: '临时错误自动重试', kind: 'bool', fallback: true },
      { key: 'retry.maxRetries', label: '最多重试', kind: 'number', fallback: 3, min: 0, max: 20 },
      {
        key: 'retry.baseDelayMs',
        label: '首次等待（毫秒）',
        hint: '之后每次加倍',
        kind: 'number',
        fallback: 2000,
        min: 0,
        max: 60000,
        step: 500,
      },
    ],
  },
  {
    title: '模型与工具',
    fields: [
      {
        key: 'defaultThinkingLevel',
        label: '新会话的推理级别',
        kind: 'choice',
        fallback: 'medium',
        options: [
          ['off', '关闭'],
          ['minimal', '最少'],
          ['low', '低'],
          ['medium', '中'],
          ['high', '高'],
          ['xhigh', '很高'],
        ],
      },
      {
        key: 'defaultTools',
        label: '启用的内置工具',
        hint: '取消勾选后模型无法使用该工具',
        kind: 'tools',
      },
      { key: 'enableSkillCommands', label: '把 Skills 注册为 /skill: 命令', kind: 'bool', fallback: true },
      { key: 'images.autoResize', label: '发送前缩小大图片', kind: 'bool', fallback: true },
      { key: 'images.blockImages', label: '禁止向模型发送图片', kind: 'bool', fallback: false },
    ],
  },
  {
    title: '命令与网络',
    fields: [
      { key: 'shellPath', label: 'Shell 路径', kind: 'text', placeholder: '使用系统默认' },
      {
        key: 'shellCommandPrefix',
        label: '命令前缀',
        hint: '加在每条命令前，例如激活虚拟环境',
        kind: 'text',
        placeholder: '无',
      },
      {
        key: 'httpProxy',
        label: 'HTTP 代理',
        kind: 'text',
        placeholder: 'http://127.0.0.1:7890',
        userOnly: true,
      },
      {
        key: 'transport',
        label: '传输方式',
        kind: 'choice',
        fallback: 'auto',
        options: [
          ['auto', '自动'],
          ['sse', 'SSE'],
          ['websocket', 'WebSocket'],
        ],
      },
    ],
  },
];
const builtinTools = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
const defaultToolSet = ['read', 'bash', 'edit', 'write'];

const getPath = (o: any, key: string) => key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function setPath(o: any, key: string, value: unknown) {
  const [head, ...rest] = key.split('.');
  if (!rest.length) {
    if (value === undefined) delete o[head];
    else o[head] = value;
    return;
  }
  if (!o[head] || typeof o[head] !== 'object' || Array.isArray(o[head])) {
    if (value === undefined) return;
    o[head] = {};
  }
  setPath(o[head], rest.join('.'), value);
  if (!Object.keys(o[head]).length) delete o[head];
}
function toolsFrom(value: unknown, inherited?: unknown): string[] {
  // Pi appends a project's modifier list to the personal list before resolving it.
  const merged =
    Array.isArray(inherited) &&
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' && /^[+-]/.test(v))
      ? [...inherited, ...value]
      : value === undefined
        ? inherited
        : value;
  if (!Array.isArray(merged)) return defaultToolSet;
  const entries = merged.filter((v): v is string => typeof v === 'string');
  const names = entries.filter((v) => !/^[+-]/.test(v));
  const selected = new Set(names.length || !entries.length ? names : defaultToolSet);
  for (const entry of entries) {
    if (entry.startsWith('+') && entry.length > 1) selected.add(entry.slice(1));
    else if (entry.startsWith('-')) selected.delete(entry.slice(1));
  }
  return [...selected];
}

export function SettingsForm({
  session,
  disabled,
  saveReason,
  projectEnabled,
  reportError,
  run,
  notify,
  dirtyChange,
}: {
  session: Session;
  disabled: boolean;
  saveReason: string;
  projectEnabled: boolean;
  reportError: (error: unknown) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  notify: (text: string) => void;
  dirtyChange: (dirty: boolean) => void;
}) {
  const api = window.desktop;
  const [local, setLocal] = useState(false),
    [document, setDocument] = useState<ConfigDocument>(),
    [values, setValues] = useState<Record<string, unknown>>({}),
    [inherited, setInherited] = useState<Record<string, unknown>>({}),
    [edits, setEdits] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const requestVersion = useRef(0);
  const dirty = Object.keys(edits).length > 0;
  const fieldsDisabled = disabled || loading || !document;
  useEffect(() => dirtyChange(dirty), [dirty]);
  const load = async (scope = local) => {
    const version = ++requestVersion.current;
    setLoading(true);
    reportError('');
    try {
      const [doc, personal] = await Promise.all([
        api.invoke('configRead', session.id, 'settings', scope),
        scope ? api.invoke('configRead', session.id, 'settings', false) : undefined,
      ]);
      if (version !== requestVersion.current) return;
      const values = JSON.parse(doc.text);
      const inherited = personal ? JSON.parse(personal.text) : {};
      setLocal(scope);
      setDocument(doc);
      setValues(values);
      setInherited(inherited);
      setEdits({});
    } catch (error) {
      if (version === requestVersion.current) reportError(error);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load(false);
    return () => {
      requestVersion.current++;
    };
  }, [session.id]);
  const value = (key: string) => (key in edits ? edits[key] : getPath(values, key));
  const edit = (key: string, v: unknown) =>
    setEdits((prev) => {
      const next = { ...prev, [key]: v };
      if (JSON.stringify(v) === JSON.stringify(getPath(values, key))) delete next[key];
      return next;
    });
  const save = () =>
    run(async () => {
      if (!document) return;
      const config = JSON.parse(document.text);
      for (const [key, v] of Object.entries(edits)) setPath(config, key, v === '' ? undefined : v);
      const version = requestVersion.current;
      const result = await api.invoke('configSave', session.id, 'settings', local, {
        ...document,
        text: JSON.stringify(config, null, 2),
      });
      if (version !== requestVersion.current) return;
      notify(result.applied ? '设置已保存，Pi 已重新加载。原文件已备份。' : configSaveNotice(result));
      setValues(config);
      setEdits({});
      setDocument(undefined);
      await load();
    });
  return (
    <div className="settings-form">
      <div className="settings-form-bar">
        {session.projectId ? (
          <div className="segmented" role="radiogroup" aria-label="设置范围">
            {(
              [
                [false, '个人（所有项目）'],
                [true, '仅当前项目'],
              ] as const
            ).map(([scope, title]) => (
              <button
                key={title}
                role="radio"
                aria-checked={local === scope}
                disabled={disabled || loading || dirty || (scope && !projectEnabled)}
                title={
                  scope && !projectEnabled ? '请先在工作区信任并启用项目' : dirty ? '请先保存或放弃修改' : ''
                }
                onClick={() => void load(scope)}
              >
                {title}
              </button>
            ))}
          </div>
        ) : (
          <span className="settings-copy">个人设置，对所有会话生效</span>
        )}
        <span className="spacer" />
        {dirty && (
          <button disabled={fieldsDisabled} onClick={() => setEdits({})}>
            放弃修改
          </button>
        )}
        <button
          className="primary"
          disabled={fieldsDisabled || Boolean(saveReason) || !dirty}
          title={saveReason || (!dirty ? '修改设置后即可保存' : '')}
          onClick={() => void save()}
        >
          保存并重新加载
        </button>
      </div>
      {!document && !loading && (
        <p className="environment-note">
          设置读取失败，请检查上方错误后 <button onClick={() => void load()}>重新读取设置</button>
        </p>
      )}
      {loading && (
        <p className="settings-copy" role="status">
          正在读取本机设置…
        </p>
      )}
      {dirty && <p className="environment-note">设置尚未保存。请保存或放弃修改后切换页面。</p>}
      {local && (
        <p className="environment-note">未单独设置的项沿用个人设置；只把本次修改写入 {document?.path}</p>
      )}
      {groups.map((g) => (
        <section key={g.title}>
          <h4>{g.title}</h4>
          {g.fields
            .filter((f) => !(local && 'userOnly' in f && f.userOnly))
            .map((f) => {
              const own = value(f.key);
              const v = own ?? getPath(inherited, f.key);
              const tools = toolsFrom(own, getPath(inherited, f.key));
              const changed = f.key in edits;
              return (
                <div className={'option-row' + (changed ? ' changed' : '')} key={f.key}>
                  <span>
                    {f.label}
                    {f.hint && <small>{f.hint}</small>}
                    {local && own === undefined && <small>沿用个人设置</small>}
                  </span>
                  {f.kind === 'bool' && (
                    <input
                      type="checkbox"
                      aria-label={f.label}
                      disabled={fieldsDisabled}
                      checked={typeof v === 'boolean' ? v : f.fallback}
                      onChange={(e) => edit(f.key, e.target.checked)}
                    />
                  )}
                  {f.kind === 'number' && (
                    <input
                      type="number"
                      aria-label={f.label}
                      disabled={fieldsDisabled}
                      min={f.min}
                      max={f.max}
                      step={f.step ?? 1}
                      placeholder={String(f.fallback)}
                      value={typeof v === 'number' ? v : ''}
                      onChange={(e) =>
                        edit(f.key, e.target.value === '' ? undefined : Number(e.target.value))
                      }
                      onBlur={(e) => {
                        if (e.target.value !== '')
                          edit(f.key, Math.max(f.min, Math.min(f.max, Number(e.target.value))));
                      }}
                    />
                  )}
                  {f.kind === 'choice' && (
                    <select
                      aria-label={f.label}
                      disabled={fieldsDisabled}
                      value={typeof v === 'string' ? v : f.fallback}
                      onChange={(e) => edit(f.key, e.target.value)}
                    >
                      {f.options.map(([id, title]) => (
                        <option key={id} value={id}>
                          {title}
                        </option>
                      ))}
                    </select>
                  )}
                  {f.kind === 'text' && (
                    <input
                      aria-label={f.label}
                      disabled={fieldsDisabled}
                      placeholder={f.placeholder}
                      value={typeof v === 'string' ? v : ''}
                      onChange={(e) => edit(f.key, e.target.value)}
                    />
                  )}
                  {f.kind === 'tools' && (
                    <span className="tool-checks">
                      {builtinTools.map((tool) => {
                        const enabled = tools.includes(tool);
                        return (
                          <label key={tool}>
                            <input
                              type="checkbox"
                              disabled={fieldsDisabled}
                              checked={enabled}
                              onChange={() => {
                                const next = enabled ? tools.filter((t) => t !== tool) : [...tools, tool];
                                // Pi treats an empty project list as no additions to a personal list.
                                // Explicit removals make clearing all checkboxes disable inherited tools.
                                edit(
                                  f.key,
                                  local && !next.length
                                    ? toolsFrom(getPath(inherited, f.key)).map((name) => '-' + name)
                                    : next,
                                );
                              }}
                            />
                            <code>{tool}</code>
                          </label>
                        );
                      })}
                    </span>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      <p className="settings-copy">
        这里只修改上面列出的项，文件里的其他设置保持不变。更多选项可在“完整 Pi 设置”中编辑 JSON。
      </p>
    </div>
  );
}
