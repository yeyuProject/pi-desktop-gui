import { LoaderCircle, ArrowDown, ArrowUp, CircleHelp, Search, X } from 'lucide-react';
import { ThinkingBlock } from './conversation/ThinkingBlock';
import { ToolCard } from './conversation/ToolCard';
import { ApprovalCard } from './Approval';
import { ChatMessage } from './conversation/ChatMessage';
import { ReadinessChecklist } from './ReadinessChecklist';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { AppState, ToolActivity } from '../../shared/types';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { limitForMessage, searchSession } from '../lib/session-search';
import {
  conversationTurns,
  groupConversation,
  placeRuntimeTools,
  turnThinking,
} from '../lib/conversation-layout';
import { ToolGroupCard } from './conversation/ToolGroupCard';
import { RetryErrorGroup } from './conversation/RetryErrorGroup';
import { SearchHighlight } from './conversation/SearchHighlight';
import { sessionModelState } from '../lib/session-model';
import '../styles/conversation-v014.css';
export function Conversation(
  props: Pick<
    Workbench,
    | 'state'
    | 'storage'
    | 'runtime'
    | 'environment'
    | 'pending'
    | 'setFeatureTab'
    | 'compact'
    | 'inspector'
    | 'expanded'
    | 'messageLimit'
    | 'setMessageLimit'
    | 'newContent'
    | 'setNewContent'
    | 'thread'
    | 'input'
    | 'autoScroll'
    | 'selected'
    | 'project'
    | 'sessionEnabled'
    | 'ownRuntime'
    | 'running'
    | 'messages'
    | 'approvals'
    | 'lastAssistant'
    | 'visibleMessages'
    | 'attempt'
    | 'persistDraft'
    | 'focusComposer'
    | 'selectSession'
    | 'openSettings'
    | 'connect'
    | 'inspectFile'
    | 'toggleTool'
    | 'messageContext'
  > & { state: AppState; children: ReactNode; recovery: ReactNode },
) {
  const {
    state,
    storage,
    runtime,
    environment,
    pending,
    setFeatureTab,
    compact,
    inspector,
    expanded,
    messageLimit,
    setMessageLimit,
    newContent,
    setNewContent,
    thread,
    input,
    autoScroll,
    selected,
    project,
    sessionEnabled,
    ownRuntime,
    running,
    messages,
    approvals,
    lastAssistant,
    visibleMessages,
    attempt,
    persistDraft,
    focusComposer,
    selectSession,
    openSettings,
    connect,
    inspectFile,
    toggleTool,
    messageContext,
  } = props;
  const [findOpen, setFindOpen] = useState(false),
    [query, setQuery] = useState(''),
    [matchIndex, setMatchIndex] = useState(0);
  const [activeTurn, setActiveTurn] = useState(1),
    [jumpIndex, setJumpIndex] = useState<number | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const threadViewport = useRef({ width: 0, height: 0 });
  const tools = ownRuntime ? runtime.tools : [];
  const placedTools = useMemo(
    () => placeRuntimeTools(messages, tools),
    [messages, runtime.tools, ownRuntime],
  );
  const modelState = sessionModelState(runtime, selected, state.settings);
  const matches = useMemo(
    () =>
      searchSession(messages, tools, findOpen ? query : '').map((match) =>
        match.messageIndex === undefined && match.toolId
          ? { ...match, messageIndex: placedTools.messageForTool.get(match.toolId) }
          : match,
      ),
    [messages, runtime.tools, ownRuntime, placedTools, findOpen, query],
  );
  const activeMatch = matches.length ? matches[matchIndex % matches.length] : undefined;
  const [collapseThinking, setCollapseThinking] = useState(0);
  const startIndex = messages.length - visibleMessages.length;
  const thinkingGroups = useMemo(() => turnThinking(messages, startIndex), [messages, startIndex]);
  const items = useMemo(
    () => groupConversation(messages, messageContext.toolFor, expanded),
    [messages, messageContext.toolFor, expanded],
  );
  const turns = useMemo(
    () => conversationTurns(messages, messageContext.toolFor),
    [messages, messageContext.toolFor],
  );
  const jump = (index: number) => {
    autoScroll.current = false;
    setMessageLimit((limit) => limitForMessage(messages.length, index, limit));
    setJumpIndex(index);
  };
  const nextMatch = (direction: number) => {
    if (matches.length) setMatchIndex((index) => (index + direction + matches.length) % matches.length);
  };
  useEffect(() => {
    const open = () => {
      setFindOpen(true);
      requestAnimationFrame(() => {
        findInput.current?.focus();
        findInput.current?.select();
      });
    };
    window.addEventListener('pi:find', open);
    return () => window.removeEventListener('pi:find', open);
  }, []);
  useEffect(() => {
    setFindOpen(false);
    setQuery('');
    setMatchIndex(0);
    setJumpIndex(null);
  }, [selected?.id]);
  useEffect(() => {
    const container = thread.current,
      content = threadContent.current;
    if (!container || !content) return;
    const observer = new ResizeObserver(() => {
      if (autoScroll.current) {
        container.scrollTop = container.scrollHeight;
        setNewContent(false);
      }
      threadViewport.current = { width: container.clientWidth, height: container.clientHeight };
    });
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [selected?.id]);
  useEffect(() => {
    if (!activeMatch) return;
    if (activeMatch.messageIndex !== undefined) {
      const group =
        activeMatch.section === 'thinking'
          ? thinkingGroups.find((g) => g.parts.some((p) => p.index === activeMatch.messageIndex))
          : undefined;
      jump(group?.owner ?? activeMatch.messageIndex);
    } else autoScroll.current = false;
    const timer = requestAnimationFrame(() =>
      thread.current?.querySelector('.search-active')?.scrollIntoView({ block: 'center' }),
    );
    return () => cancelAnimationFrame(timer);
  }, [activeMatch]);
  useEffect(() => {
    if (jumpIndex === null) return;
    const timer = requestAnimationFrame(() =>
      thread.current?.querySelector(`[data-message-index="${jumpIndex}"]`)?.scrollIntoView({
        block: activeMatch ? 'center' : 'start',
        behavior: activeMatch ? 'instant' : 'smooth',
      }),
    );
    return () => cancelAnimationFrame(timer);
  }, [jumpIndex, messageLimit, activeMatch]);
  useEffect(() => {
    if (!CSS.highlights) return;
    CSS.highlights.delete('session-find');
    if (!activeMatch) return;
    const timer = requestAnimationFrame(() => {
      const target = thread.current?.querySelector('.search-active');
      if (!target) return;
      const selectedMark = target.querySelector('.search-current');
      if (selectedMark) {
        selectedMark.scrollIntoView({ block: 'center' });
        return;
      }
      const walker = document.createTreeWalker(
        target.querySelector('.message-content') ?? target,
        NodeFilter.SHOW_TEXT,
      );
      const ranges: Range[] = [],
        needle = activeMatch.query.toLocaleLowerCase();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('.search-snippet,button,mark')) continue;
        const text = (node.textContent ?? '').toLocaleLowerCase();
        for (
          let offset = text.indexOf(needle);
          offset >= 0;
          offset = text.indexOf(needle, offset + needle.length)
        ) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + needle.length);
          ranges.push(range);
        }
      }
      const range = ranges[activeMatch.section === 'text' ? activeMatch.occurrence : 0];
      if (range && thread.current) {
        CSS.highlights.set('session-find', new Highlight(range));
        const pre = range.startContainer.parentElement?.closest('pre');
        if (pre)
          pre.scrollTop +=
            range.getBoundingClientRect().top - pre.getBoundingClientRect().top - pre.clientHeight / 2;
        const bounds = range.getBoundingClientRect(),
          container = thread.current;
        container.scrollTop +=
          bounds.top + bounds.height / 2 - container.getBoundingClientRect().top - container.clientHeight / 2;
      }
    });
    return () => {
      cancelAnimationFrame(timer);
      CSS.highlights.delete('session-find');
    };
  }, [activeMatch, messageLimit]);
  const renderThinking = (group: ReturnType<typeof turnThinking>[number]) => {
    const part =
      activeMatch?.section === 'thinking'
        ? group.parts.find((p) => p.index === activeMatch.messageIndex && p.block === activeMatch.blockIndex)
        : undefined;
    return (
      <div
        key={`${selected?.id}:thinking:${group.parts[0].index}`}
        className={part ? 'search-active' : undefined}
      >
        <ThinkingBlock
          text={group.text}
          streaming={running && group.end === messages.length - 1}
          collapseKey={collapseThinking}
          match={part && activeMatch ? { ...activeMatch, start: part.offset + activeMatch.start } : undefined}
        />
      </div>
    );
  };
  const renderTool = (tool: ToolActivity) => (
    <div key={tool.id} className={activeMatch?.toolId === tool.id ? 'search-active' : undefined}>
      <ToolCard
        tool={tool}
        expanded={expanded.includes(tool.id)}
        onToggle={(v) => toggleTool(tool.id, v)}
        openFile={(p) => void inspectFile(p, 'files')}
        match={activeMatch?.toolId === tool.id ? activeMatch : undefined}
        askHunk={messageContext.askHunk}
        rerun={messageContext.rerun}
        canRerun={messageContext.canRerun}
      />
    </div>
  );
  const renderMessage = (index: number) => {
    const match =
      activeMatch?.messageIndex === index &&
      (!activeMatch.toolId || activeMatch.toolId === messages[index].toolCallId)
        ? activeMatch
        : undefined;
    return (
      <div
        key={`${selected?.id}-${index}`}
        data-message-index={index}
        data-turn={
          messages[index].role === 'user' ? turns.find((turn) => turn.index === index)?.turn : undefined
        }
        className={match && match.section !== 'thinking' ? 'search-active' : undefined}
      >
        {match && match.section !== 'thinking' && (
          <div className="search-snippet">
            <SearchHighlight text={match.snippet} query={match.query} />
          </div>
        )}
        {thinkingGroups.filter((group) => group.owner === index).map(renderThinking)}
        <ChatMessage
          hideThinking
          m={messages[index]}
          last={messages[index] === lastAssistant}
          ctx={messageContext}
          match={match}
        />
        {placedTools.afterMessage.get(index)?.map(renderTool)}
      </div>
    );
  };

  return (
    <section className="conversation" inert={inspector && compact}>
      {findOpen && (
        <div className="session-find" role="search" aria-label="会话内查找">
          <Search size={14} />
          <input
            ref={findInput}
            aria-label="查找当前会话"
            value={query}
            placeholder="查找当前会话…"
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setFindOpen(false);
                input.current?.focus();
              } else if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                nextMatch(event.shiftKey || event.key === 'ArrowUp' ? -1 : 1);
              }
            }}
          />
          <span aria-live="polite">
            {matches.length ? (matchIndex % matches.length) + 1 : 0} / {matches.length}
          </span>
          <button title="上一个匹配" disabled={!matches.length} onClick={() => nextMatch(-1)}>
            <ArrowUp size={14} />
          </button>
          <button title="下一个匹配" disabled={!matches.length} onClick={() => nextMatch(1)}>
            <ArrowDown size={14} />
          </button>
          <button title="关闭会话查找" onClick={() => setFindOpen(false)}>
            <X size={14} />
          </button>
        </div>
      )}
      {project && !project.trusted && (
        <div className="trust-banner">
          <CircleHelp size={19} />
          <div>
            <strong>在这个项目中启用 Pi</strong>
            <p>Pi 可以读取、修改项目文件并执行本机命令。</p>
          </div>
          <button onClick={() => void attempt(() => api.invoke('trustProject', project.id))}>启用项目</button>
        </div>
      )}
      <div
        className="thread"
        ref={thread}
        onScroll={() => {
          const el = thread.current;
          if (!el) return;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          // Resizing can emit a scroll event before the ResizeObserver catches up.
          const sameViewport =
            el.clientWidth === threadViewport.current.width &&
            el.clientHeight === threadViewport.current.height;
          if (atBottom || sameViewport) autoScroll.current = atBottom;
          setNewContent(!autoScroll.current);
          const top = el.getBoundingClientRect().top;
          const visible = [...el.querySelectorAll<HTMLElement>('[data-turn]')].findLast(
            (node) => node.getBoundingClientRect().top <= top + 100,
          );
          if (visible) setActiveTurn(Number(visible.dataset.turn));
        }}
        onMouseLeave={() => {
          if (storage.writable && selected && thread.current)
            void attempt(() => api.invoke('saveView', selected.id, thread.current!.scrollTop, expanded));
        }}
      >
        {!messages.length && (
          <div className="welcome">
            <div className="welcome-symbol" aria-hidden="true">
              π
            </div>
            <h2>{project ? '想一起完成什么？' : '有什么想聊的？'}</h2>
            <p>{project ? '描述一个目标，或者从下面开始。' : '直接提问、整理思路，或一起打磨一个想法。'}</p>
            <ReadinessChecklist
              environment={environment}
              runtime={modelState.runtime}
              ownRuntime={ownRuntime}
              modelLabel={modelState.label}
              canConnect={sessionEnabled && !running && !pending}
              checkEnvironment={() => openSettings('environment')}
              connect={() => void connect()}
              providers={() => setFeatureTab('providers')}
            />
            {!project ? (
              <div className="suggestions">
                {[
                  ['解释概念', '帮我解释一个概念：', '从直觉讲到细节，配上例子'],
                  ['整理思路', '帮我梳理一下这个想法：', '把零散的想法理成结构'],
                  ['一起写作', '和我一起打磨这段文字：', '改稿、润色或换个语气'],
                ].map(([label, prompt, hint]) => (
                  <button
                    key={label}
                    aria-label={label}
                    onClick={() => {
                      persistDraft(prompt);
                      focusComposer();
                    }}
                  >
                    <span>{label}</span>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
            ) : (
              <div className="suggestions">
                {[
                  ['理解项目', '梳理这个项目的结构、运行方式和主要模块。', '结构、运行方式和主要模块'],
                  ['修复问题', '帮我定位并修复一个问题：', '描述现象，Pi 定位并修改'],
                  ['补充测试', '检查项目中缺少测试的关键逻辑，先给出建议。', '找出缺少测试的关键逻辑'],
                ].map(([label, prompt, hint]) => (
                  <button
                    key={label}
                    aria-label={label}
                    onClick={() => {
                      persistDraft(prompt);
                      input.current?.focus();
                    }}
                  >
                    <span>{label}</span>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={threadContent}>
          {thinkingGroups.length > 0 && (
            <button
              className="collapse-thinking"
              onClick={() => {
                setFindOpen(false);
                setCollapseThinking((v) => v + 1);
              }}
            >
              收起所有思考过程
            </button>
          )}
          {messages.length > messageLimit && (
            <button className="load-history" onClick={() => setMessageLimit((v) => v + 80)}>
              加载更早的 {Math.min(80, messages.length - messageLimit)} 条消息
            </button>
          )}
          {thinkingGroups.filter((group) => group.owner < startIndex).map(renderThinking)}
          {items.map((item) =>
            item.kind === 'message'
              ? item.index >= startIndex && renderMessage(item.index)
              : item.kind === 'errors'
                ? item.indices.at(-1)! >= startIndex && (
                    <RetryErrorGroup
                      key={`${selected?.id}:${item.id}`}
                      messages={messages}
                      indices={item.indices}
                      activeIndex={activeMatch?.messageIndex}
                      renderMessage={renderMessage}
                    />
                  )
                : item.indices.at(-1)! >= startIndex && (
                    <ToolGroupCard
                      key={item.id}
                      tools={item.indices.map((index) => messageContext.toolFor(messages[index]))}
                      expanded={
                        expanded.includes(item.id) || item.indices.includes(activeMatch?.messageIndex ?? -1)
                      }
                      onToggle={(open) => {
                        if (
                          !item.indices.includes(activeMatch?.messageIndex ?? -1) &&
                          open !== expanded.includes(item.id)
                        )
                          toggleTool(item.id, open);
                      }}
                    >
                      {item.indices.map(renderMessage)}
                    </ToolGroupCard>
                  ),
          )}
          {placedTools.trailing.map(renderTool)}
          {ownRuntime &&
            approvals.map((d, i) => (
              <ApprovalCard
                key={d.id}
                dialog={d}
                first={i === 0}
                respond={(value) =>
                  selected && void attempt(() => api.invoke('respond', selected.id, d.id, { value }))
                }
              />
            ))}
          {props.recovery}
          {ownRuntime && runtime.notices.length > 0 && (
            <details
              className="runtime-notices"
              key={`${runtime.sessionId}:${running ? 'active' : 'settled'}`}
            >
              <summary>
                {running ? '运行记录' : '历史运行记录'} · {runtime.notices.length}
              </summary>
              {runtime.notices.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </details>
          )}
        </div>
      </div>
      {turns.length >= 3 && (
        <nav className="turn-outline" aria-label="对话轮次">
          {turns.map((turn) => (
            <button
              key={turn.turn}
              title={`第 ${turn.turn} 轮：${turn.title}`}
              className={[
                turn.failed ? 'failed' : turn.modified ? 'modified' : '',
                activeTurn === turn.turn ? 'current' : '',
              ].join(' ')}
              aria-current={activeTurn === turn.turn ? 'step' : undefined}
              onClick={() => {
                setActiveTurn(turn.turn);
                jump(turn.index);
              }}
            >
              <i />
              <span>
                #{turn.turn} {turn.title}
                <small>
                  +{turn.added} / −{turn.removed}
                </small>
              </span>
            </button>
          ))}
        </nav>
      )}
      {newContent && (
        <button
          className="new-content"
          title="滚到底部并继续跟随输出"
          onClick={() => {
            autoScroll.current = true;
            thread.current?.scrollTo({ top: thread.current.scrollHeight });
            setNewContent(false);
          }}
        >
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
      {props.children}
    </section>
  );
}
