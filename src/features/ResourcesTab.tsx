import { RefreshCw, Plus, Pencil, Trash2, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import type { PromptTemplateInput, PromptTemplateDocument } from '../../shared/prompts';
import type { ResourceItem } from '../../shared/types';
import '../styles/management.css';
const api = window.desktop;
import type { FeatureModel } from './usePiFeatures';

type KindFilter = 'all' | ResourceItem['kind'];

const kindLabels: Record<ResourceItem['kind'], string> = {
  skills: 'Skill',
  prompts: '提示词模板',
  extensions: '扩展',
  themes: '主题',
};

const scopeLabels: Record<string, string> = {
  user: '个人',
  global: '个人',
  project: '当前项目',
  temporary: '临时',
};

function resourceDisplayName(r: ResourceItem) {
  if (r.name && r.name.trim()) return r.name.trim();
  const parts = r.path.split(/[\\/]/);
  const last = parts.at(-1) ?? r.path;
  if (r.kind === 'skills' && /^skill\.md$/i.test(last)) return parts.at(-2) || last;
  if (r.kind === 'skills' || r.kind === 'prompts') return last.replace(/\.md$/i, '');
  return last;
}

export function ResourcesTab({
  session,
  catalog,
  setCatalog,
  source,
  setSource,
  local,
  setLocal,
  resourceQuery,
  setResourceQuery,
  disabled,
  idleDisabled,
  idleReason,
  run,
  refresh,
  setFormDirty,
}: Pick<
  FeatureModel,
  | 'session'
  | 'filter'
  | 'catalog'
  | 'setCatalog'
  | 'source'
  | 'setSource'
  | 'local'
  | 'setLocal'
  | 'resourceQuery'
  | 'setResourceQuery'
  | 'kind'
  | 'disabled'
  | 'idleDisabled'
  | 'idleReason'
  | 'run'
  | 'refresh'
  | 'setFormDirty'
>) {
  const [template, setTemplate] = useState<PromptTemplateInput>();
  const [original, setOriginal] = useState<PromptTemplateDocument>();
  const [deleting, setDeleting] = useState<PromptTemplateDocument>();
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const edit = (value: PromptTemplateInput, document?: PromptTemplateDocument) => {
    setTemplate(value);
    setOriginal(document);
    setDeleting(undefined);
    setFormDirty(true);
  };
  const closeEditor = () => {
    setTemplate(undefined);
    setOriginal(undefined);
    setFormDirty(false);
  };
  const allResources = catalog?.resources ?? [];
  const counts = {
    all: allResources.length,
    skills: allResources.filter((r) => r.kind === 'skills').length,
    prompts: allResources.filter((r) => r.kind === 'prompts').length,
    extensions: allResources.filter((r) => r.kind === 'extensions').length,
    themes: allResources.filter((r) => r.kind === 'themes').length,
  };
  const kindTabs: [KindFilter, string, number][] = [
    ['all', '全部', counts.all],
    ['skills', 'Skills', counts.skills],
    ['prompts', '提示词模板', counts.prompts],
    ['extensions', '扩展', counts.extensions],
    ...(counts.themes > 0 || kindFilter === 'themes'
      ? ([['themes', '主题', counts.themes]] as [KindFilter, string, number][])
      : []),
  ];
  const byKind = kindFilter === 'all' ? allResources : allResources.filter((r) => r.kind === kindFilter);
  const enabledCount = byKind.filter((r) => r.enabled).length;
  const query = resourceQuery.trim().toLowerCase();
  const filteredResources = byKind.filter((r) => {
    if (!query) return true;
    const displayName = resourceDisplayName(r);
    const kindLabel = kindLabels[r.kind] ?? r.kind;
    const scopeLabel = scopeLabels[r.metadata.scope] ?? r.metadata.scope;
    return [
      displayName,
      r.description ?? '',
      r.argumentHint ?? '',
      r.kind,
      kindLabel,
      r.metadata.scope,
      scopeLabel,
      r.metadata.source ?? '',
      r.path,
    ]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
  return (
    <>
      <div className="settings-heading">
        <h3>Skills、扩展与提示词模板</h3>
        <div className="resource-header-actions">
          <button
            disabled={disabled || !!template}
            onClick={() =>
              edit({
                name: '',
                description: '',
                argumentHint: '',
                body: '',
                scope: session.projectId ? 'project' : 'global',
              })
            }
          >
            <Plus size={14} />
            新建提示词模板
          </button>
          <button disabled={disabled || !!template} onClick={() => void run(refresh)}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </div>
      {template && (
        <form
          className="prompt-editor"
          aria-label="提示词模板编辑器"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const saved = await api.invoke('promptSave', session.id, template, original);
              setOriginal(saved);
              await refresh();
              closeEditor();
            });
          }}
        >
          <h3>{original ? '编辑提示词模板' : '新建提示词模板'}</h3>
          <label>
            模板命令名
            <input
              className="input"
              aria-label="模板命令名"
              value={template.name}
              disabled={disabled || !!original}
              placeholder="例如 check-diff"
              maxLength={80}
              onChange={(e) => setTemplate({ ...template, name: e.target.value })}
            />
          </label>
          <label>
            简短说明
            <input
              className="input"
              aria-label="模板说明"
              value={template.description}
              disabled={disabled}
              maxLength={500}
              onChange={(e) => setTemplate({ ...template, description: e.target.value })}
            />
          </label>
          <label>
            参数提示（可选）
            <input
              className="input"
              aria-label="模板参数提示"
              value={template.argumentHint}
              disabled={disabled}
              placeholder="<目标文件> [关注点]"
              maxLength={200}
              onChange={(e) => setTemplate({ ...template, argumentHint: e.target.value })}
            />
          </label>
          <label>
            作用范围
            <select
              aria-label="模板作用范围"
              value={template.scope}
              disabled={disabled || !!original}
              onChange={(e) => setTemplate({ ...template, scope: e.target.value as 'global' | 'project' })}
            >
              <option value="global">个人全局</option>
              {session.projectId && <option value="project">仅当前项目</option>}
            </select>
          </label>
          <label>
            模板正文
            <textarea
              className="input"
              aria-label="模板正文"
              value={template.body}
              disabled={disabled}
              rows={9}
              onChange={(e) => setTemplate({ ...template, body: e.target.value })}
            />
          </label>
          <p className="settings-copy">
            使用 $1、$2 表示按顺序填写的参数，$ARGUMENTS 表示全部参数。保存为 Pi 原生 .md 模板。
          </p>
          {original && <p className="settings-copy">{original.path}</p>}
          <div className="button-row">
            <button
              type="submit"
              className="primary"
              disabled={disabled || !template.name || !template.body.trim()}
            >
              保存模板
            </button>
            <button type="button" disabled={disabled} onClick={closeEditor}>
              取消编辑
            </button>
          </div>
        </form>
      )}
      {deleting && (
        <div className="prompt-delete" role="alert">
          <p>删除提示词模板 /{deleting.name}？此操作会删除本机模板文件。</p>
          <code>{deleting.path}</code>
          <div className="button-row">
            <button
              className="danger"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await api.invoke('promptDelete', session.id, deleting.path, deleting.revision);
                  setDeleting(undefined);
                  await refresh();
                })
              }
            >
              删除模板
            </button>
            <button disabled={disabled} onClick={() => setDeleting(undefined)}>
              保留模板
            </button>
          </div>
        </div>
      )}
      <div className="resource-toolbar">
        <div className="segmented" role="radiogroup" aria-label="资源分类">
          {kindTabs.map(([id, title, count]) => (
            <button key={id} role="radio" aria-checked={kindFilter === id} onClick={() => setKindFilter(id)}>
              {title} ({count})
            </button>
          ))}
        </div>
        {byKind.length > 0 && (
          <small className="resource-summary">
            已启用 {enabledCount} / {byKind.length}
          </small>
        )}
      </div>
      <input
        className="input"
        aria-label="筛选资源"
        placeholder="按名称、简介、路径或类型筛选"
        value={resourceQuery}
        onChange={(e) => setResourceQuery(e.target.value)}
      />
      <div className="resource-list">
        {filteredResources.map((r) => {
          const displayName = resourceDisplayName(r);
          const fileName = r.path.split(/[\\/]/).at(-1) ?? r.path;
          const scopeLabel = scopeLabels[r.metadata.scope] ?? r.metadata.scope;
          const packageSource =
            r.metadata.origin === 'package' && r.metadata.source ? r.metadata.source : undefined;
          return (
            <div className={'resource-row' + (r.enabled ? '' : ' is-disabled')} key={r.kind + r.path}>
              <input
                type="checkbox"
                aria-label={'启用 ' + r.path}
                checked={r.enabled}
                disabled={disabled || !!template}
                onChange={(e) =>
                  void run(async () => {
                    const enabled = e.target.checked;
                    await api.invoke('toggleResource', session.id, r, enabled);
                    await refresh();
                    setCatalog((previous) =>
                      previous
                        ? {
                            ...previous,
                            resources: previous.resources.map((item) =>
                              item.path === r.path && item.kind === r.kind ? { ...item, enabled } : item,
                            ),
                          }
                        : previous,
                    );
                  })
                }
              />
              <span className="resource-main">
                <span className="resource-title-row">
                  <strong>{displayName}</strong>
                  {r.kind === 'skills' && <code className="resource-trigger">/skill:{displayName}</code>}
                  {r.kind === 'prompts' && (
                    <code className="resource-trigger">
                      /{displayName}
                      {r.argumentHint ? ' ' + r.argumentHint : ''}
                    </code>
                  )}
                  <span className="resource-badges">
                    <i className={'resource-badge kind-' + r.kind}>{kindLabels[r.kind]}</i>
                    <i className="resource-badge">{scopeLabel}</i>
                    {packageSource && (
                      <i className="resource-badge package" title={packageSource}>
                        {packageSource}
                      </i>
                    )}
                  </span>
                </span>
                {r.description && (
                  <span className="resource-description" title={r.description}>
                    {r.description}
                  </span>
                )}
                <code className="resource-path" title={r.path}>
                  {r.path}
                </code>
              </span>
              <div className="resource-actions">
                {r.kind === 'prompts' &&
                  (r.promptEditable ? (
                    <>
                      <button
                        disabled={disabled || !!template}
                        aria-label={`编辑模板 ${fileName}`}
                        onClick={() =>
                          void run(async () => {
                            const document = await api.invoke('promptRead', session.id, r.path);
                            edit(document, document);
                          })
                        }
                      >
                        <Pencil size={13} />
                        编辑
                      </button>
                      <button
                        disabled={disabled || !!template}
                        aria-label={`删除模板 ${fileName}`}
                        onClick={() =>
                          void run(async () => {
                            setDeleting(await api.invoke('promptRead', session.id, r.path));
                          })
                        }
                      >
                        <Trash2 size={13} />
                        删除
                      </button>
                    </>
                  ) : (
                    <small className="resource-readonly">只读</small>
                  ))}
                <button
                  disabled={disabled}
                  aria-label={`定位资源 ${displayName}`}
                  title="在编辑器或文件管理器中打开"
                  onClick={() => void run(() => api.invoke('openResource', session.id, r.path))}
                >
                  <FolderOpen size={13} />
                  定位
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {allResources.length > 0 && !filteredResources.length && (
        <p className="settings-copy">没有匹配当前筛选条件的资源。</p>
      )}
      {!allResources.length && (
        <p className="settings-copy">尚未发现额外资源。可以安装 npm / Git 包，也可以填写本机资源目录。</p>
      )}
      <h3>安装与管理资源包</h3>
      <p className="settings-copy">
        包安装会改动实际资源文件，需相关会话空闲；配置编辑和启用开关可先保存，空闲后加载。
      </p>
      <input
        className="input"
        aria-label="资源包来源"
        placeholder="npm:包名、git:仓库地址或本机完整路径"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      {session.projectId && (
        <label className="option-row">
          仅安装到当前项目
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
        </label>
      )}
      <div className="button-row">
        <button
          disabled={idleDisabled || !source.trim()}
          title={idleReason || (!source.trim() ? '请填写资源包来源' : '')}
          onClick={() =>
            void run(async () => {
              if (!(await api.invoke('packageAction', session.id, 'install', source, local))) return;
              setSource('');
              await refresh();
            })
          }
        >
          <Plus size={14} />
          安装
        </button>
        <button
          disabled={idleDisabled}
          title={idleReason}
          onClick={() =>
            void run(async () => {
              await api.invoke('packageAction', session.id, 'update', '', false);
              await refresh();
            })
          }
        >
          更新资源包
        </button>
        <button
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              await api.invoke('reloadPi', session.id);
              await refresh();
            })
          }
        >
          重新加载
        </button>
      </div>
      {(catalog?.packages ?? []).map((p) => (
        <div className="option-row" key={p.scope + p.source}>
          <span>
            {p.source}
            <small> · {scopeLabels[p.scope] ?? p.scope}</small>
          </span>
          <button
            disabled={idleDisabled}
            title={idleReason}
            onClick={() =>
              void run(async () => {
                await api.invoke('packageAction', session.id, 'remove', p.source, p.scope === 'project');
                await refresh();
              })
            }
          >
            移除
          </button>
        </div>
      ))}
      <details>
        <summary>当前工具（{catalog?.tools?.length ?? 0}）</summary>
        {(catalog?.tools ?? []).map((t) => (
          <p key={t.name}>
            <strong>{t.name}</strong>
            <small> {(catalog?.activeTools ?? []).includes(t.name) ? '已启用' : '按需调用'}</small>
            <br />
            {t.description.slice(0, 160)}
          </p>
        ))}
      </details>
    </>
  );
}
