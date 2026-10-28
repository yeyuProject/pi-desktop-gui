import { ArrowDown, ArrowUp, CircleHelp, Search, X } from 'lucide-react';
import { ThinkingBlock } from './conversation/ThinkingBlock';
import { ToolCard } from './conversation/ToolCard';
import { ApprovalCard } from './Approval';
import { ChatMessage } from './conversation/ChatMessage';
import { ReadinessChecklist } from './ReadinessChecklist';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import { messageText, type AppState, type ToolActivity } from '../../shared/types';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SessionSearch } from '../lib/session-search';
import { messagePageSize, messageWindow, windowConversation } from '../lib/message-window';
import {
  conversationTurns,
  groupConversation,
  placeRuntimeTools,
  turnThinking,
} from '../lib/conversation-layout';
import { ToolGroupCard } from './conversation/ToolGroupCard';
import { TurnOutline } from './conversation/TurnOutline';
import { RetryErrorGroup } from './conversation/RetryErrorGroup';
import { SearchHighlight } from './conversation/SearchHighlight';
import { sessionModelState } from '../lib/session-model';
import '../styles/conversation-v014.css';
import { SelectionMenu } from './conversation/SelectionMenu';
import { quoteMessageIndex, type DraftQuote } from '../../shared/message-content';

function turnScrollTop(container: HTMLElement, target: HTMLElement) {
  const bounds = (target.querySelector('.message.user') ?? target).getBoundingClientRect();
  const top = container.scrollTop + bounds.top - container.getBoundingClientRect().top;
  const offset =
    bounds.height > container.clientHeight * 0.4 ? bounds.height - container.clientHeight * 0.4 : 0;
  return Math.max(0, Math.min(container.scrollHeight - container.clientHeight, top + offset));
}

export function Conversation(
  props: Pick<
    Workbench,
    | 'state'
    | 'storage'
    | 'runtime'
    | 'environment'
    | 'pending'
    | 'setFeatureTab'
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
    | 'addQuote'
    | 'setNotice'
  > & { state: AppState; recovery: ReactNode },
) {
  const {
    state,
    storage,
    runtime,
    environment,
    pending,
    setFeatureTab,
    expanded,
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
    [jumpIndex, setJumpIndex] = useState<{ index: number; turn: boolean } | null>(null);
  const [turnJump, setTurnJump] = useState<{ index: number } | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<DraftQuote>();
  const requestedTurn = useRef<number | undefined>(undefined);
  const [historyWindow, setHistoryWindow] = useState<{ sessionId?: string; start: number }>();
  const findInput = useRef<HTMLInputElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const threadViewport = useRef({ width: 0, height: 0 });
  const tools = ownRuntime ? runtime.tools : [];
  const placedTools = useMemo(
    () => placeRuntimeTools(messages, tools),
    [messages, runtime.tools, ownRuntime],
  );
  const modelState = sessionModelState(runtime, selected, state.settings);
  const search = useMemo(() => new SessionSearch(), [selected?.id, findOpen]);
  const matches = useMemo(
    () => search.search(messages, tools, findOpen ? query : ''),
    [search, messages, runtime.tools, ownRuntime, findOpen, query],
  );
  const match = matches.at(matchIndex % matches.length);
  const matchedMessage =
    match?.messageIndex ?? (match?.toolId ? placedTools.messageForTool.get(match.toolId) : undefined);
  const activeMatch = useMemo(
    () =>
      match && matchedMessage !== match.messageIndex ? { ...match, messageIndex: matchedMessage } : match,
    [match, matchedMessage],
  );
  const [collapseThinking, setCollapseThinking] = useState(0);
  const range =
    historyWindow && historyWindow.sessionId === selected?.id
      ? messageWindow(messages.length, historyWindow.start)
      : { start: messages.length - visibleMessages.length, end: messages.length };
  const startIndex = range.start,
    endIndex = range.end;
  const thinkingGroups = useMemo(
    () => turnThinking(messages, startIndex, endIndex),
    [messages, startIndex, endIndex],
  );
  const items = useMemo(
    () => groupConversation(messages, messageContext.toolFor, expanded),
    [messages, messageContext.toolFor, expanded],
  );
  const turns = useMemo(
    () => conversationTurns(messages, messageContext.toolFor, ownRuntime && running),
    [messages, messageContext.toolFor, ownRuntime, running],
  );
  const replyIndices = useMemo(
    () => new Set(turns.flatMap((turn) => (turn.replyIndex === undefined ? [] : [turn.replyIndex]))),
    [turns],
  );
  const visibleItems = useMemo(
    () => windowConversation(items, startIndex, endIndex),
    [items, startIndex, endIndex],
  );
  const jump = (index: number, turn = false) => {
    requestedTurn.current = undefined;
    autoScroll.current = false;
    const target = messageWindow(messages.length, index);
    setHistoryWindow(
      target.end < messages.length ? { sessionId: selected?.id, start: target.start } : undefined,
    );
    setMessageLimit(messagePageSize);
    setJumpIndex({ index, turn });
  };
  const jumpToTurn = (index: number) => {
    jump(index, true);
    setTurnJump({ index });
    const turn = turns.find((item) => item.index === index);
    if (turn) {
      requestedTurn.current = turn.turn;
      setActiveTurn(turn.turn);
    }
  };
  useEffect(() => {
    const locate = (event: Event) => {
      const quote = (event as CustomEvent<DraftQuote>).detail;
      if (quote.role === 'side') {
        window.dispatchEvent(new CustomEvent('pi:side', { detail: { show: true } }));
        return;
      }
      const liveTool = quote.toolCallId
        ? runtime.tools.find((tool) => tool.id === quote.toolCallId)
        : undefined;
      const index = quoteMessageIndex(messages, quote);
      if (index < 0 && !liveTool) {
        props.setNotice('引用的原文已不在当前会话分支');
        return;
      }
      setFindOpen(false);
      setQuoteTarget(quote);
      if (liveTool) {
        toggleTool(liveTool.id, true);
        if (index < 0) {
          setMessageLimit((limit) => Math.max(limit, messages.length));
          requestAnimationFrame(() =>
            thread.current
              ?.querySelector(`[data-quote-tool-id="${CSS.escape(liveTool.id)}"]`)
              ?.scrollIntoView({ block: 'center' }),
          );
          return;
        }
      }
      if (quote.section === 'skill') toggleTool(`skill:${quote.messageTimestamp}`, true);
      if (quote.role === 'user') toggleTool(`prompt:${quote.messageTimestamp}`, true);
      if (quote.role === 'toolResult' && messages[index].toolCallId)
        toggleTool(messages[index].toolCallId!, true);
      jump(index);
      setTurnJump({ index });
    };
    window.addEventListener('pi:quote', locate);
    return () => window.removeEventListener('pi:quote', locate);
  }, [messages, selected?.id, runtime.tools]);
  useEffect(() => {
    const locateResult = (event: Event) => {
      const goalId = (event as CustomEvent<string>).detail;
      const index = messages.findLastIndex(
        (message) =>
          message.role === 'toolResult' &&
          ['desktop_goal_complete', 'desktop_goal_blocked', 'desktop_goal_update'].includes(
            message.toolName ?? '',
          ) &&
          (message.details as { id?: string } | undefined)?.id === goalId,
      );
      if (index < 0) {
        props.setNotice('当前分支中找不到这条 Goal 结果');
        return;
      }
      setFindOpen(false);
      if (messages[index].toolCallId) toggleTool(messages[index].toolCallId!, true);
      jump(index);
      setTurnJump({ index });
    };
    window.addEventListener('pi:goal-result', locateResult);
    return () => window.removeEventListener('pi:goal-result', locateResult);
  }, [messages, selected?.id]);
  useEffect(() => {
    if (!quoteTarget) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      const index = quoteMessageIndex(messages, quoteTarget);
      const thinking =
        quoteTarget.section === 'thinking'
          ? thinkingGroups.find((group) => group.parts.some((part) => part.index === index))
          : undefined;
      const liveTool = quoteTarget.toolCallId
        ? runtime.tools.find((tool) => tool.id === quoteTarget.toolCallId)
        : undefined;
      const wrapper = thread.current?.querySelector(
        liveTool && index < 0
          ? `[data-quote-tool-id="${CSS.escape(liveTool.id)}"]`
          : thinking
            ? `[data-quote-thinking-owner="${thinking.owner}"]`
            : `[data-message-index="${index}"]`,
      );
      const selector = {
        text: '.message-content',
        code: '.code-block pre',
        thinking: '.thinking pre',
        tool: '.ansi-output,.tool-body .diff-view',
        skill: '.skill-content',
      }[quoteTarget.section];
      const root = [...(wrapper?.querySelectorAll(selector) ?? [])].find((node) =>
        node.textContent?.includes(quoteTarget.text),
      );
      if (!root || !CSS.highlights) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode())
        if (!walker.currentNode.parentElement?.closest('button:not(.inline-link),summary'))
          nodes.push(walker.currentNode as Text);
      const text = nodes.map((node) => node.data).join('');
      const sourceStart = thinking?.parts.find((part) => part.index === index)?.offset ?? 0;
      const sourceEnd = thinking?.parts.find((part) => part.index > index)?.offset;
      const start = text.indexOf(quoteTarget.text, sourceStart);
      if (start < 0 || (sourceEnd !== undefined && start + quoteTarget.text.length > sourceEnd - 2)) return;
      const range = document.createRange();
      let offset = 0,
        found = false;
      for (const node of nodes) {
        if (!found && offset + node.length > start) {
          range.setStart(node, start - offset);
          found = true;
        }
        if (found && offset + node.length >= start + quoteTarget.text.length) {
          range.setEnd(node, start + quoteTarget.text.length - offset);
          break;
        }
        offset += node.length;
      }
      CSS.highlights.set('conversation-quote', new Highlight(range));
      for (let node = range.startContainer.parentElement; node; node = node.parentElement) {
        if (node === thread.current || node.matches('pre,.skill-content'))
          node.scrollTop +=
            range.getBoundingClientRect().top +
            range.getBoundingClientRect().height / 2 -
            node.getBoundingClientRect().top -
            node.clientHeight / 2;
        if (node === thread.current) break;
      }
      timer = setTimeout(() => CSS.highlights.delete('conversation-quote'), 1800);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      CSS.highlights?.delete('conversation-quote');
    };
  }, [quoteTarget, startIndex, endIndex, expanded]);
  useEffect(() => {
    requestedTurn.current = undefined;
  }, [turns.length]);
  useEffect(() => {
    const navigate = (event: Event) => {
      const direction = (event as CustomEvent).detail;
      if ((direction !== -1 && direction !== 1) || !turns.length) return;
      const current = Math.max(
        0,
        turns.findIndex((turn) => turn.turn === (requestedTurn.current ?? activeTurn)),
      );
      const next = Math.max(0, Math.min(turns.length - 1, current + direction));
      jumpToTurn(turns[next].index);
    };
    window.addEventListener('pi:turn', navigate);
    return () => window.removeEventListener('pi:turn', navigate);
  }, [turns, activeTurn, selected?.id]);
  useEffect(() => {
    if (!turnJump) return;
    let element: HTMLElement | null | undefined;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      element = thread.current?.querySelector<HTMLElement>(`[data-message-index="${turnJump.index}"]`);
      if (!element) return;
      element.classList.remove('turn-jump-highlight');
      // A repeated click on the same turn should restart the one-second feedback.
      void element.offsetWidth;
      element.classList.add('turn-jump-highlight');
      clear = setTimeout(() => {
        element?.classList.remove('turn-jump-highlight');
        setTurnJump(null);
      }, 1000);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(clear);
      element?.classList.remove('turn-jump-highlight');
    };
  }, [turnJump, selected?.id]);
  const showLatest = () => {
    requestedTurn.current = undefined;
    setHistoryWindow(undefined);
    setQuoteTarget(undefined);
    setJumpIndex(null);
    autoScroll.current = true;
    requestAnimationFrame(() => thread.current?.scrollTo({ top: thread.current.scrollHeight }));
    setNewContent(false);
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
    setTurnJump(null);
    setActiveTurn(1);
    setQuoteTarget(undefined);
    requestedTurn.current = undefined;
    setHistoryWindow(undefined);
  }, [selected?.id]);
  useEffect(() => {
    // A branch change or history rewrite can remove the page being inspected.
    if (historyWindow && historyWindow.start >= messages.length - messagePageSize)
      setHistoryWindow(undefined);
  }, [historyWindow, messages.length]);
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
    jump(activeMatch.messageIndex ?? Math.max(0, messages.length - 1));
    const timer = requestAnimationFrame(() =>
      thread.current?.querySelector('.search-active')?.scrollIntoView({ block: 'center' }),
    );
    return () => cancelAnimationFrame(timer);
  }, [activeMatch]);
  useEffect(() => {
    if (jumpIndex === null) return;
    const timer = requestAnimationFrame(() => {
      const container = thread.current;
      const target = container?.querySelector<HTMLElement>(`[data-message-index="${jumpIndex.index}"]`);
      if (!container || !target) return;
      if (jumpIndex.turn) {
        const top = turnScrollTop(container, target);
        if (Math.abs(container.scrollTop - top) <= 2) requestedTurn.current = undefined;
        container.scrollTo({ top, behavior: 'smooth' });
      } else
        target.scrollIntoView({
          block: activeMatch ? 'center' : 'start',
          behavior: activeMatch ? 'instant' : 'smooth',
        });
    });
    return () => cancelAnimationFrame(timer);
  }, [jumpIndex, startIndex, endIndex, activeMatch]);
  useEffect(() => {
    if (!CSS.highlights) return;
    CSS.highlights.delete('session-find');
    if (!activeMatch) return;
    const timer = requestAnimationFrame(() => {
      const target = thread.current?.querySelector('.search-active');
      if (!target) return;
      const content =
        (activeMatch.section === 'quote'
          ? target.querySelectorAll('[data-search-section="quote"]')[activeMatch.blockIndex ?? 0]
          : target.querySelector(`[data-search-section="${activeMatch.section}"]`)) ??
        target.querySelector('.message-content') ??
        target;
      const selectedMark = content.querySelector('.search-current');
      if (selectedMark) {
        selectedMark.scrollIntoView({ block: 'center' });
        return;
      }
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const needle = activeMatch.query.toLocaleLowerCase();
      const wanted =
        activeMatch.section === 'text' || activeMatch.section === 'skill' ? activeMatch.occurrence : 0;
      let occurrence = 0,
        range: Range | undefined;
      while (!range && walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('.search-snippet,button,mark')) continue;
        const text = (node.textContent ?? '').toLocaleLowerCase();
        for (
          let offset = text.indexOf(needle);
          offset >= 0;
          offset = text.indexOf(needle, offset + needle.length)
        ) {
          if (occurrence++ !== wanted) continue;
          range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + needle.length);
          break;
        }
      }
      if (range && thread.current) {
        CSS.highlights.set('session-find', new Highlight(range));
        for (
          let node = range.startContainer.parentElement;
          node && node !== thread.current;
          node = node.parentElement
        ) {
          if (node.matches('pre,.skill-content'))
            node.scrollTop +=
              range.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight / 2;
        }
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
  }, [activeMatch, startIndex, endIndex, expanded]);
  const renderThinking = (group: ReturnType<typeof turnThinking>[number]) => {
    const part =
      activeMatch?.section === 'thinking'
        ? group.parts.find((p) => p.index === activeMatch.messageIndex && p.block === activeMatch.blockIndex)
        : undefined;
    return (
      <div
        key={`${selected?.id}:thinking:${group.parts[0].index}`}
        className={part ? 'search-active' : undefined}
        data-quote-thinking-owner={group.owner}
      >
        <ThinkingBlock
          text={group.text}
          streaming={running && group.end === messages.length - 1}
          defaultExpanded={
            state.settings.expandThinking ||
            (quoteTarget?.section === 'thinking' &&
              group.parts.some((part) => messages[part.index].timestamp === quoteTarget.messageTimestamp))
          }
          collapseKey={collapseThinking}
          match={part && activeMatch ? { ...activeMatch, start: part.offset + activeMatch.start } : undefined}
        />
      </div>
    );
  };
  const renderTool = (tool: ToolActivity) => (
    <div
      key={tool.id}
      data-quote-tool-id={tool.id}
      data-quote-timestamp={tool.startedAt}
      data-quote-turn={
        turns.findLast((turn) => (messages[turn.index].timestamp ?? 0) <= tool.startedAt)?.turn ??
        turns.at(-1)?.turn ??
        0
      }
      className={activeMatch?.toolId === tool.id ? 'search-active' : undefined}
    >
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
          index={index}
          copyReply={replyIndices.has(index)}
        />
        {placedTools.afterMessage.get(index)?.map(renderTool)}
      </div>
    );
  };

  return (
    <>
      <SelectionMenu
        key={selected?.id}
        thread={thread}
        messages={messages}
        turns={turns}
        addQuote={props.addQuote}
        notice={props.setNotice}
      />
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
        role="region"
        aria-label="对话内容"
        tabIndex={-1}
        ref={thread}
        onScrollEnd={() => {
          requestedTurn.current = undefined;
        }}
        onWheel={() => {
          requestedTurn.current = undefined;
        }}
        onTouchStart={() => {
          requestedTurn.current = undefined;
        }}
        onPointerDown={() => {
          requestedTurn.current = undefined;
        }}
        onKeyDown={(event) => {
          if (
            !event.altKey &&
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          )
            requestedTurn.current = undefined;
        }}
        onScroll={() => {
          const el = thread.current;
          if (!el) return;
          const atBottom =
            endIndex === messages.length && el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          // Resizing can emit a scroll event before the ResizeObserver catches up.
          const sameViewport =
            el.clientWidth === threadViewport.current.width &&
            el.clientHeight === threadViewport.current.height;
          if (atBottom || sameViewport) autoScroll.current = atBottom;
          setNewContent(!autoScroll.current);
          const top = el.getBoundingClientRect().top;
          if (requestedTurn.current !== undefined) {
            const target = el.querySelector<HTMLElement>(`[data-turn="${requestedTurn.current}"]`);
            if (target && Math.abs(el.scrollTop - turnScrollTop(el, target)) <= 2)
              requestedTurn.current = undefined;
            // Intermediate smooth-scroll positions must not replace the requested navigation target.
            return;
          }
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
          {(selected?.historyNotice || runtime.historyNotice) && (
            <p className="environment-note" role="status">
              {selected?.historyNotice || runtime.historyNotice}
            </p>
          )}
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
          {startIndex > 0 && (
            <button
              className="load-history"
              onClick={() =>
                endIndex < messages.length
                  ? jump(Math.max(0, startIndex - messagePageSize))
                  : setMessageLimit((v) => v + messagePageSize)
              }
            >
              加载更早的 {Math.min(messagePageSize, startIndex)} 条消息
            </button>
          )}
          {thinkingGroups.filter((group) => group.owner < startIndex).map(renderThinking)}
          {visibleItems.map((item) =>
            item.kind === 'message' ? (
              renderMessage(item.index)
            ) : item.kind === 'errors' ? (
              <RetryErrorGroup
                key={`${selected?.id}:${item.id}`}
                messages={messages}
                indices={item.indices}
                visibleIndices={item.visibleIndices}
                activeIndex={activeMatch?.messageIndex}
                renderMessage={renderMessage}
              />
            ) : (
              <ToolGroupCard
                key={item.id}
                tools={item.indices.map((index) => messageContext.toolFor(messages[index]))}
                visibleCount={item.visibleIndices.length}
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
                {item.visibleIndices.map(renderMessage)}
              </ToolGroupCard>
            ),
          )}
          {endIndex < messages.length && (
            <button className="load-history load-newer" onClick={() => jump(endIndex)}>
              加载更新的 {Math.min(messagePageSize, messages.length - endIndex)} 条消息
            </button>
          )}
          {endIndex === messages.length && placedTools.trailing.map(renderTool)}
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
        <TurnOutline
          key={selected?.id}
          turns={turns}
          active={activeTurn}
          running={ownRuntime && running}
          jump={jumpToTurn}
          focusConversation={() => thread.current?.focus({ preventScroll: true })}
          copyReply={(index) => messageContext.copy(messageText(messages[index]))}
          notice={props.setNotice}
        />
      )}
      {(newContent || endIndex < messages.length) && (
        <button className="new-content" title="滚到底部并继续跟随输出" onClick={showLatest}>
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
    </>
  );
}
