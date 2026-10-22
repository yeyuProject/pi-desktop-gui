import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export interface MarkdownParts {
  source: string;
  blocks: string[];
  offset: number;
  tail: string;
  plain: boolean;
}
const chunkSize = 4096;
/** Freeze complete root blocks, retaining the last two for list/table continuation.
 * References can change earlier blocks, so those documents retain whole-document semantics.
 */
export function streamingMarkdown(text: string, previous?: MarkdownParts): MarkdownParts {
  const references = /\[[^\]\n]*\](?!\()/.test(text);
  if (references || text.length < chunkSize * 2)
    return { source: text, blocks: [], offset: 0, tail: text, plain: text.length > 16000 };
  const append = previous && text.startsWith(previous.source);
  const blocks = append ? [...previous.blocks] : [];
  let offset = append ? previous.offset : 0;
  const tail = text.slice(offset);
  if (append && previous.plain && !text.slice(previous.source.length).includes('\n\n'))
    return { source: text, blocks, offset, tail, plain: true };
  // Parsing is only needed once the mutable suffix can yield another useful chunk.
  if (tail.length >= chunkSize * 2) {
    const tree = fromMarkdown(tail, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
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
  return { source: text, blocks, offset, tail: remaining, plain: remaining.length > 16000 };
}
