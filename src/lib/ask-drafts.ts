import type { AskRequest, AskSelection } from '../../shared/ask';
import type { ExtensionDialog } from '../../shared/types';

export interface AskDraft {
  answers: Record<string, AskSelection>;
  otherOpen: string[];
  note: string;
  noteOpen: boolean;
}
const drafts = new Map<string, Map<string, AskDraft>>();
const activeDialogs = new Map<string, Set<string>>();
export function getAskDraft(sessionId: string, id: string, request: AskRequest): AskDraft {
  return (
    drafts.get(sessionId)?.get(id) ?? {
      answers: Object.fromEntries(request.questions.map((question) => [question.id, { selected: [] }])),
      otherOpen: [],
      note: '',
      noteOpen: false,
    }
  );
}
export function saveAskDraft(sessionId: string, id: string, draft: AskDraft) {
  if (!activeDialogs.get(sessionId)?.has(id)) return;
  const session = drafts.get(sessionId) ?? new Map<string, AskDraft>();
  session.set(id, draft);
  drafts.set(sessionId, session);
}
export function retainAskDrafts(sessionId: string, dialogs: ExtensionDialog[]) {
  const active = new Set(dialogs.filter((dialog) => dialog.ask).map((dialog) => dialog.id));
  if (active.size) activeDialogs.set(sessionId, active);
  else activeDialogs.delete(sessionId);
  const session = drafts.get(sessionId);
  if (!session) return;
  for (const id of session.keys()) if (!active.has(id)) session.delete(id);
  if (!session.size) drafts.delete(sessionId);
}
