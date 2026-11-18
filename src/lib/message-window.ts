import type { ConversationItem } from './conversation-layout';

export const messagePageSize = 80;
type VisibleConversationItem =
  | Extract<ConversationItem, { kind: 'message' }>
  | (Exclude<ConversationItem, { kind: 'message' }> & { visibleIndices: number[] });

/** Jumping to an old message must not mount every message after it. */
export function messageWindow(total: number, index: number) {
  const target = Math.max(0, Math.min(index, total - 1));
  const start =
    target >= total - messagePageSize
      ? Math.max(0, total - messagePageSize)
      : Math.floor(target / messagePageSize) * messagePageSize;
  return { start, end: Math.min(total, start + messagePageSize) };
}

/**
 * 1. 按分组末尾的消息序号找到第一个与窗口相交的分组。
 * 2. 只返回窗口内的消息，跨页分组保留完整摘要和本页的可见序号。
 */
export function windowConversation(
  items: ConversationItem[],
  start: number,
  end: number,
): VisibleConversationItem[] {
  // 1. 旧分组的序号小于本页起点，尾部续写时可以整段跳过。
  let first = 0,
    limit = items.length;
  while (first < limit) {
    const middle = Math.floor((first + limit) / 2);
    const item = items[middle];
    const last = item.kind === 'message' ? item.index : item.indices[item.indices.length - 1];
    if (last < start) {
      first = middle + 1;
      continue;
    }
    limit = middle;
  }
  // 2. 分组可以跨页；摘要仍使用原分组，正文只挂载本页。
  const visible: VisibleConversationItem[] = [];
  for (let i = first; i < items.length; i++) {
    const item = items[i];
    if ((item.kind === 'message' ? item.index : item.indices[0]) >= end) break;
    if (item.kind === 'message') {
      visible.push(item);
      continue;
    }
    const visibleIndices = item.indices.filter((index) => index >= start && index < end);
    if (visibleIndices.length) visible.push({ ...item, visibleIndices });
  }
  return visible;
}
