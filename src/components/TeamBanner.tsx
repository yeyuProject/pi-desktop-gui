import type { Session, Message } from '../../shared/types';
import { messageText } from '../../shared/types';
import { teamMemberActive } from '../../shared/team';
import { truncateQuote } from '../../shared/message-content';
export function TeamBanner({
  session,
  sessions,
  messages,
  select,
  attempt,
}: {
  session: Session;
  sessions: Session[];
  messages: Message[];
  select: (session: Session) => Promise<void>;
  attempt: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  if (!session.team) return null;
  const lead = sessions.find((s) => s.id === session.team!.leadId);
  const active = teamMemberActive(session.team.status);
  const last = messages.findLast((m) => m.role === 'assistant' && messageText(m).trim());
  return (
    <div className="team-banner">
      <span>
        由 {lead?.title ?? '已删除的负责人'} 分派 · 角色 {session.team.role}
        {!active && <small> · 之后的对话不会自动同步给负责人</small>}
      </span>
      <button disabled={!lead} onClick={() => lead && void select(lead)}>
        返回负责人
      </button>
      {!active && (
        <button
          disabled={!lead || !last}
          onClick={() =>
            lead &&
            last &&
            void attempt(async () => {
              const quote = truncateQuote({
                id: crypto.randomUUID(),
                text: messageText(last),
                role: 'assistant',
                turn: 0,
                messageTimestamp: last.timestamp ?? 0,
                section: 'text',
              });
              await window.desktop.invoke(
                'saveDraft',
                lead.id,
                lead.draft,
                lead.attachments,
                undefined,
                lead.draftSnippets,
                [...(lead.draftQuotes ?? []), quote],
              );
              await select(lead);
            })
          }
        >
          引用到负责人
        </button>
      )}
    </div>
  );
}
