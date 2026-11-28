import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Message } from '../../../shared/types';
import type { DraftQuote } from '../../../shared/message-content';
import { turnThinking, type TurnItem } from '../../lib/conversation-layout';
import { CopyButton } from '../CopyButton';
import { lacunaQuestion } from '../../../shared/lacuna';
import { useLacunaEnabled } from '../../lib/lacuna-store';
import { askLacuna } from './LacunaTerms';

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
  const lacuna = useLacunaEnabled();
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
  const dismissed = useRef(false);
  const dismiss = useCallback(() => {
    dismissed.current = true;
    setSelection(undefined);
  }, []);
  /**
   * 1. 从可见的原文提取引用内容和菜单位置。
   * 2. 鼠标或键盘重新选取文字时允许打开菜单，滚动时尊重用户的关闭操作。
   * 3. 引用、侧边提问、点击别处或按 Esc 都会关闭菜单，保留原文选区。
   */
  useEffect(() => {
    // 1. 只有能定位到消息原文的选区才提供引用操作。
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
    // 2. Esc 后文字仍可复制。迟到的滚动事件只能更新尚未关闭的菜单。
    const update = () => {
      if (!dismissed.current) setSelection(read());
    };
    const pointerUp = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return;
      if (!thread.current?.contains(event.target as Node)) return dismiss();
      dismissed.current = false;
      update();
    };
    const keyboardSelection = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      if (event.shiftKey) dismissed.current = false;
      update();
    };
    // 3. 关闭工具栏后，快捷键仍然可以直接读取浏览器中选中的文字。
    const quote = () => {
      const current = read() ?? latest.current.selection;
      if (!current) return;
      if (current.cross) latest.current.notice('选区跨过多条消息，只引用了第一条消息内的内容');
      latest.current.addQuote(current.quote);
      dismiss();
    };
    const side = () => {
      const current = read();
      window.dispatchEvent(
        new CustomEvent('pi:side', { detail: current ? { quote: current.quote } : undefined }),
      );
      dismiss();
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && latest.current.selection && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
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
  }, [thread, dismiss]);
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
          dismiss();
        }}
      >
        引用
      </button>
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent('pi:side', { detail: { quote: selection.quote } }));
          dismiss();
        }}
      >
        侧边提问
      </button>
      {lacuna && (
        <button
          onClick={() => {
            askLacuna(lacunaQuestion(selection.quote.text));
            setSelection(undefined);
          }}
        >
          这是什么意思
        </button>
      )}
      <CopyButton title="复制" copy={() => window.desktop.invoke('copy', selection.quote.text)} />
    </div>
  );
}
