import { LACUNA_MAX_TEXTS, LACUNA_MAX_TEXT_LENGTH } from '../../shared/lacuna';
import type { LacunaService } from '../lacuna';
import type { HandlerContext, HandlerMap } from './handler-context';

interface LacunaHandlerContext extends Pick<HandlerContext, 'store' | 'text'> {
  lacuna: LacunaService;
}
export type LacunaHandlerName = 'lacunaStatus' | 'lacunaAnnotate' | 'lacunaNode' | 'lacunaGraph';

/** 知溯术语解释：按会话的工作目录找到知识库，认词、读取解释（见 electron/lacuna.ts）。 */
export function createLacunaHandlers(context: LacunaHandlerContext) {
  const { store, lacuna } = context;
  const text: HandlerContext['text'] = context.text;

  const handlers: HandlerMap<LacunaHandlerName> = {
    lacunaStatus: async (sessionId) => {
      text(sessionId, 100);
      return lacuna.status(await store.sessionDirectory(sessionId));
    },
    lacunaAnnotate: async (sessionId, texts) => {
      text(sessionId, 100);
      if (!Array.isArray(texts) || texts.length > LACUNA_MAX_TEXTS) throw new Error('要认词的文字太多');
      for (const value of texts) text(value, LACUNA_MAX_TEXT_LENGTH);
      return lacuna.annotate(await store.sessionDirectory(sessionId), texts);
    },
    lacunaNode: async (sessionId, id) => {
      text(sessionId, 100);
      text(id, 300);
      return lacuna.node(await store.sessionDirectory(sessionId), id);
    },
    lacunaGraph: async (sessionId) => {
      text(sessionId, 100);
      return lacuna.graph(await store.sessionDirectory(sessionId));
    },
  };
  return { handlers };
}
