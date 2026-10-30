import { memo, useEffect, useRef, useState } from 'react';
import {
  GitBranch,
  LoaderCircle,
  Copy,
  Terminal,
  RefreshCw,
  Pencil,
  Undo2,
  MoreHorizontal,
  MessagesSquare,
} from 'lucide-react';
import { messageText, type Message, type ToolActivity, type MessageAction } from '../../../shared/types';
import { time } from '../../lib/format';
import { IconButton } from '../IconButton';
import { RichText, MessageImages, UserMessage } from './Markdown';
import { ToolCard } from './ToolCard';
import { AskCard } from './AskCard';
import { DESKTOP_ASK_TOOL, readAskDetails } from '../../../shared/ask';
import { ReplyMeta, ReplySpeed } from './Usage';
import type { SessionMatch } from '../../lib/session-search';
import { ThinkingBlock } from './ThinkingBlock';
import { AnsiOutput } from '../AnsiOutput';
import { userMessageInput } from '../../lib/message-content';
import { useLayer } from '../../hooks/useLayer';

function UserMessageMenu({ text, copy }: { text: string; copy: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useLayer(popup, open, () => setOpen(false), { kind: 'menu', trapFocus: true });
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  return (
    <span className="message-menu" ref={menu}>
      <button
        className="icon-button"
        title="更多消息操作"
        aria-label="更多消息操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div className="message-menu-popover" role="menu" ref={popup}>
          <button
            role="menuitem"
            onClick={() => {
              copy(text);
              setOpen(false);
            }}
          >
            复制完整内容
          </button>
        </div>
      )}
    </span>
  );
}

export interface MessageContext {
  quoteSources?: Set<string>;
  running: boolean;
  locked: boolean;
  expanded: string[];
  liveToolIds: Set<string>;
  toolFor: (m: Message) => ToolActivity;
  toggleTool: (id: string, open: boolean) => void;
  openFile: (path: string) => void;
  copy: (text: string) => void;
  act: (m: Message, kind: MessageAction) => void;
  askHunk?: (attachment: string | undefined, prompt: string) => void;
  rerun?: (command: string, includeContext: boolean) => void;
  canRerun?: boolean;
  checkpointFor?: (m: Message) => { turn: number; disabledReason?: string } | undefined;
  checkpointRevision?: number;
  undo?: (m: Message) => void;
}
export const ChatMessage = memo(
  function ChatMessage({
    m,
    last,
    ctx,
    match,
    hideThinking = false,
    copyReply = false,
    index = 0,
    goalStart = false,
  }: {
    m: Message;
    last: boolean;
    ctx: MessageContext;
    match?: SessionMatch;
    hideThinking?: boolean;
    copyReply?: boolean;
    index?: number;
    goalStart?: boolean;
  }) {
    if (m.role === 'toolResult') {
      const observed = ctx.toolFor(m);
      const tool = match ? { ...observed, output: messageText(m) } : observed;
      const ask = tool.name === DESKTOP_ASK_TOOL ? readAskDetails(m.details) : undefined;
      if (ask)
        return (
          <AskCard
            details={ask}
            expanded={ctx.expanded.includes(tool.id)}
            toggle={(open) => ctx.toggleTool(tool.id, open)}
            copy={ctx.copy}
            match={match}
          />
        );
      return (
        <div>
          <ToolCard
            tool={tool}
            expanded={ctx.expanded.includes(tool.id)}
            onToggle={(v) => ctx.toggleTool(tool.id, v)}
            openFile={(p) => ctx.openFile(p)}
            match={match}
            askHunk={ctx.askHunk}
            rerun={ctx.rerun}
            canRerun={ctx.canRerun}
          />
          <MessageImages message={m} />
        </div>
      );
    }
    if (m.role === 'bashExecution')
      return (
        <article className="message bash-message">
          <strong>
            <Terminal size={14} /> {String(m.command ?? '')}
          </strong>
          <AnsiOutput text={String(m.output ?? '')} />
          <small>
            {m.excludeFromContext ? '输出不进入模型上下文' : '输出已加入模型上下文'} · 退出码{' '}
            {String(m.exitCode ?? '')}
          </small>
        </article>
      );
    if (m.role === 'custom' && m.customType === 'desktop-goal-updated')
      return (
        <div className="goal-updated-divider" role="separator">
          目标已修改
        </div>
      );
    if (m.role === 'custom' || m.role === 'branchSummary' || m.role === 'compactionSummary')
      return (
        <article className="message">
          <RichText text={messageText(m) || String(m.summary ?? '')} />
        </article>
      );
    if (m.role !== 'user' && m.role !== 'assistant') return null;
    const content = messageText(m);
    const checkpoint = m.role === 'user' ? ctx.checkpointFor?.(m) : undefined;
    if (
      m.role === 'assistant' &&
      !content &&
      !m.errorMessage &&
      typeof m.content !== 'string' &&
      !m.content.some(
        (b) =>
          ((!hideThinking || (m.stopReason && m.stopReason !== 'toolUse')) &&
            b.type === 'thinking' &&
            b.thinking) ||
          (ctx.running && typeof b.partialJson === 'string'),
      )
    )
      return null;
    return (
      <article className={'message ' + m.role}>
        <div className="message-heading">
          {m.role === 'assistant' && (
            <span className="avatar assistant" aria-hidden="true">
              π
            </span>
          )}
          <strong>{m.role === 'user' ? '你' : 'Pi'}</strong>
          {goalStart && <span className="goal-message-badge">◎ Goal</span>}
          {m.timestamp && <time>{time(m.timestamp)}</time>}
          {m.role === 'assistant' && <ReplyMeta message={m} />}
          <span className="message-actions">
            <IconButton
              title="复制消息"
              onClick={() => ctx.copy(m.role === 'user' ? userMessageInput(content) : content)}
            >
              <Copy size={13} />
            </IconButton>
            {m.role === 'user' && <UserMessageMenu text={content} copy={ctx.copy} />}
            {m.role === 'assistant' && content.trim() && (
              <IconButton
                title="侧边提问"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('pi:side', { detail: { replyTimestamp: m.timestamp } }),
                  )
                }
              >
                <MessagesSquare size={13} />
              </IconButton>
            )}
            {m.role === 'user' && m.timestamp && (
              <>
                {checkpoint && ctx.undo && (
                  <IconButton
                    title={checkpoint.disabledReason || '撤销此轮起的文件修改'}
                    disabled={ctx.locked || Boolean(checkpoint.disabledReason)}
                    onClick={() => ctx.undo?.(m)}
                  >
                    <Undo2 size={13} />
                  </IconButton>
                )}
                <IconButton
                  title={ctx.running ? '本会话正在使用这段历史，请停止任务后编辑' : '编辑后重新发送'}
                  disabled={ctx.locked}
                  onClick={() => ctx.act(m, 'edit')}
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton title="从这里分支到新会话" onClick={() => ctx.act(m, 'fork')}>
                  <GitBranch size={13} />
                </IconButton>
              </>
            )}
            {m.role === 'assistant' && m.timestamp && last && (
              <IconButton
                title={ctx.running ? '本会话正在执行，请停止任务后重新生成' : '重新生成这条回复'}
                disabled={ctx.locked}
                onClick={() => ctx.act(m, 'regenerate')}
              >
                <RefreshCw size={13} />
              </IconButton>
            )}
          </span>
        </div>
        <div className="message-content">
          {!hideThinking &&
            typeof m.content !== 'string' &&
            m.content
              .filter((b) => b.type === 'thinking' && b.thinking)
              .map((b, index) => (
                <ThinkingBlock
                  key={index}
                  text={b.thinking!}
                  streaming={ctx.running && last}
                  match={match?.section === 'thinking' && match.blockIndex === index ? match : undefined}
                />
              ))}
          {content ? (
            m.role === 'user' ? (
              <UserMessage
                text={content}
                match={match}
                viewId={m.timestamp ?? index}
                expanded={ctx.expanded}
                toggle={ctx.toggleTool}
                copy={ctx.copy}
                quoteSources={ctx.quoteSources}
              />
            ) : (
              <RichText text={content} streaming={ctx.running && last} />
            )
          ) : m.role === 'assistant' && ctx.running ? (
            <span className="stream-cursor" />
          ) : null}
          {m.errorMessage && <p className="inline-error">{m.errorMessage}</p>}
          <MessageImages message={m} />
          {ctx.running &&
            typeof m.content !== 'string' &&
            m.content
              .filter(
                (b) =>
                  b.type === 'toolCall' &&
                  b.name !== DESKTOP_ASK_TOOL &&
                  typeof b.partialJson === 'string' &&
                  !ctx.liveToolIds.has(String(b.id)),
              )
              .map((b) => (
                <div className="tool-drafting" key={String(b.id)}>
                  <LoaderCircle size={13} className="spin" />
                  <strong>正在准备 {String(b.name ?? '工具')}</strong>
                  <code>{String(b.partialJson).slice(-160) || '…'}</code>
                </div>
              ))}
        </div>
        {m.role === 'assistant' && (
          <div className="reply-footer">
            <ReplySpeed message={m} />
            {copyReply && (
              <button className="reply-copy" onClick={() => ctx.copy(content)}>
                <Copy size={13} />
                复制回复
              </button>
            )}
          </div>
        )}
      </article>
    );
  },
  (a, b) =>
    a.m === b.m &&
    a.hideThinking === b.hideThinking &&
    a.copyReply === b.copyReply &&
    a.index === b.index &&
    a.goalStart === b.goalStart &&
    a.last === b.last &&
    a.match === b.match &&
    a.ctx.running === b.ctx.running &&
    a.ctx.locked === b.ctx.locked &&
    a.ctx.canRerun === b.ctx.canRerun &&
    a.ctx.checkpointFor === b.ctx.checkpointFor &&
    (a.m.role !== 'user' || a.ctx.checkpointRevision === b.ctx.checkpointRevision) &&
    (a.m.role !== 'user' || a.ctx.expanded === b.ctx.expanded) &&
    (a.m.role !== 'user' || a.ctx.quoteSources === b.ctx.quoteSources) &&
    (a.m.role !== 'toolResult' ||
      (a.ctx.expanded === b.ctx.expanded && a.ctx.toolFor(a.m) === b.ctx.toolFor(b.m))) &&
    (!b.ctx.running || a.ctx.liveToolIds === b.ctx.liveToolIds),
);
