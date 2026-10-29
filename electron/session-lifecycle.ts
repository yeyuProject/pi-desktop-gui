import type { Session } from '../shared/types';

/** Durable user state, rather than layout/zero-usage initialization. */
export function hasSessionData(session: Session): boolean {
  return Boolean(
    session.lastStatus !== 'idle' ||
    session.cwd ||
    session.unread ||
    session.title !== (session.projectId ? '新会话' : '新对话') ||
    session.model ||
    session.thinking !== undefined ||
    session.approvalMode !== undefined ||
    session.pinned ||
    session.draft ||
    session.draftGoal ||
    session.attachments.length ||
    session.images?.length ||
    session.draftSnippets?.length ||
    session.draftQuotes?.length ||
    session.sideUsage ||
    session.stats?.tokens ||
    session.stats?.cost,
  );
}

/** This predicate alone never makes a historical blank a transient placeholder. */
export function isReusableSession(session: Session): boolean {
  return !session.file && !hasSessionData(session);
}
