import { LACUNA_MAX_TEXTS, LACUNA_MAX_TEXT_LENGTH } from '../../shared/lacuna';
import type { LacunaService } from '../lacuna';
import type { HandlerContext, HandlerMap } from './handler-context';

interface LacunaHandlerContext extends Pick<HandlerContext, 'text'> {
  lacuna: LacunaService;
}
export type LacunaHandlerName = 'lacunaStatus' | 'lacunaAnnotate' | 'lacunaNode' | 'lacunaGraph';

/** 知溯术语解释和知识图：知识库只有一个，和会话无关（lacuna ADR-0010，见 electron/lacuna.ts）。 */
export function createLacunaHandlers(context: LacunaHandlerContext) {
  const { lacuna } = context;
  const text: HandlerContext['text'] = context.text;

  const handlers: HandlerMap<LacunaHandlerName> = {
    lacunaStatus: async () => lacuna.status(),
    lacunaAnnotate: async (texts) => {
      if (!Array.isArray(texts) || texts.length > LACUNA_MAX_TEXTS) throw new Error('要认词的文字太多');
      for (const value of texts) text(value, LACUNA_MAX_TEXT_LENGTH);
      return lacuna.annotate(texts);
    },
    lacunaNode: async (id) => {
      text(id, 300);
      return lacuna.node(id);
    },
    lacunaGraph: async () => lacuna.graph(),
  };
  return { handlers };
}
