import { useEffect, useRef, useState } from 'react';
import { X, Square, Send, Trash2 } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { RichText } from './conversation/Markdown';
import { parseUserMessage, quoteLabel } from '../../shared/message-content';
import { useLayer, topLayer } from '../hooks/useLayer';
import '../styles/side-chat.css';

export function SideChatPanel({
  sideChat,
  runtime,
  selected,
  openSettings,
  connect,
  copy,
}: Pick<Workbench, 'sideChat' | 'runtime' | 'selected' | 'openSettings' | 'connect' | 'copy'>) {
  const panel = useRef<HTMLElement>(null),
    output = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(window.innerWidth < 900);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useLayer(panel, sideChat.open && narrow, () => sideChat.setOpen(false), { kind: 'panel', trapFocus: true });
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [sideChat.chat?.messages]);
  const running = Boolean(sideChat.chat?.running || sideChat.sending);
  return (
    <>
      {narrow && <div className="side-chat-backdrop" onClick={() => sideChat.setOpen(false)} />}
      <aside
        ref={panel}
        className={`side-chat${narrow ? ' drawer' : ''}`}
        role={narrow ? 'dialog' : 'complementary'}
        aria-label="侧边对话"
        aria-modal={narrow || undefined}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !event.nativeEvent.isComposing &&
            !event.defaultPrevented &&
            (!topLayer() || topLayer()?.kind === 'panel')
          ) {
            event.preventDefault();
            event.stopPropagation();
            sideChat.setOpen(false);
          }
        }}
      >
        <header>
          <strong>侧边对话</strong>
          <button aria-label="清空侧边对话" onClick={() => void sideChat.clear()}>
            <Trash2 size={14} />
          </button>
          <button aria-label="关闭侧边对话" onClick={() => sideChat.setOpen(false)}>
            <X size={15} />
          </button>
        </header>
        <div className="side-chat-options">
          <select
            aria-label="侧边上下文范围"
            value={sideChat.draft.scope}
            disabled={running}
            onChange={(event) =>
              sideChat.updateDraft({ scope: event.target.value as 'quotes' | 'reply' | 'all' })
            }
          >
            <option value="quotes">仅引用内容</option>
            <option value="reply" disabled={sideChat.draft.replyTimestamp === undefined}>
              到此条回复
            </option>
            <option value="all">整个会话</option>
          </select>
          <span title="跟随主会话当前模型">
            {runtime.sessionId === selected?.id
              ? runtime.model?.name || runtime.model?.id || '未选择模型'
              : '尚未连接'}
          </span>
          {!!sideChat.omittedTurns && <small role="status">已省略前 {sideChat.omittedTurns} 轮</small>}
        </div>
        <div className="side-chat-messages" ref={output}>
          {!sideChat.chat?.messages.length && <p className="muted">在这里问一个相关问题，回答会单独保存。</p>}
          {sideChat.chat?.messages.map((message) => {
            const parsed = message.role === 'user' ? parseUserMessage(message.content) : undefined;
            return (
              <article
                className={'side-message ' + message.role}
                key={message.id}
                data-side-message-id={message.id}
              >
                <strong>{message.role === 'user' ? '你' : 'Pi'}</strong>
                {parsed?.quotes.map((quote) => (
                  <blockquote key={quote.id}>
                    <small>{quoteLabel(quote)}</small>
                    <pre>{quote.text}</pre>
                  </blockquote>
                ))}
                <RichText
                  text={parsed?.text ?? message.content}
                  streaming={sideChat.chat?.running === message.id}
                />
                {message.aborted && <small className="muted">已停止</small>}
                {message.role === 'assistant' &&
                  message.content.trim() &&
                  sideChat.chat?.running !== message.id && (
                    <footer>
                      <button onClick={() => void copy(message.content, '消息已复制')}>复制</button>
                      <button
                        onClick={() => {
                          sideChat.quote(message);
                          if (narrow) sideChat.setOpen(false);
                        }}
                      >
                        引用到主输入框
                      </button>
                      <button onClick={() => void sideChat.continue(message)}>作为新会话继续</button>
                    </footer>
                  )}
              </article>
            );
          })}
        </div>
        {(sideChat.error || sideChat.chat?.error) && (
          <p className="inline-error" role="alert">
            {sideChat.error || `${sideChat.chat?.error?.title}。${sideChat.chat?.error?.detail}`}
          </p>
        )}
        {sideChat.disabledReason && (
          <div className="side-chat-unavailable">
            <p>{sideChat.disabledReason}</p>
            <button onClick={() => openSettings('models')}>打开模型设置</button>
            {!runtime.connected && <button onClick={() => void connect()}>连接主会话</button>}
          </div>
        )}
        <div className="side-chat-composer">
          {!!sideChat.draft.quotes.length && (
            <div className="side-draft-quotes">
              {sideChat.draft.quotes.map((quote) => (
                <span key={quote.id} title={quote.text.slice(0, 2000)}>
                  ❝ {quoteLabel(quote)} · {quote.text.slice(0, 40)}
                  {quote.truncated ? '（已截断）' : ''}
                  <button
                    aria-label="移除侧边引用"
                    onClick={() =>
                      sideChat.updateDraft({ quotes: sideChat.draft.quotes.filter((q) => q.id !== quote.id) })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            aria-label="侧边问题"
            value={sideChat.draft.text}
            placeholder="问一个相关问题…"
            disabled={Boolean(sideChat.disabledReason) || running}
            onChange={(event) => sideChat.updateDraft({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sideChat.send();
              }
            }}
          />
          {running ? (
            <button className="side-chat-send" onClick={() => void sideChat.stop()}>
              <Square size={13} />
              停止侧边回答
            </button>
          ) : (
            <button
              className="side-chat-send"
              disabled={
                Boolean(sideChat.disabledReason) ||
                (!sideChat.draft.text.trim() && !sideChat.draft.quotes.length)
              }
              onClick={() => void sideChat.send()}
            >
              <Send size={13} />
              发送侧边问题
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
