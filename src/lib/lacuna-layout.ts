/**
 * 知识图的纯函数：关系图的布局和大纲的过滤。结果确定（不用随机数），方便测试。
 *
 * 先按层次摆好：选题（或者没有被依赖的词）在最上面，往下一层是在它的解释里问到的词；
 * 再用力导向调整：节点之间互相排斥、有边的互相吸引，并轻轻拉住各自的层次高度，
 * 让图保持“从选题往下问”的方向；最后消除节点之间的重叠。
 */
import type { LacunaGraph, LacunaOutlineItem } from '../../shared/lacuna';

export interface LaidOutNode {
  id: string;
  title: string;
  type: LacunaGraph['nodes'][number]['type'];
  /** 中心点。 */
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LacunaGraph['edges'];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const NODE_HEIGHT = 28;
const LEVEL_GAP = 96;
const EDGE_LENGTH = 120;
const PADDING = 24;

/** 估算标签宽度：中日韩字符按 13px，其他按 7px，左右各留 10px。 */
export function labelWidth(title: string) {
  let width = 0;
  for (const char of title) width += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 13 : 7;
  return Math.min(220, width + 20);
}

export function layoutGraph(graph: Pick<LacunaGraph, 'nodes' | 'edges'>): GraphLayout {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const depth = depths(graph.nodes, edges);

  // 初始位置：每一层从左到右排开，整层居中。
  const levels = new Map<number, string[]>();
  for (const node of graph.nodes)
    levels.set(depth.get(node.id)!, [...(levels.get(depth.get(node.id)!) ?? []), node.id]);
  const nodes: LaidOutNode[] = graph.nodes.map((node) => {
    const level = depth.get(node.id)!;
    const row = levels.get(level)!;
    const index = row.indexOf(node.id);
    return {
      id: node.id,
      title: node.title,
      type: node.type,
      x: (index - (row.length - 1) / 2) * 150,
      y: level * LEVEL_GAP,
      width: labelWidth(node.title),
      height: NODE_HEIGHT,
      depth: level,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // 节点多时减少迭代次数：每次迭代是 O(n²)。
  const iterations = nodes.length > 300 ? 80 : nodes.length > 100 ? 160 : 300;
  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations;
    const force = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!,
          b = nodes[j]!;
        let dx = b.x - a.x;
        const dy = b.y - a.y;
        // 两个点重合时按下标错开，保持结果确定。
        if (dx === 0 && dy === 0) dx = j - i;
        const distanceSquared = Math.max(dx * dx + dy * dy, 100);
        const push = 9000 / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        force.get(a.id)!.x -= (dx / distance) * push;
        force.get(a.id)!.y -= (dy / distance) * push;
        force.get(b.id)!.x += (dx / distance) * push;
        force.get(b.id)!.y += (dy / distance) * push;
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.from)!,
        b = byId.get(edge.to)!;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const pull = (distance - EDGE_LENGTH) * 0.05;
      force.get(a.id)!.x += (dx / distance) * pull;
      force.get(a.id)!.y += (dy / distance) * pull;
      force.get(b.id)!.x -= (dx / distance) * pull;
      force.get(b.id)!.y -= (dy / distance) * pull;
    }
    for (const node of nodes) {
      const f = force.get(node.id)!;
      // 拉住层次高度，并轻轻拉向中间，免得不相连的部分越漂越远。
      f.y += (node.depth * LEVEL_GAP - node.y) * 0.08;
      f.x -= node.x * 0.004;
      const limit = 30 * cooling + 1;
      node.x += Math.max(-limit, Math.min(limit, f.x));
      node.y += Math.max(-limit, Math.min(limit, f.y));
    }
  }
  separate(nodes);

  const bounds = nodes.reduce(
    (box, node) => ({
      minX: Math.min(box.minX, node.x - node.width / 2 - PADDING),
      minY: Math.min(box.minY, node.y - node.height / 2 - PADDING),
      maxX: Math.max(box.maxX, node.x + node.width / 2 + PADDING),
      maxY: Math.max(box.maxY, node.y + node.height / 2 + PADDING),
    }),
    { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  );
  return { nodes, edges, bounds };
}

/** 层次：从没有被依赖的节点（通常是选题）出发按依赖往下数；成环找不到起点的，从 0 开始。 */
function depths(nodes: LacunaGraph['nodes'], edges: LacunaGraph['edges']) {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of edges) {
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
    hasParent.add(edge.to);
  }
  const depth = new Map<string, number>();
  const roots = [
    ...nodes.filter((node) => node.type === 'topic'),
    ...nodes.filter((node) => node.type !== 'topic' && !hasParent.has(node.id)),
  ];
  const visit = (start: string) => {
    if (depth.has(start)) return;
    depth.set(start, 0);
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const child of children.get(id) ?? []) {
        if (depth.has(child)) continue;
        depth.set(child, depth.get(id)! + 1);
        queue.push(child);
      }
    }
  };
  for (const root of roots) visit(root.id);
  for (const node of nodes) visit(node.id);
  return depth;
}

/** 消除重叠：两两检查，重叠就沿重叠较少的方向推开，最多重复几轮。 */
function separate(nodes: LaidOutNode[]) {
  for (let round = 0; round < 50; round++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!,
          b = nodes[j]!;
        const overlapX = (a.width + b.width) / 2 + 12 - Math.abs(b.x - a.x);
        const overlapY = (a.height + b.height) / 2 + 12 - Math.abs(b.y - a.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        if (overlapX < overlapY) {
          const shift = (overlapX / 2) * (b.x >= a.x ? 1 : -1);
          a.x -= shift;
          b.x += shift;
        } else {
          const shift = (overlapY / 2) * (b.y >= a.y ? 1 : -1);
          a.y -= shift;
          b.y += shift;
        }
      }
    }
    if (!moved) return;
  }
}

/** 按标题过滤大纲：保留标题匹配的项，以及有匹配后代的项（这样能看出它是从哪一路问下来的）。 */
export function filterOutline(items: LacunaOutlineItem[], query: string): LacunaOutlineItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.flatMap((item) => {
    const children = filterOutline(item.children, needle);
    return item.title.toLowerCase().includes(needle) || children.length > 0 ? [{ ...item, children }] : [];
  });
}
