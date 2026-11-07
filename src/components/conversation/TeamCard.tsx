import { useEffect, useRef, useState } from 'react';
import {
  isTeamSnapshot,
  teamMemberActive,
  teamStatusLabels,
  type TeamSnapshot,
  type TeamMemberStatus,
} from '../../../shared/team';
import type { Session } from '../../../shared/types';
import type { MessageContext } from './ChatMessage';
import { compactGoalTokens } from '../../../shared/goal';
import { RichText } from './Markdown';
import { SearchHighlight } from './SearchHighlight';
import '../../../src/styles/team.css';

export function teamSnapshot(
  toolCallId: string,
  details: unknown,
  live: TeamSnapshot[] | undefined,
  sessions: Session[],
): TeamSnapshot | undefined {
  const current = live?.find((s) => s.toolCallId === toolCallId);
  if (current) return current;
  if (isTeamSnapshot(details)) return details;
  const members = sessions.filter((s) => s.team?.toolCallId === toolCallId);
  const link = members[0]?.team;
  if (!link) return;
  const active = members.some((s) => teamMemberActive(s.team!.status));
  return {
    version: 1,
    leadId: link.leadId,
    dispatchId: link.dispatchId,
    toolCallId,
    startedAt: Math.min(...members.map((s) => s.updatedAt)),
    ...(active ? {} : { endedAt: Math.max(...members.map((s) => s.updatedAt)) }),
    members: members.map((s) => ({
      sessionId: s.id,
      name: s.team!.name,
      role: s.team!.role,
      task: s.team!.task,
      status: active ? s.team!.status : 'interrupted',
      ...(s.team!.status === 'queued' ? { queueReason: '等待空位' as const } : {}),
      writable: s.team!.approvalMode !== 'readonly',
      tokens: s.stats?.tokens ?? 0,
      billedTokens: s.stats?.tokens ?? 0,
      cost: 0,
      added: 0,
      removed: 0,
      files: [],
      recent: [],
    })),
  };
}
const icons = {
  queued: '◷',
  starting: '◐',
  running: '◐',
  waiting: '⚠',
  completed: '✓',
  failed: '✕',
  stopped: '■',
  budget_limited: '■',
  interrupted: '!',
};
const elapsed = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function TeamCard({
  snapshot,
  ctx,
  query,
}: {
  snapshot: TeamSnapshot;
  ctx: MessageContext;
  query?: string;
}) {
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [reports, setReports] = useState<string[]>([]);
  const active = snapshot.members.some((m) => teamMemberActive(m.status));
  const key = `team:${snapshot.toolCallId}`;
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) ctx.toggleTool(key, false);
    wasActive.current = active;
  }, [active, key, ctx.toggleTool]);
  const open = active || ctx.expanded.includes(key) || !!query;
  const owned = snapshot.leadId === ctx.sessionId;
  const announcement = snapshot.members.map((m) => `${m.name} ${teamStatusLabels[m.status]}`).join('，');
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, visible]);
  const counts = Object.entries(teamStatusLabels)
    .flatMap(([status, label]) => {
      const count = snapshot.members.filter((m) => m.status === status).length;
      return count ? [`${count} ${label}`] : [];
    })
    .join(' · ');
  const statusAction = (status: TeamMemberStatus, action?: string) =>
    ['starting', 'stopped', 'budget_limited', 'interrupted'].includes(status) ? '—' : action;
  const interrupted = snapshot.members.every((m) => m.status === 'interrupted');
  return (
    <section className="team-card" data-team-call={snapshot.toolCallId} ref={root} aria-label="团队卡">
      <span className="team-status-announcement" role="status" aria-live="polite">
        {announcement}
      </span>
      <header>
        <button onClick={() => ctx.toggleTool(key, !open)} aria-expanded={open}>
          {open ? '▾' : '▸'} 团队 · {interrupted ? '已中断' : `${snapshot.members.length} 个成员 · ${counts}`}
          {' · '}
          {compactGoalTokens(snapshot.members.reduce((n, m) => n + m.tokens, 0))}
          {' · '}
          {elapsed(Math.max(0, (snapshot.endedAt ?? now) - snapshot.startedAt))}
          {' · +'}
          {snapshot.members.reduce((n, m) => n + m.added, 0)} −
          {snapshot.members.reduce((n, m) => n + m.removed, 0)}
        </button>
        {active && owned && (
          <button title="停止所有成员，Pi 会用已完成的汇报继续" onClick={() => ctx.stopTeam?.()}>
            全部停止
          </button>
        )}
      </header>
      {open && (
        <ul>
          {snapshot.members.map((member) => {
            const rowKey = `${key}:${member.name}`;
            const match =
              !!query &&
              `${member.name}\n${member.task}\n${member.report ?? ''}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase());
            const collapsedKey = `${rowKey}:collapsed`;
            const expanded =
              ctx.expanded.includes(rowKey) ||
              (member.status === 'failed' && !ctx.expanded.includes(collapsedKey)) ||
              match;
            const deleted = !ctx.teamSessions?.some((s) => s.id === member.sessionId);
            const reportOpen = reports.includes(member.sessionId) || match;
            const reportLines = member.report?.split('\n') ?? [];
            return (
              <li key={member.sessionId} className={'team-member ' + member.status}>
                <button
                  className="team-member-row"
                  aria-expanded={expanded}
                  onClick={() => {
                    ctx.toggleTool(rowKey, !expanded);
                    ctx.toggleTool(collapsedKey, expanded);
                  }}
                >
                  <span className="team-member-identity">
                    <span>
                      {icons[member.status]} {teamStatusLabels[member.status]}
                    </span>
                    <strong title={member.name}>
                      <SearchHighlight text={member.name} query={query ?? ''} />
                    </strong>
                    <small>{member.role}</small>
                  </span>
                  <span className="team-member-progress">
                    <span>
                      {deleted
                        ? '会话已删除'
                        : (member.queueReason ??
                          member.error?.message ??
                          (member.status === 'completed'
                            ? member.report?.split('\n')[0]
                            : statusAction(member.status, member.action)) ??
                          '—')}
                    </span>
                    <small>
                      {elapsed(Math.max(0, (member.endedAt ?? now) - (member.startedAt ?? now)))} ·{' '}
                      {compactGoalTokens(member.tokens)} · +{member.added} −{member.removed}
                    </small>
                  </span>
                </button>
                {expanded && (
                  <div className="team-member-details">
                    <div className="team-member-actions">
                      <button disabled={deleted} onClick={() => ctx.openTeamMember?.(member.sessionId)}>
                        打开
                      </button>
                      {teamMemberActive(member.status) && owned && (
                        <button onClick={() => ctx.stopTeam?.(member.sessionId)}>停止</button>
                      )}
                      {!teamMemberActive(member.status) && member.report && (
                        <>
                          <button
                            onClick={() =>
                              setReports((before) =>
                                before.includes(member.sessionId)
                                  ? before.filter((id) => id !== member.sessionId)
                                  : [...before, member.sessionId],
                              )
                            }
                          >
                            查看汇报
                          </button>
                          <button onClick={() => ctx.quoteTeam?.(member.report!, snapshot.toolCallId)}>
                            引用
                          </button>
                        </>
                      )}
                    </div>
                    <details open={match || undefined}>
                      <summary>任务：{member.task.split('\n').slice(0, 2).join('\n')} · 展开全文</summary>
                      <p>
                        <SearchHighlight text={member.task} query={query ?? ''} />
                      </p>
                    </details>
                    {member.warning && <p className="team-warning">{member.warning}</p>}
                    {member.error && <p className="team-error">{member.error.message}</p>}
                    <ol>
                      {member.recent.map((action, i) => (
                        <li key={i}>
                          {action.status === 'running' ? '◐' : action.status === 'error' ? '✕' : '✓'}{' '}
                          <code>{action.tool}</code> {action.target}
                        </li>
                      ))}
                    </ol>
                    {reportOpen && (
                      <div className="team-report">
                        <RichText text={reportLines.slice(0, 40).join('\n')} />
                        {reportLines.length > 40 && (
                          <details open={match || undefined}>
                            <summary>展开全文</summary>
                            <RichText text={reportLines.slice(40).join('\n')} />
                          </details>
                        )}
                        {member.reportTruncated && (
                          <p>
                            完整汇报见成员会话{' '}
                            <button disabled={deleted} onClick={() => ctx.openTeamMember?.(member.sessionId)}>
                              打开
                            </button>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
