import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export interface MarkdownParts {
  source: string;
  blocks: string[];
  offset: number;
  tail: string;
  plain: boolean;
  parsedLength?: number;
  paragraphStart?: number;
}
const chunkSize = 1024;
// 只走 Markdown 和 GFM 都会原样输出的段落。包括词内下划线，但不包括强调、自动链接、列表或硬换行。
function literalParagraph(value: string) {
  return (
    value.length > 0 &&
    !/[^\p{L}\p{M}\p{N} _.,!?，。！？、；：“”‘’（）\n]/u.test(value) &&
    !/(?:^|\n)(?:\s|\d{1,9}\.(?:\s|$))| \n|[ \n]$|www\.|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/iu.test(value)
  );
}
function hasReferenceDefinition(text: string) {
  if (!/^ {0,3}\[[^\]]+\]:\s*\S/m.test(text)) return false;
  let fence: string | undefined;
  let width = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) {
        fence = marker[1][0];
        width = marker[1].length;
      } else if (marker[1][0] === fence && marker[1].length >= width && !marker[2].trim()) fence = undefined;
    } else if (!fence && /^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) return true;
  }
  return false;
}
/**
 * 1. 引用定义可能改变前文，出现时整篇解析。
 * 2. 只有追加正文才复用已完成的块。经解析器确认的末尾普通段落可直接续写。
 * 3. 尾部增长够一个分块再找切点，保留末尾两个根节点供列表、表格等继续扩展。
 */
export function streamingMarkdown(text: string, previous?: MarkdownParts): MarkdownParts {
  // 1. 后加的引用或脚注也可能改变之前的链接。
  if (hasReferenceDefinition(text))
    return { source: text, blocks: [], offset: 0, tail: text, plain: text.length > 16000 };
  const append = previous && text.startsWith(previous.source);
  // 2. 必须仍然是同一段普通正文；出现新的 Markdown 语法时交还给完整解析器。
  if (
    append &&
    previous.paragraphStart !== undefined &&
    literalParagraph(text.slice(previous.paragraphStart))
  ) {
    const tail = text.slice(previous.offset);
    return { ...previous, source: text, tail, plain: tail.length > 16000 };
  }
  const blocks = append ? [...previous.blocks] : [];
  let offset = append ? previous.offset : 0;
  const tail = text.slice(offset);
  if (append && previous.plain && !text.slice(previous.source.length).includes('\n\n'))
    return { source: text, blocks, offset, tail, plain: true };
  // Parsing is only needed once the mutable suffix can yield another useful chunk.
  // 3. 第一次识别段落边界，之后只在积累了足够的新内容时再次分块。
  const parsedLength = append ? (previous.parsedLength ?? 0) : 0;
  const scan =
    (!append && text.includes('\n\n')) ||
    (tail.length >= chunkSize * 2 && text.length - parsedLength >= chunkSize);
  let paragraphStart: number | undefined;
  if (scan) {
    const tree = fromMarkdown(tail, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const last = tree.children.at(-1);
    const at = last?.position?.start.offset;
    if (
      last?.type === 'paragraph' &&
      at !== undefined &&
      last.position?.start.column === 1 &&
      last.children.length === 1 &&
      last.children[0].type === 'text' &&
      last.children[0].value === tail.slice(at) &&
      literalParagraph(tail.slice(at))
    )
      paragraphStart = offset + at;
    let start = 0;
    for (let i = 1; i < tree.children.length - 1; i++) {
      const boundary = tree.children[i].position?.start.offset;
      if (boundary !== undefined && boundary - start >= chunkSize) {
        blocks.push(tail.slice(start, boundary));
        start = boundary;
      }
    }
    offset += start;
  }
  const remaining = text.slice(offset);
  return {
    source: text,
    blocks,
    offset,
    tail: remaining,
    plain: remaining.length > 16000,
    parsedLength: scan ? text.length : parsedLength,
    paragraphStart,
  };
}
