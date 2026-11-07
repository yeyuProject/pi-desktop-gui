/**
 * 把知溯的认词结果套到 Markdown 上：认出的词换成 <span class="lacuna-term">。
 *
 * 认词结果的位置是相对原始 Markdown 的；remark 解析出的文字节点也带着在原文里的位置，
 * 两者直接对得上。文字节点的内容和原文不一致时（转义字符、多行引用的前缀等）整个跳过，
 * 宁可少标，也不标错位置。
 */
import type { LacunaAnnotation, LacunaMatch } from '../../shared/lacuna';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: Record<string, unknown>;
}

/** 这些节点里的文字不认词：代码，以及已经是链接或图片的地方。 */
const SKIP = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'html',
  'definition',
]);

export const LACUNA_TERM_CLASS = 'lacuna-term';

export function remarkLacuna(options: { annotation: LacunaAnnotation; source: string }) {
  const { annotation, source } = options;
  return (tree: MdNode) => {
    if (annotation.matches.length > 0) visit(tree, annotation.matches, source);
  };
}

function visit(node: MdNode, matches: LacunaMatch[], source: string) {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    const parts = child.type === 'text' ? split(child, matches, source) : undefined;
    if (parts) next.push(...parts);
    else {
      visit(child, matches, source);
      next.push(child);
    }
  }
  node.children = next;
}

function split(node: MdNode, matches: LacunaMatch[], source: string): MdNode[] | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || source.slice(start, end) !== node.value) return undefined;
  const inside = matches.filter((match) => match.start >= start && match.end <= end);
  if (inside.length === 0) return undefined;
  const parts: MdNode[] = [];
  let cursor = start;
  for (const match of inside) {
    if (match.start < cursor) continue;
    if (match.start > cursor) parts.push({ type: 'text', value: source.slice(cursor, match.start) });
    parts.push(term(match));
    cursor = match.end;
  }
  if (cursor < end) parts.push({ type: 'text', value: source.slice(cursor, end) });
  return parts;
}

function term(match: LacunaMatch): MdNode {
  return {
    type: 'lacunaTerm',
    data: {
      hName: 'span',
      hProperties: { className: [LACUNA_TERM_CLASS], dataLacunaIds: match.ids.join(' ') },
    },
    children: [{ type: 'text', value: match.text }],
  };
}
