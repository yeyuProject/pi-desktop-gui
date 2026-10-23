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

export function windowConversation(
  items: ConversationItem[],
  start: number,
  end: number,
): VisibleConversationItem[] {
  return items.flatMap((item): VisibleConversationItem[] => {
    if (item.kind === 'message') return item.index >= start && item.index < end ? [item] : [];
    const visibleIndices = item.indices.filter((index) => index >= start && index < end);
    // Keep the complete group for summary counts; only the visible rows mount.
    return visibleIndices.length ? [{ ...item, visibleIndices }] : [];
  });
}
