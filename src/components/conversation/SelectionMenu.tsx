import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Message } from '../../../shared/types';
import type { DraftQuote } from '../../../shared/message-content';
import { turnThinking, type TurnItem } from '../../lib/conversation-layout';

export function SelectionMenu({
  thread,
  messages,
  turns,
  addQuote,
  notice,
}: {
  thread: RefObject<HTMLDivElement | null>;
  messages: Message[];
  turns: TurnItem[];
  addQuote: (quote: DraftQuote) => void;
  notice: (text: string) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    quote: DraftQuote;
    range: Range;
    cross: boolean;
    x: number;
    y: number;
    below: boolean;
  }>();
  const latest = useRef({ messages, turns, addQuote, notice, selection });
  latest.current = { messages, turns, addQuote, notice, selection };
  useEffect(() => {
    const read = () => {
      if (document.activeElement?.matches('input,textarea,[contenteditable="true"]')) return;
      const selected = window.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) return;
      const range = selected.getRangeAt(0).cloneRange();
      const start =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      if (!start || start.closest('button,summary,.arguments,.search-snippet')) return;
      const root = start.closest<HTMLElement>(
        '.message-content,.thinking pre,.tool-body .ansi-output,.tool-body .diff-view,.bash-message .ansi-output',
      );
      const wrapper = root?.closest<HTMLElement>(
        '[data-quote-tool-id],[data-quote-thinking-owner],[data-message-index]',
      );
      if (!root || !wrapper || !thread.current?.contains(wrapper)) return;
      let index = Number(wrapper.dataset.quoteThinkingOwner ?? wrapper.dataset.messageIndex);
      let cross = !wrapper.contains(range.endContainer);
      if (!root.contains(range.endContainer)) range.setEnd(root, root.childNodes.length);
      if (wrapper.dataset.quoteThinkingOwner !== undefined) {
        const group = turnThinking(latest.current.messages).find((item) => item.owner === index);
        const prefix = range.cloneRange();
        prefix.selectNodeContents(root);
        prefix.setEnd(range.startContainer, range.startOffset);
        const part = group?.parts.findLast((item) => item.offset <= prefix.toString().length);
        if (!part) return;
        index = part.index;
        const next = group!.parts.find((item) => item.offset > part.offset && item.index !== index);
        if (next) {
          const end = next.offset - 2;
          const suffix = range.cloneRange();
          suffix.selectNodeContents(root);
          suffix.setEnd(range.endContainer, range.endOffset);
          if (suffix.toString().length > end) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let offset = 0;
            while (walker.nextNode()) {
              const node = walker.currentNode as Text;
              if (offset + node.length >= end) {
                range.setEnd(node, end - offset);
                break;
              }
              offset += node.length;
            }
            cross = true;
          }
        }
      }
      const message = latest.current.messages[index];
      const turn = latest.current.turns.findLast((turn) => turn.index <= index);
      const tool = wrapper.dataset.quoteToolId !== undefined;
      const shell = message?.role === 'bashExecution';
      if (
        !tool &&
        (!message ||
          message.timestamp === undefined ||
          (!turn && !shell) ||
          !['user', 'assistant', 'toolResult', 'bashExecution'].includes(message.role))
      )
        return;
      const text = range.toString();
      if (!text.trim()) return;
      const bounds = range.getBoundingClientRect(),
        viewport = thread.current.getBoundingClientRect();
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return;
      const section: DraftQuote['section'] = start.closest('.code-block pre')
        ? 'code'
        : start.closest('.thinking')
          ? 'thinking'
          : tool || shell || message.role === 'toolResult'
            ? 'tool'
            : start.closest('.skill-content')
              ? 'skill'
              : 'text';
      return {
        quote: {
          id: crypto.randomUUID(),
          text,
          role: tool || shell ? 'toolResult' : (message.role as DraftQuote['role']),
          turn: tool ? Number(wrapper.dataset.quoteTurn) : (turn?.turn ?? 0),
          messageTimestamp: tool ? Number(wrapper.dataset.quoteTimestamp) : message.timestamp!,
          ...(tool ? { toolCallId: wrapper.dataset.quoteToolId } : {}),
          section,
        },
        range,
        cross,
        x: Math.max(8, Math.min(window.innerWidth - 240, bounds.left)),
        y:
          bounds.top - viewport.top < (menu.current?.offsetHeight ?? 36) + 6
            ? Math.min(bounds.bottom + 6, viewport.bottom - 40)
            : bounds.top - 6,
        below: bounds.top - viewport.top < (menu.current?.offsetHeight ?? 36) + 6,
      };
    };
    const update = () => setSelection(read());
    const pointerUp = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return;
      if (thread.current?.contains(event.target as Node)) update();
      else setSelection(undefined);
    };
    const keyboardSelection = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update();
    };
    const quote = () => {
      const current = read() ?? latest.current.selection;
      if (!current) return;
      if (current.cross) latest.current.notice('选区跨过多条消息，只引用了第一条消息内的内容');
      latest.current.addQuote(current.quote);
      setSelection(undefined);
    };
    const side = () => {
      const current = read();
      window.dispatchEvent(
        new CustomEvent('pi:side', { detail: current ? { quote: current.quote } : undefined }),
      );
      setSelection(undefined);
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setSelection(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && latest.current.selection && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setSelection(undefined);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('pointerup', pointerUp);
    document.addEventListener('keyup', keyboardSelection);
    document.addEventListener('keydown', escape);
    thread.current?.addEventListener('scroll', update, true);
    window.addEventListener('pi:quote-selection', quote);
    window.addEventListener('pi:side-action', side);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('keyup', keyboardSelection);
      document.removeEventListener('keydown', escape);
      thread.current?.removeEventListener('scroll', update, true);
      window.removeEventListener('pi:quote-selection', quote);
      window.removeEventListener('pi:side-action', side);
    };
  }, [thread]);
  if (!selection) return null;
  return (
    <div
      className="selection-menu"
      role="toolbar"
      aria-label="对话选区操作"
      ref={menu}
      style={{ left: selection.x, top: selection.y, transform: selection.below ? 'none' : undefined }}
      onPointerDown={(event) => event.preventDefault()}
    >
      <button
        onClick={() => {
          if (selection.cross) notice('选区跨过多条消息，只引用了第一条消息内的内容');
          addQuote(selection.quote);
          setSelection(undefined);
        }}
      >
        引用
      </button>
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent('pi:side', { detail: { quote: selection.quote } }));
          setSelection(undefined);
        }}
      >
        侧边提问
      </button>
      <button
        onClick={() => {
          void window.desktop.invoke('copy', selection.quote.text).then(() => notice('消息已复制'));
          setSelection(undefined);
        }}
      >
        复制
      </button>
    </div>
  );
}
