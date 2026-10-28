import { useEffect, useMemo, useState } from 'react';
import { busy, type Runtime, type Session, type StorageStatus } from '../../shared/types';
import { mergeDraftQuotes, truncateQuote, type DraftQuote } from '../../shared/message-content';
import {
  sideChatContext,
  sideChatPrompt,
  type SideChat,
  type SideChatMessage,
  type SideChatRequest,
} from '../../shared/side-chat';
import { readableError } from '../lib/format';
const api = window.desktop;

type Draft = { text: string; quotes: DraftQuote[]; scope: SideChatRequest['scope']; replyTimestamp?: number };
const blank = (): Draft => ({ text: '', quotes: [], scope: 'quotes' });
export function useSideChat(
  selected: Session | undefined,
  runtime: Runtime,
  storage: StorageStatus,
  addQuote: (quote: DraftQuote) => void,
) {
  const [open, setOpen] = useState(false),
    [chat, setChat] = useState<SideChat>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState(''),
    [sending, setSending] = useState<string>();
  const id = selected?.id;
  const draft = id ? (drafts[id] ?? blank()) : blank();
  const preview = useMemo(() => {
    if (!id || !drafts[id] || chat?.running) return { omittedTurns: chat?.omittedTurns ?? 0 };
    try {
      return sideChatContext(runtime.messages, draft, runtime.model?.contextWindow, busy(runtime.status), [
        ...(chat?.messages ?? []).map(({ role, content }) => ({ role, content })),
        { role: 'user', content: sideChatPrompt({ prompt: draft.text, quotes: draft.quotes }) },
      ]);
    } catch (error) {
      return { omittedTurns: 0, error: readableError(error) };
    }
  }, [id, drafts, draft, chat, runtime.messages, runtime.model, runtime.status]);
  const updateDraft = (update: Partial<Draft>) => {
    if (id) setDrafts((before) => ({ ...before, [id]: { ...(before[id] ?? blank()), ...update } }));
  };
  useEffect(() => {
    const show = (event: Event) => {
      const options = (event as CustomEvent<{ quote?: DraftQuote; replyTimestamp?: number; show?: boolean }>)
        .detail;
      if (!id) return;
      setOpen((value) => (options ? true : !value));
      if (options?.quote || options?.replyTimestamp !== undefined)
        setDrafts((before) => {
          const current = before[id] ?? blank();
          const quote = options.quote;
          const added = quote ? truncateQuote(quote) : undefined;
          return {
            ...before,
            [id]: {
              ...current,
              ...(added
                ? { quotes: mergeDraftQuotes(current.quotes, [added]), scope: 'quotes' as const }
                : {}),
              ...(options.replyTimestamp !== undefined
                ? { replyTimestamp: options.replyTimestamp, scope: 'reply' as const }
                : {}),
            },
          };
        });
      window.getSelection()?.removeAllRanges();
      requestAnimationFrame(() =>
        document.querySelector<HTMLTextAreaElement>('[aria-label="侧边问题"]')?.focus(),
      );
    };
    window.addEventListener('pi:side', show);
    return () => window.removeEventListener('pi:side', show);
  }, [id]);
  useEffect(() => {
    if (!id || !open) return;
    let alive = true,
      received = false;
    setChat(undefined);
    setError('');
    const off = api.onEvent((event) => {
      if (!alive) return;
      if (event.type === 'sideChat' && event.chat.sessionId === id) {
        received = true;
        setChat(event.chat);
      } else if (event.type === 'sideChatDelta' && event.sessionId === id) {
        setChat(
          (current) =>
            current && {
              ...current,
              messages: current.messages.map((m) =>
                m.id === event.id ? { ...m, content: m.content + event.text } : m,
              ),
            },
        );
      }
    });
    void api
      .invoke('sideChatRead', id)
      .then((value) => {
        if (alive && !received) setChat(value);
      })
      .catch((e) => {
        if (alive) setError(readableError(e));
      });
    return () => {
      alive = false;
      off();
    };
  }, [id, open]);
  const run = async (operation: () => Promise<unknown>) => {
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(readableError(e));
    }
  };
  const send = async () => {
    if (!id || chat?.running || sending === id || (!draft.text.trim() && !draft.quotes.length)) return;
    setSending(id);
    setError('');
    try {
      await api.invoke('sideChatSend', id, {
        id: crypto.randomUUID(),
        prompt: draft.text,
        quotes: draft.quotes,
        scope: draft.scope,
        replyTimestamp: draft.replyTimestamp,
      });
      setDrafts((before) =>
        before[id]?.text === draft.text && before[id]?.quotes === draft.quotes
          ? { ...before, [id]: { ...before[id], text: '', quotes: [] } }
          : before,
      );
    } catch (e) {
      setError(readableError(e));
    } finally {
      setSending((current) => (current === id ? undefined : current));
    }
  };
  const disabledReason = !storage.writable
    ? '本地数据暂时无法保存，请先修复保存问题。'
    : !runtime.connected || runtime.sessionId !== id
      ? '请先连接主会话，再发送侧边问题。'
      : !runtime.model
        ? '请先在主会话中选择一个可用模型。'
        : '';
  return {
    open,
    setOpen,
    chat,
    draft,
    updateDraft,
    error: error || ('error' in preview ? preview.error : ''),
    omittedTurns: preview.omittedTurns,
    sending: sending === id,
    disabledReason,
    send,
    stop: () => id && run(() => api.invoke('sideChatStop', id)),
    clear: () => id && run(() => api.invoke('sideChatClear', id)),
    quote: (message: SideChatMessage) =>
      addQuote({
        id: crypto.randomUUID(),
        role: 'side',
        turn: 0,
        messageTimestamp: message.timestamp,
        section: 'text',
        text: message.content,
      }),
    continue: (message: SideChatMessage) =>
      id &&
      run(async () => {
        await api.invoke('sideChatContinue', id, message.id);
        setOpen(false);
      }),
  };
}
