import { teamMemberActive, teamStatusLabels, type TeamSnapshot } from '../../../shared/team';
export function TeamStrip({
  snapshots,
  toggle,
}: {
  snapshots: TeamSnapshot[];
  toggle: (key: string, open: boolean) => void;
}) {
  const members = snapshots.flatMap((s) => s.members.map((m) => ({ member: m, snapshot: s })));
  const active = members.filter(({ member }) => teamMemberActive(member.status));
  if (!active.length) return null;
  const running = active.filter(({ member }) => member.status !== 'queued').length;
  const queued = active.length - running;
  const priority = (status: string) => (status === 'waiting' ? 0 : status === 'failed' ? 1 : 2);
  const attention = members
    .filter(({ member }) => teamMemberActive(member.status) || member.status === 'failed')
    .sort(
      (a, b) =>
        priority(a.member.status) - priority(b.member.status) ||
        (a.member.startedAt ?? Infinity) - (b.member.startedAt ?? Infinity),
    )[0];
  return (
    <div className="team-strip">
      <strong>
        团队 {running}/{members.length} 运行中{queued ? ` · ${queued} 排队中` : ''}
      </strong>
      <span>
        {attention.member.name} ·{' '}
        {attention.member.status === 'waiting'
          ? '等待确认'
          : (attention.member.queueReason ??
            attention.member.error?.message ??
            attention.member.action ??
            teamStatusLabels[attention.member.status])}
      </span>
      <button
        onClick={() => {
          toggle(`team:${attention.snapshot.toolCallId}`, true);
          toggle(`team:${attention.snapshot.toolCallId}:${attention.member.name}`, true);
          window.dispatchEvent(new CustomEvent('pi:team-card', { detail: attention.snapshot.toolCallId }));
          document
            .querySelector<HTMLElement>(`[data-team-call="${CSS.escape(attention.snapshot.toolCallId)}"]`)
            ?.scrollIntoView({ block: 'center' });
        }}
      >
        查看
      </button>
    </div>
  );
}
