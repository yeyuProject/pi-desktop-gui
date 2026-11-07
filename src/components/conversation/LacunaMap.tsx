/**
 * 知溯知识图：右侧面板里的“大纲”和“关系图”。点任何一个词都打开它的解释卡片。
 * 数据来自主进程（lacunaGraph），布局在 src/lib/lacuna-layout.ts。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LacunaGraph, LacunaGraphResult, LacunaOutlineItem } from '../../../shared/lacuna';
import {
  filterOutline,
  labelWidth,
  layoutGraph,
  type GraphLayout,
  type LaidOutNode,
} from '../../lib/lacuna-layout';
import {
  currentLacunaSession,
  openLacunaNode,
  useLacunaRevision,
  type LacunaMapView,
} from '../../lib/lacuna-store';

const api = window.desktop;

export function LacunaMap({ view }: { view: LacunaMapView }) {
  const revision = useLacunaRevision();
  const [result, setResult] = useState<LacunaGraphResult>();
  useEffect(() => {
    const session = currentLacunaSession();
    if (!session) return;
    let cancelled = false;
    void api
      .invoke('lacunaGraph', session)
      .catch(() => undefined)
      .then((value) => {
        if (!cancelled) setResult(value ?? { reason: '读取知识图时出错，详细信息已写入诊断日志' });
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  if (!result) return <p className="lacuna-muted">正在读取知识图…</p>;
  if ('reason' in result) return <p className="lacuna-muted">{result.reason}</p>;
  if (result.graph.nodes.length === 0)
    return (
      <p className="lacuna-muted">知识库里还没有词。在对话里问“X 是什么意思”，有一定难度的词会记到这里。</p>
    );
  return view === 'outline' ? (
    <LacunaOutline graph={result.graph} />
  ) : (
    <LacunaGraphView graph={result.graph} />
  );
}

function LacunaOutline({ graph }: { graph: LacunaGraph }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== '';
  const topics = useMemo(() => filterOutline(graph.outline.topics, query), [graph, query]);
  const loose = useMemo(() => filterOutline(graph.outline.loose, query), [graph, query]);
  const toggle = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const row = (item: LacunaOutlineItem, key: string) => {
    const open = searching || !collapsed.has(key);
    return (
      <li key={key}>
        <div className={'lacuna-outline-row' + (item.type === 'topic' ? ' topic' : '')}>
          {item.children.length > 0 ? (
            <button
              className="lacuna-outline-toggle"
              aria-label={open ? `收起「${item.title}」` : `展开「${item.title}」`}
              aria-expanded={open}
              onClick={() => toggle(key)}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="lacuna-outline-spacer" />
          )}
          <button className="lacuna-outline-title" onClick={() => openLacunaNode(item.id)}>
            {item.title}
          </button>
          {item.repeated && (
            <span className="lacuna-muted" title="这个词在这棵树的上面已经出现过">
              ↺
            </span>
          )}
        </div>
        {open && item.children.length > 0 && (
          <ul>{item.children.map((child, index) => row(child, `${key}/${index}:${child.id}`))}</ul>
        )}
      </li>
    );
  };

  return (
    <div className="lacuna-map">
      <input
        className="lacuna-search"
        type="search"
        placeholder="搜索问过的词"
        aria-label="搜索问过的词"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {topics.length + loose.length === 0 ? (
        <p className="lacuna-muted">没有标题包含“{query.trim()}”的词</p>
      ) : (
        <>
          <ul className="lacuna-outline">{topics.map((item, index) => row(item, `t${index}:${item.id}`))}</ul>
          {loose.length > 0 && (
            <>
              <h4 className="lacuna-outline-heading">没有挂在选题下的词</h4>
              <ul className="lacuna-outline">
                {loose.map((item, index) => row(item, `l${index}:${item.id}`))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

type ViewBox = { x: number; y: number; width: number; height: number };
/**
 * 让整张图放进视口。节点少时不放大，最多 1:1，标签和正文差不多大，居中摆放；放不下时才缩小。
 */
const fit = (layout: GraphLayout, viewport?: { width: number; height: number }): ViewBox => {
  const { minX, minY, maxX, maxY } = layout.bounds;
  const width = Math.max(maxX - minX, viewport?.width ?? 0, 200);
  const height = Math.max(maxY - minY, viewport?.height ?? 0, 160);
  return { x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, width, height };
};

/** 标签放不下时截断，加省略号。 */
function shortTitle(node: LaidOutNode) {
  if (labelWidth(node.title) < 220) return node.title;
  let text = '';
  for (const char of node.title) {
    if (labelWidth(text + char + '…') >= 220) break;
    text += char;
  }
  return text + '…';
}

/** 从 from 的中心指向 to 的中心的线段，终点停在 to 的边框上，箭头才不会被方框盖住。 */
function edgeEnd(from: LaidOutNode, to: LaidOutNode) {
  const dx = from.x - to.x,
    dy = from.y - to.y;
  const scale = Math.min(
    dx === 0 ? Infinity : to.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : to.height / 2 / Math.abs(dy),
  );
  return { x: to.x + dx * Math.min(scale, 1), y: to.y + dy * Math.min(scale, 1) };
}

function LacunaGraphView({ graph }: { graph: LacunaGraph }) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const [box, setBox] = useState<ViewBox>(() => fit(layout));
  const [hover, setHover] = useState<string>();
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; box: ViewBox }>(undefined);
  const viewport = () =>
    svg.current ? { width: svg.current.clientWidth, height: svg.current.clientHeight } : undefined;
  useLayoutEffect(() => setBox(fit(layout, viewport())), [layout]);

  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const neighbors = useMemo(() => {
    if (!hover) return undefined;
    const set = new Set([hover]);
    for (const edge of layout.edges) {
      if (edge.from === hover) set.add(edge.to);
      if (edge.to === hover) set.add(edge.from);
    }
    return set;
  }, [hover, layout]);

  // 屏幕上移动的像素换算成图里的距离。
  const unit = () => box.width / (svg.current?.clientWidth || box.width);
  const zoom = (factor: number, clientX?: number, clientY?: number) => {
    const rect = svg.current?.getBoundingClientRect();
    const fx = rect && clientX !== undefined ? (clientX - rect.left) / rect.width : 0.5;
    const fy = rect && clientY !== undefined ? (clientY - rect.top) / rect.height : 0.5;
    setBox((current) => {
      const width = Math.min(Math.max(current.width * factor, 120), 20000);
      const height = (current.height * width) / current.width;
      return {
        x: current.x + (current.width - width) * fx,
        y: current.y + (current.height - height) * fy,
        width,
        height,
      };
    });
  };
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    // React 的 onWheel 是被动监听，阻止不了页面滚动，所以直接挂原生事件。
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(Math.exp(event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
    // zoom 只用到 ref 和 setBox，挂一次就够了。
  }, []);

  const down = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('.lacuna-graph-node')) return;
    drag.current = { x: event.clientX, y: event.clientY, box };
    svg.current?.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start) return;
    const scale = unit();
    setBox({
      ...start.box,
      x: start.box.x - (event.clientX - start.x) * scale,
      y: start.box.y - (event.clientY - start.y) * scale,
    });
  };
  const up = () => {
    drag.current = undefined;
  };

  return (
    <div className="lacuna-graph-wrap">
      <div className="lacuna-graph-tools">
        <button onClick={() => zoom(0.8)} aria-label="放大关系图">
          ＋
        </button>
        <button onClick={() => zoom(1.25)} aria-label="缩小关系图">
          －
        </button>
        <button onClick={() => setBox(fit(layout, viewport()))}>适应窗口</button>
      </div>
      <svg
        ref={svg}
        className="lacuna-graph"
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        role="group"
        aria-label="知识关系图：拖动平移，滚轮缩放，点击一个词查看解释"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <defs>
          <marker
            id="lacuna-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="lacuna-graph-arrow" />
          </marker>
        </defs>
        {layout.edges.map((edge) => {
          const from = byId.get(edge.from)!,
            to = byId.get(edge.to)!;
          const end = edgeEnd(from, to);
          const dim = neighbors && !(neighbors.has(edge.from) && neighbors.has(edge.to));
          return (
            <line
              key={edge.from + '→' + edge.to}
              className={'lacuna-graph-edge' + (dim ? ' dim' : '')}
              x1={from.x}
              y1={from.y}
              x2={end.x}
              y2={end.y}
              markerEnd="url(#lacuna-arrow)"
            />
          );
        })}
        {layout.nodes.map((node) => (
          <g
            key={node.id}
            className={
              'lacuna-graph-node' +
              (node.type === 'topic' ? ' topic' : '') +
              (neighbors && !neighbors.has(node.id) ? ' dim' : '')
            }
            transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
            role="button"
            tabIndex={0}
            aria-label={node.title}
            onPointerEnter={() => setHover(node.id)}
            onPointerLeave={() => setHover(undefined)}
            onFocus={() => setHover(node.id)}
            onBlur={() => setHover(undefined)}
            onClick={() => openLacunaNode(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openLacunaNode(node.id);
              }
            }}
          >
            <title>{node.title}</title>
            <rect width={node.width} height={node.height} rx={8} />
            <text x={node.width / 2} y={node.height / 2}>
              {shortTitle(node)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
