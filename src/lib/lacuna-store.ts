/**
 * 知溯术语解释的界面状态：认词结果的缓存、批量请求，以及解释卡片的路径。
 * 认词在主进程里完成（electron/lacuna.ts），这里只缓存结果，知识库变化时清空。
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  LACUNA_MAX_TEXTS,
  LACUNA_MAX_TEXT_LENGTH,
  type LacunaAnnotation,
  type LacunaTerm,
} from '../../shared/lacuna';

const api = window.desktop;
const listeners = new Set<() => void>();
const MAX_CACHED = 2000;

let enabled = true;
let sessionId: string | undefined;
/** 知识库变化、开关切换、换会话时加一，让已经渲染的文字重新认词。 */
let revision = 0;
const annotations = new Map<string, LacunaAnnotation>();
const terms = new Map<string, LacunaTerm>();
const queued = new Map<string, { session: string; text: string }>();
let flushing: ReturnType<typeof setTimeout> | undefined;

/** 解释卡片：stack 是顶部的路径，最后一个是正在看的词。 */
let panel: { session: string; stack: string[] } | undefined;

const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const key = (session: string, text: string) => session + '\0' + text;

function reset() {
  annotations.clear();
  terms.clear();
  revision++;
}

api?.onEvent?.((event) => {
  if (event.type !== 'lacunaChanged') return;
  reset();
  emit();
});

/** 由工作台在选中会话或设置变化时调用。 */
export function setLacunaContext(session: string | undefined, on: boolean) {
  if (session === sessionId && on === enabled) return;
  if (session !== sessionId) panel = undefined;
  sessionId = session;
  enabled = on;
  reset();
  emit();
}

function request(session: string, text: string) {
  const id = key(session, text);
  if (annotations.has(id) || queued.has(id)) return;
  queued.set(id, { session, text });
  flushing ??= setTimeout(flush, 0);
}

async function flush() {
  flushing = undefined;
  const batch = [...queued.values()];
  queued.clear();
  const startedAt = revision;
  const bySession = new Map<string, string[]>();
  for (const { session, text } of batch) bySession.set(session, [...(bySession.get(session) ?? []), text]);
  for (const [session, texts] of bySession) {
    for (let i = 0; i < texts.length; i += LACUNA_MAX_TEXTS) {
      const chunk = texts.slice(i, i + LACUNA_MAX_TEXTS);
      let results: LacunaAnnotation[];
      try {
        results = await api.invoke('lacunaAnnotate', session, chunk);
      } catch {
        // 认词失败不影响阅读：当作没认出词，原文照常显示。
        results = chunk.map(() => ({ matches: [], terms: {} }));
      }
      // 等结果的时候知识库变了，这批结果已经过时，丢掉，下一次渲染会重新请求。
      if (revision !== startedAt) return;
      chunk.forEach((text, index) => {
        const result = results?.[index] ?? { matches: [], terms: {} };
        annotations.set(key(session, text), result);
        for (const term of Object.values(result.terms)) terms.set(key(session, term.id), term);
      });
    }
  }
  while (annotations.size > MAX_CACHED) annotations.delete(annotations.keys().next().value as string);
  emit();
}

/** 一段 Markdown 的认词结果。还没拿到、功能关闭或文字太长时返回 undefined。 */
export function useLacunaAnnotation(text: string, on = true): LacunaAnnotation | undefined {
  const active = on && enabled && sessionId !== undefined && text.length <= LACUNA_MAX_TEXT_LENGTH;
  const session = sessionId;
  const current = useSyncExternalStore(subscribe, () => revision);
  const annotation = useSyncExternalStore(subscribe, () =>
    active && session ? annotations.get(key(session, text)) : undefined,
  );
  useEffect(() => {
    if (active && session && !annotation) request(session, text);
  }, [active, session, text, annotation, current]);
  return annotation;
}

export function lacunaTerm(id: string): LacunaTerm | undefined {
  return sessionId ? terms.get(key(sessionId, id)) : undefined;
}

export function useLacunaEnabled() {
  return useSyncExternalStore(subscribe, () => enabled && sessionId !== undefined);
}

export function useLacunaRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}

export function currentLacunaSession() {
  return sessionId;
}

/** 打开解释卡片。nested 为 true 时接在当前路径后面（在卡片里点了一个词），否则从这个词开始。 */
export function openLacunaNode(id: string, nested = false) {
  if (!sessionId) return;
  if (nested && panel?.session === sessionId) {
    const at = panel.stack.indexOf(id);
    panel = { session: sessionId, stack: at === -1 ? [...panel.stack, id] : panel.stack.slice(0, at + 1) };
  } else {
    panel = { session: sessionId, stack: [id] };
  }
  emit();
}

/** 点顶部路径里的某一层，回到那一层。 */
export function backToLacunaNode(index: number) {
  if (!panel) return;
  panel = { ...panel, stack: panel.stack.slice(0, index + 1) };
  emit();
}

export function closeLacunaPanel() {
  panel = undefined;
  emit();
}

export function useLacunaPanel() {
  return useSyncExternalStore(subscribe, () => (panel?.session === sessionId ? panel : undefined));
}
