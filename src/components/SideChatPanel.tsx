import { useEffect, useRef, useState } from 'react';
import { X, Square, ArrowUp, Trash2, LoaderCircle } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { RichText } from './conversation/Markdown';
import { CopyButton } from './CopyButton';
import { ErrorFeedback } from './ErrorFeedback';
import { parseUserMessage, quoteLabel } from '../../shared/message-content';
import { useLayer, topLayer } from '../hooks/useLayer';

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
  // Follow the answer only while the reader is at the bottom; always jump to a newly sent question.
  const pinned = useRef(true),
    count = useRef(0);
  const messages = sideChat.chat?.messages;
  useEffect(() => {
    const node = output.current;
    if (!node) return;
    const length = messages?.length ?? 0;
    if (pinned.current || length > count.current) node.scrollTop = node.scrollHeight;
    count.current = length;
  }, [messages]);
  const running = Boolean(sideChat.chat?.running || sideChat.sending);
  const empty = !sideChat.draft.text.trim() && !sideChat.draft.quotes.length;
  const model =
    runtime.sessionId === selected?.id
      ? runtime.model?.name || runtime.model?.id || '未选择模型'
      : '尚未连接';
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
          <div className="side-chat-title">
            <strong>侧边对话</strong>
            <small title="跟随主会话当前模型">{model}</small>
          </div>
          <button
            aria-label="清空侧边对话"
            title="清空侧边对话"
            disabled={!messages?.length && !running}
            onClick={() => void sideChat.clear()}
          >
            <Trash2 size={14} />
          </button>
          <button aria-label="关闭侧边对话" title="关闭（Esc）" onClick={() => sideChat.setOpen(false)}>
            <X size={15} />
          </button>
        </header>
        <div
          className="side-chat-messages"
          ref={output}
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          }}
        >
          {!messages?.length && (
            <p className="side-chat-empty">
              问一个和当前会话相关的问题。回答单独保存，不会进入主会话，也不会调用工具。
            </p>
          )}
          {messages?.map((message) => {
            const parsed = message.role === 'user' ? parseUserMessage(message.content) : undefined;
            const streaming = sideChat.chat?.running === message.id;
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
                {streaming && !message.content ? (
                  <p className="side-chat-thinking" aria-busy="true">
                    <LoaderCircle size={13} className="spin" />
                    正在思考…
                  </p>
                ) : (
                  <RichText text={parsed?.text ?? message.content} streaming={streaming} />
                )}
                {message.aborted && <small className="muted">已停止</small>}
                {message.role === 'assistant' && message.content.trim() && !streaming && (
                  <footer>
                    <CopyButton title="复制" copy={() => copy(message.content)} />
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
        <ErrorFeedback
          message={
            sideChat.error ||
            (sideChat.chat?.error ? `${sideChat.chat.error.title}。${sideChat.chat.error.detail}` : undefined)
          }
        />
        {sideChat.disabledReason && (
          <div className="side-chat-unavailable">
            <p>{sideChat.disabledReason}</p>
            <button onClick={() => openSettings('models')}>打开模型设置</button>
            {!runtime.connected && <button onClick={() => void connect()}>连接主会话</button>}
          </div>
        )}
        {!!sideChat.omittedTurns && (
          <small className="side-chat-omitted" role="status">
            上下文较长，已省略前 {sideChat.omittedTurns} 轮
          </small>
        )}
        <div className={'side-chat-composer' + (sideChat.disabledReason ? ' disabled' : '')}>
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
            placeholder={running ? '可以先写下一个问题…' : '问一个相关问题…'}
            rows={2}
            disabled={Boolean(sideChat.disabledReason)}
            onChange={(event) => sideChat.updateDraft({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sideChat.send();
              }
            }}
          />
          <div className="side-chat-toolbar">
            <select
              aria-label="侧边上下文范围"
              title="回答时参考的主会话内容"
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
            {running ? (
              <button
                className="side-chat-send stop"
                aria-label="停止侧边回答"
                title="停止回答"
                onClick={() => void sideChat.stop()}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                className="side-chat-send"
                aria-label="发送侧边问题"
                title="发送（Enter）"
                disabled={Boolean(sideChat.disabledReason) || empty}
                onClick={() => void sideChat.send()}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
