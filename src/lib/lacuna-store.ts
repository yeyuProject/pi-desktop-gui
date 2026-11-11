/**
 * 知溯的界面状态：认词结果的缓存、批量请求，以及右侧知识图面板的状态。
 * 认词在主进程里完成（electron/lacuna.ts），这里只缓存结果，知识库变化时清空。
 * 知识库只有一个（lacuna ADR-0010），所以这里的一切都和当前会话无关：切换会话不清缓存，也不关面板。
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
/** 知识库变化、开关切换时加一，让已经渲染的文字重新认词。 */
let revision = 0;
const annotations = new Map<string, LacunaAnnotation>();
const terms = new Map<string, LacunaTerm>();
const queued = new Set<string>();
let flushing: ReturnType<typeof setTimeout> | undefined;

/** 知识图面板的两种看法：graph 是词和词连成的关系图，outline 是按目标列出的大纲。 */
export type LacunaMapView = 'graph' | 'outline';
/** 右侧面板：stack 为空时显示知识图，否则显示解释卡片，stack 是顶部的路径。 */
let panel: { stack: string[]; view: LacunaMapView } | undefined;
/** 上一次看的是关系图还是大纲，关掉面板后再打开时沿用。 */
let lastView: LacunaMapView = 'graph';

const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

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

/** 由工作台在设置变化时调用：关掉时不再认词，面板也关掉。 */
export function setLacunaEnabled(on: boolean) {
  if (on === enabled) return;
  enabled = on;
  if (!on) panel = undefined;
  reset();
  emit();
}

function request(text: string) {
  if (annotations.has(text) || queued.has(text)) return;
  queued.add(text);
  flushing ??= setTimeout(flush, 0);
}

async function flush() {
  flushing = undefined;
  const texts = [...queued];
  queued.clear();
  const startedAt = revision;
  for (let i = 0; i < texts.length; i += LACUNA_MAX_TEXTS) {
    const chunk = texts.slice(i, i + LACUNA_MAX_TEXTS);
    let results: LacunaAnnotation[];
    try {
      results = await api.invoke('lacunaAnnotate', chunk);
    } catch {
      // 认词失败不影响阅读：当作没认出词，原文照常显示。
      results = chunk.map(() => ({ matches: [], terms: {} }));
    }
    // 等结果的时候知识库变了，这批结果已经过时，丢掉，下一次渲染会重新请求。
    if (revision !== startedAt) return;
    chunk.forEach((text, index) => {
      const result = results?.[index] ?? { matches: [], terms: {} };
      annotations.set(text, result);
      for (const term of Object.values(result.terms)) terms.set(term.id, term);
    });
  }
  while (annotations.size > MAX_CACHED) annotations.delete(annotations.keys().next().value as string);
  emit();
}

/** 一段 Markdown 的认词结果。还没拿到、功能关闭或文字太长时返回 undefined。 */
export function useLacunaAnnotation(text: string, on = true): LacunaAnnotation | undefined {
  const active = on && enabled && text.length <= LACUNA_MAX_TEXT_LENGTH;
  const current = useSyncExternalStore(subscribe, () => revision);
  const annotation = useSyncExternalStore(subscribe, () => (active ? annotations.get(text) : undefined));
  useEffect(() => {
    if (active && !annotation) request(text);
  }, [active, text, annotation, current]);
  return annotation;
}

export function lacunaTerm(id: string): LacunaTerm | undefined {
  return terms.get(id);
}

export function useLacunaEnabled() {
  return useSyncExternalStore(subscribe, () => enabled);
}

export function useLacunaRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}

/** 打开解释卡片。nested 为 true 时接在当前路径后面（在卡片里点了一个词），否则从这个词开始。 */
export function openLacunaNode(id: string, nested = false) {
  if (!enabled) return;
  if (nested && panel) {
    const at = panel.stack.indexOf(id);
    panel = { ...panel, stack: at === -1 ? [...panel.stack, id] : panel.stack.slice(0, at + 1) };
  } else {
    panel = { stack: [id], view: panel?.view ?? lastView };
  }
  emit();
}

/** 点顶部路径里的某一层，回到那一层；index 为 -1 时回到知识图。 */
export function backToLacunaNode(index: number) {
  if (!panel) return;
  panel = { ...panel, stack: panel.stack.slice(0, index + 1) };
  emit();
}

/** 顶栏的“知识图”按钮：打开知识图；已经在看知识图时关掉面板。 */
export function toggleLacunaMap() {
  if (!enabled) return;
  panel = panel && panel.stack.length === 0 ? undefined : { stack: [], view: panel?.view ?? lastView };
  emit();
}

export function setLacunaMapView(view: LacunaMapView) {
  lastView = view;
  if (panel) panel = { ...panel, view };
  emit();
}

export function closeLacunaPanel() {
  panel = undefined;
  emit();
}

export function useLacunaPanel() {
  return useSyncExternalStore(subscribe, () => panel);
}
