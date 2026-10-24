import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Search, LoaderCircle, MessageSquare, Pin, History, TextSearch } from 'lucide-react';
import { type AppState, type Session, type PiSessionInfo, type SessionMatch } from '../../shared/types';
import { shortcut } from '../lib/platform';
import { relativeTime } from '../lib/format';
import { Modal } from './Modal';
import { workbenchShortcuts } from '../../shared/workbench-actions';
const api = window.desktop;

export function QuickSwitch({
  state,
  query,
  setQuery,
  close,
  select,
  openFile,
}: {
  state: AppState;
  query: string;
  setQuery: (v: string) => void;
  close: () => void;
  select: (s: Session) => void;
  openFile: (file: string) => void;
}) {
  const [scope, setScope] = useState<'desktop' | 'pi' | 'actions'>('desktop'),
    [matches, setMatches] = useState<SessionMatch[]>([]),
    [external, setExternal] = useState<PiSessionInfo[] | undefined>(),
    [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const projectName = (id?: string) => state.projects.find((p) => p.id === id)?.name ?? '独立对话';
  useEffect(() => {
    if (scope !== 'desktop' || q.length < 2) {
      setMatches([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .invoke('searchSessions', q)
        .then((v) => alive && setMatches(v))
        .catch(() => {});
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
      void api.invoke('searchSessions', '').catch(() => {});
    };
  }, [q, scope]);
  useEffect(() => {
    if (scope === 'pi' && !external)
      void api
        .invoke('piSessions')
        .then(setExternal)
        .catch(() => setExternal([]));
  }, [scope]);
  useEffect(() => setIndex(0), [q, scope]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const titleHits = state.sessions
    .filter((s) => (s.title + ' ' + projectName(s.projectId)).toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const contentHits = matches.filter((m) => !titleHits.some((s) => s.id === m.sessionId));
  const rows: {
    key: string;
    icon: ReactNode;
    title: string;
    meta: string;
    snippet?: string;
    run: () => void;
  }[] =
    scope === 'actions'
      ? workbenchShortcuts
          .filter((binding) => binding.action !== 'search' && binding.label.includes(q))
          .map((binding) => ({
            key: binding.action,
            icon: <ChevronRight size={15} />,
            title: binding.label,
            meta: 'mod' in binding ? shortcut(binding.key.toUpperCase()) : `Alt+${binding.key}`,
            run: () => {
              close();
              setTimeout(
                () => window.dispatchEvent(new CustomEvent('pi:action', { detail: binding.action })),
                0,
              );
            },
          }))
      : scope === 'desktop'
        ? [
            ...titleHits.map((s) => ({
              key: s.id,
              icon: s.pinned ? <Pin size={15} /> : <MessageSquare size={15} />,
              title: s.title,
              meta: projectName(s.projectId) + ' · ' + relativeTime(s.updatedAt),
              run: () => select(s),
            })),
            ...contentHits.flatMap((m) => {
              const s = state.sessions.find((x) => x.id === m.sessionId);
              return s
                ? [
                    {
                      key: 'c' + s.id,
                      icon: <TextSearch size={15} />,
                      title: s.title,
                      meta: projectName(s.projectId) + ' · 内容匹配',
                      snippet: m.snippet,
                      run: () => select(s),
                    },
                  ]
                : [];
            }),
          ]
        : (external ?? [])
            .filter((x) => `${x.name ?? ''} ${x.preview} ${x.cwd}`.toLowerCase().includes(q))
            .map((x) => ({
              key: x.file,
              icon: <History size={15} />,
              title: x.name || x.preview || '未命名会话',
              meta: x.cwd + ' · ' + relativeTime(x.updatedAt),
              snippet: x.name ? x.preview : undefined,
              run: () => openFile(x.file),
            }));
  return (
    <Modal title="快速切换" subtitle={`搜索会话与操作 · ${shortcut('K')}`} close={close}>
      <div className="modal-body quick-switch">
        <div className="search-input">
          <Search size={18} />
          <input
            autoFocus
            aria-label="搜索项目和会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (rows.length)
                  setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
              }
              if (e.key === 'Enter' && rows[index]) {
                e.preventDefault();
                rows[index].run();
              }
            }}
            placeholder={
              scope === 'actions'
                ? '搜索操作，例如新建、变更、设置…'
                : scope === 'desktop'
                  ? '会话名称、项目或消息内容…'
                  : '搜索 Pi 保存的历史会话…'
            }
          />
        </div>
        <div className="scope-tabs" role="tablist">
          <button role="tab" aria-selected={scope === 'actions'} onClick={() => setScope('actions')}>
            操作
          </button>
          <button role="tab" aria-selected={scope === 'desktop'} onClick={() => setScope('desktop')}>
            桌面会话
          </button>
          <button role="tab" aria-selected={scope === 'pi'} onClick={() => setScope('pi')}>
            Pi 历史会话
          </button>
        </div>
        <div className="search-results" role="listbox" aria-label="搜索结果" ref={list}>
          {scope === 'pi' && !external ? (
            <p className="empty-small">
              <LoaderCircle size={14} className="spin" /> 正在读取 Pi 会话目录…
            </p>
          ) : !rows.length ? (
            <p className="empty-small">
              {scope === 'pi'
                ? '没有未打开过的 Pi 会话。在终端里用 pi 创建的会话会出现在这里。'
                : q.length === 1
                  ? '输入至少两个字可搜索消息内容'
                  : '没有匹配的会话'}
            </p>
          ) : (
            rows.map((r, i) => (
              <button
                key={r.key}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={r.run}
              >
                {r.icon}
                <span>
                  {r.title}
                  <small>{r.meta}</small>
                  {r.snippet && <em>{r.snippet}</em>}
                </span>
                <ChevronRight size={15} />
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
