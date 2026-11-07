import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOutline, labelWidth, layoutGraph } from '../src/lib/lacuna-layout';
import type { LacunaGraph, LacunaOutlineItem } from '../shared/lacuna';

const graph: Pick<LacunaGraph, 'nodes' | 'edges'> = {
  nodes: [
    { id: 'topic', title: '如何优化 GPT-SoVITS 的效果', type: 'topic' },
    { id: 'vae', title: '变分自编码器', type: 'concept' },
    { id: 'latent', title: '隐变量', type: 'concept' },
    { id: 'zero', title: '零样本', type: 'concept' },
    { id: 'loop-a', title: '甲', type: 'concept' },
    { id: 'loop-b', title: '乙', type: 'concept' },
  ],
  edges: [
    { from: 'topic', to: 'vae' },
    { from: 'vae', to: 'latent' },
    { from: 'topic', to: 'zero' },
    { from: 'zero', to: 'latent' },
    { from: 'loop-a', to: 'loop-b' },
    { from: 'loop-b', to: 'loop-a' },
    { from: 'topic', to: 'missing' },
  ],
};

test('关系图布局：结果确定，没有重叠，选题在它问到的词上面', () => {
  const layout = layoutGraph(graph);
  assert.deepEqual(layoutGraph(graph), layout);
  assert.equal(layout.edges.length, 6, '指向不存在节点的边被去掉');
  for (const node of layout.nodes) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), node.id);
  for (const [i, a] of layout.nodes.entries())
    for (const b of layout.nodes.slice(i + 1)) {
      const apart =
        Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2;
      assert.ok(apart, `${a.id} 和 ${b.id} 重叠`);
    }
  const y = Object.fromEntries(layout.nodes.map((node) => [node.id, node.y]));
  assert.ok(y.topic! < y.vae! && y.vae! < y.latent!, '层次从上到下');
  const { bounds } = layout;
  assert.ok(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY);
});

test('标签宽度按中文和英文分别估算，有上限', () => {
  assert.equal(labelWidth('VAE'), 3 * 7 + 20);
  assert.equal(labelWidth('隐变量'), 3 * 13 + 20);
  assert.equal(labelWidth('长'.repeat(50)), 220);
});

test('大纲搜索保留匹配的词和它上面的路径', () => {
  const item = (title: string, children: LacunaOutlineItem[] = []): LacunaOutlineItem => ({
    id: title,
    title,
    type: 'concept',
    children,
  });
  const outline = [item('选题', [item('VAE', [item('隐变量')]), item('零样本')])];
  assert.deepEqual(filterOutline(outline, ''), outline);
  assert.deepEqual(filterOutline(outline, ' 隐变 '), [item('选题', [item('VAE', [item('隐变量')])])]);
  assert.deepEqual(filterOutline(outline, 'vae'), [item('选题', [item('VAE', [])])]);
  assert.deepEqual(filterOutline(outline, '没有'), []);
});
