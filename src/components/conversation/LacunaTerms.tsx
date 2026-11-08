/**
 * 知溯术语解释的界面：
 * - LacunaHover：鼠标停在带下划线的词上时显示简短解释，点击打开解释卡片；
 * - LacunaPanel：右侧的解释卡片，顶部是一路问下来的路径，卡片里的词也能接着点开；
 *   在卡片里选中文字，可以问“这是什么意思”，问题会填进输入框。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { lacunaQuestion, type LacunaNode, type LacunaTerm } from '../../../shared/lacuna';
import { LACUNA_TERM_CLASS } from '../../lib/lacuna-remark';
import {
  backToLacunaNode,
  closeLacunaPanel,
  currentLacunaSession,
  lacunaTerm,
  openLacunaNode,
  setLacunaMapView,
  useLacunaPanel,
  useLacunaRevision,
} from '../../lib/lacuna-store';
import { useLayer } from '../../hooks/useLayer';
import { LacunaMap } from './LacunaMap';
import { RichText } from './Markdown';

const api = window.desktop;
const SHOW_DELAY = 250;

/** 把“这是什么意思”的问题交给工作台：追加到输入框并聚焦，由用户确认后发送。 */
export function askLacuna(question: string) {
  window.dispatchEvent(new CustomEvent('pi:lacuna-ask', { detail: question }));
}

function termIds(element: Element): string[] {
  return (element.getAttribute('data-lacuna-ids') ?? '').split(' ').filter(Boolean);
}

export function LacunaHover() {
  const [hover, setHover] = useState<{ terms: LacunaTerm[]; x: number; y: number; above: boolean }>();
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | undefined;
    const target = (event: Event) =>
      event.target instanceof Element ? event.target.closest('.' + LACUNA_TERM_CLASS) : null;
    const over = (event: PointerEvent) => {
      const element = target(event);
      if (element === current) return;
      current = element ?? undefined;
      clearTimeout(timer);
      if (!element) {
        setHover(undefined);
        return;
      }
      timer = setTimeout(() => {
        const terms = termIds(element)
          .map(lacunaTerm)
          .filter((term): term is LacunaTerm => term !== undefined);
        if (terms.length === 0) return;
        const rect = element.getBoundingClientRect();
        const above = rect.bottom + 180 > window.innerHeight;
        setHover({
          terms,
          x: Math.max(8, Math.min(window.innerWidth - 328, rect.left)),
          y: above ? rect.top - 6 : rect.bottom + 6,
          above,
        });
      }, SHOW_DELAY);
    };
    const click = (event: MouseEvent) => {
      const element = target(event);
      if (!element || window.getSelection()?.toString()) return;
      const [id] = termIds(element);
      if (!id) return;
      clearTimeout(timer);
      setHover(undefined);
      openLacunaNode(id, element.closest('.lacuna-panel') !== null);
    };
    const hide = () => {
      clearTimeout(timer);
      current = undefined;
      setHover(undefined);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('click', click);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('click', click);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  if (!hover) return null;
  return (
    <div
      ref={card}
      className="lacuna-preview"
      role="tooltip"
      style={{ left: hover.x, top: hover.y, transform: hover.above ? 'translateY(-100%)' : undefined }}
    >
      {hover.terms.map((term) => (
        <div key={term.id} className="lacuna-preview-term">
          <strong>{term.title}</strong>
          {term.aliases.length > 0 && <span className="lacuna-aliases">{term.aliases.join(' · ')}</span>}
          <p>{term.summary || '还没有解释'}</p>
        </div>
      ))}
      <small>点击查看完整解释</small>
    </div>
  );
}

export function LacunaPanel() {
  const panel = useLacunaPanel();
  const revision = useLacunaRevision();
  const aside = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Record<string, LacunaNode | null>>({});
  const [ask, setAsk] = useState<{ text: string; x: number; y: number }>();
  const id = panel?.stack.at(-1);

  // 和侧边对话一样：只有窗口窄、面板盖在对话上面时才算弹层。靠边显示时不能算，
  // 否则输入框看到有弹层就不处理按键，回车发不出去。
  const [narrow, setNarrow] = useState(window.innerWidth < 900);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useLayer(aside, panel !== undefined && narrow, closeLacunaPanel, { kind: 'panel', trapFocus: true });
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || narrow || event.nativeEvent.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    closeLacunaPanel();
  };

  // 知识库变化后重新读取，解释可能被 agent 改过。
  useEffect(() => setNodes({}), [revision]);
  useEffect(() => {
    const session = currentLacunaSession();
    if (!id || !session || id in nodes) return;
    let cancelled = false;
    void api
      .invoke('lacunaNode', session, id)
      .catch(() => null)
      .then((node) => {
        if (!cancelled) setNodes((previous) => ({ ...previous, [id]: node }));
      });
    return () => {
      cancelled = true;
    };
  }, [id, nodes]);
  useLayoutEffect(() => {
    setAsk(undefined);
    aside.current?.querySelector('.lacuna-card')?.scrollTo({ top: 0 });
  }, [id]);

  if (!panel) return null;
  if (!id)
    return (
      <aside
        className={'lacuna-panel' + (panel.view === 'graph' ? ' wide' : '')}
        ref={aside}
        aria-label="知溯知识图"
        onKeyDown={escape}
      >
        <header>
          <strong className="lacuna-panel-title">知溯</strong>
          <div className="lacuna-tabs" role="tablist" aria-label="知识图的显示方式">
            {(
              [
                ['outline', '大纲'],
                ['graph', '关系图'],
              ] as const
            ).map(([view, label]) => (
              <button
                key={view}
                role="tab"
                aria-selected={panel.view === view}
                onClick={() => setLacunaMapView(view)}
              >
                {label}
              </button>
            ))}
          </div>
          <button aria-label="关闭知溯" onClick={closeLacunaPanel}>
            <X size={15} />
          </button>
        </header>
        <div className="lacuna-card lacuna-map-body">
          <LacunaMap view={panel.view} />
        </div>
      </aside>
    );
  const node = nodes[id];
  const title = (nodeId: string) => nodes[nodeId]?.title ?? lacunaTerm(nodeId)?.title ?? nodeId;

  const readSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!selection?.rangeCount || !text || !body.current?.contains(selection.anchorNode)) {
      setAsk(undefined);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const bounds = aside.current!.getBoundingClientRect();
    setAsk({ text, x: Math.max(8, rect.left - bounds.left), y: rect.top - bounds.top - 6 });
  };

  return (
    <aside className="lacuna-panel" ref={aside} aria-label="知溯解释" onKeyDown={escape}>
      <header>
        <nav aria-label="解释路径">
          <button onClick={() => backToLacunaNode(-1)}>知识图</button>
          {panel.stack.map((item, index) => (
            <span key={item + index}>
              <span className="lacuna-path-separator">›</span>
              {index === panel.stack.length - 1 ? (
                <strong aria-current="page">{title(item)}</strong>
              ) : (
                <button onClick={() => backToLacunaNode(index)}>{title(item)}</button>
              )}
            </span>
          ))}
        </nav>
        <button aria-label="关闭知溯解释" onClick={closeLacunaPanel}>
          <X size={15} />
        </button>
      </header>
      <div className="lacuna-card" onPointerUp={readSelection} onKeyUp={readSelection}>
        {node === undefined ? (
          <p className="lacuna-muted">正在读取解释…</p>
        ) : node === null ? (
          <p className="lacuna-muted">知识库里没有这个词了，可能已经被删除。</p>
        ) : (
          <>
            <h3>{node.title}</h3>
            {node.aliases.length > 0 && <p className="lacuna-aliases">也叫：{node.aliases.join('、')}</p>}
            <div className="message-content lacuna-body" ref={body}>
              {node.body ? <RichText text={node.body} terms /> : <p className="lacuna-muted">还没有解释</p>}
            </div>
            <LacunaRefs label="要先懂的" refs={node.dependsOn} />
            <LacunaRefs label="在这些地方问到" refs={node.dependedBy} />
          </>
        )}
      </div>
      {ask && node && (
        <button
          className="lacuna-ask"
          style={{ left: ask.x, top: ask.y }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            askLacuna(lacunaQuestion(ask.text, { id: node.id, title: node.title }));
            window.getSelection()?.removeAllRanges();
            setAsk(undefined);
          }}
        >
          这是什么意思
        </button>
      )}
    </aside>
  );
}

function LacunaRefs({ label, refs }: { label: string; refs: LacunaNode['dependsOn'] }) {
  const existing = refs.filter((ref) => ref.title !== undefined);
  if (existing.length === 0) return null;
  return (
    <section className="lacuna-refs">
      <h4>{label}</h4>
      <div>
        {existing.map((ref) => (
          <button key={ref.id} onClick={() => openLacunaNode(ref.id, true)}>
            {ref.title}
          </button>
        ))}
      </div>
    </section>
  );
}
