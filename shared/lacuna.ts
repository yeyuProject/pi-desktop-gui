/**
 * 知溯（lacuna）术语解释：主进程和界面共用的数据结构。
 * 主进程加载本机安装的 lacuna 库认词，界面只拿结果（lacuna ADR-0007、ADR-0009）。
 */

/** 悬停预览需要的信息。 */
export interface LacunaTerm {
  id: string;
  title: string;
  aliases: string[];
  /** 正文标题下的第一段，简短解释。 */
  summary: string;
}

/** 一段文字里认出的一个词。位置是这段文字里的 UTF-16 下标，[start, end)。 */
export interface LacunaMatch {
  start: number;
  end: number;
  /** 界面上显示的文字。`[[id|原文]]` 写法时是“原文”。 */
  text: string;
  ids: string[];
  kind: 'term' | 'link';
}

export interface LacunaAnnotation {
  matches: LacunaMatch[];
  /** matches 里出现的节点，按 id 查。 */
  terms: Record<string, LacunaTerm>;
}

export interface LacunaRef {
  id: string;
  /** 节点不存在时为空。 */
  title?: string;
}

/** 解释卡片显示的完整节点。 */
export interface LacunaNode extends LacunaTerm {
  type: 'concept' | 'topic' | 'adr' | undefined;
  /** 标题下的全部正文（Markdown）。 */
  body: string;
  dependsOn: LacunaRef[];
  /** 依赖这个节点的节点，也就是“在哪里问到了它”。 */
  dependedBy: LacunaRef[];
}

/** 大纲里的一项：一个词，以及在它的解释里问到的词。repeated 表示同一棵树上面已经出现过。 */
export interface LacunaOutlineItem {
  id: string;
  title: string;
  type: LacunaNode['type'];
  children: LacunaOutlineItem[];
  repeated?: true;
}

/** 知识图面板的数据：按选题组织的大纲，以及关系图要用的节点和边（from 依赖 to）。 */
export interface LacunaGraph {
  outline: { topics: LacunaOutlineItem[]; loose: LacunaOutlineItem[] };
  nodes: Array<{ id: string; title: string; type: LacunaNode['type'] }>;
  edges: Array<{ from: string; to: string }>;
}

export type LacunaGraphResult = { graph: LacunaGraph } | { reason: string };

export type LacunaStatus =
  | { available: true; scope: 'project' | 'personal'; root: string; nodeCount: number; revision: number }
  | { available: false; reason: string };

/** 一次最多认多少段文字、每段多长，防止渲染进程传入过多数据。 */
export const LACUNA_MAX_TEXTS = 200;
export const LACUNA_MAX_TEXT_LENGTH = 200_000;

/** “这是什么意思”填进输入框的问题。在某个节点的解释里问的，带上节点，方便 explain 记下依赖。 */
export function lacunaQuestion(text: string, context?: { id: string; title: string }): string {
  const term = text.replace(/\s+/g, ' ').trim();
  const where = context ? `（在「${context.title}」的解释里问的，节点 id：${context.id}）` : '';
  return `「${term}」是什么意思？${where}`;
}
