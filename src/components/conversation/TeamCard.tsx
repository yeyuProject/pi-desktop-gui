import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  isTeamSnapshot,
  teamMemberActive,
  teamReportHeadline,
  teamRoleLabel,
  teamStatusLabels,
  teamToolAction,
  type TeamMemberSnapshot,
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
  // New sessions are inserted first, so reverse to restore the dispatch order.
  const members = sessions.filter((s) => s.team?.toolCallId === toolCallId).reverse();
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
const lineChanges = (added: number, removed: number) => (added || removed ? ` · +${added} −${removed}` : '');
const TASK_PREVIEW_CHARS = 160;

/** Renders the report once and clamps it with CSS, so Markdown blocks are never split. */
function TeamReport({ text, open }: { text: string; open: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const expanded = full || open;
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || expanded) return;
    const measure = () => setOverflow(node.scrollHeight > node.clientHeight + 1);
    measure();
    // The clamped box stops resizing once it is full; observe the content too.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <div
        ref={body}
        className={
          'team-report-body' + (expanded ? '' : ' clamped') + (!expanded && overflow ? ' faded' : '')
        }
      >
        <RichText text={text} />
      </div>
      {!open && (overflow || full) && (
        <button className="team-report-more" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? '收起全文' : '展开全文'}
        </button>
      )}
    </>
  );
}

function TeamTask({ task, query, forced }: { task: string; query?: string; forced: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = task.split('\n');
  const long = lines.length > 2 || task.length > TASK_PREVIEW_CHARS;
  if (!long)
    return (
      <p className="team-task">
        任务：
        <SearchHighlight text={task} query={query ?? ''} />
      </p>
    );
  const expanded = open || forced;
  return (
    <div className="team-task">
      {expanded ? (
        <p>
          任务：
          <SearchHighlight text={task} query={query ?? ''} />
        </p>
      ) : (
        <p>任务：{lines.slice(0, 2).join('\n').slice(0, TASK_PREVIEW_CHARS)}…</p>
      )}
      {!forced && (
        <button className="team-text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起任务' : '展开全文'}
        </button>
      )}
    </div>
  );
}

/** Announces only members whose status changed, never the whole list again. */
function useStatusAnnouncement(members: TeamMemberSnapshot[]) {
  const previous = useRef<Map<string, TeamMemberStatus> | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(members.map((m) => [m.sessionId, m.status]));
    // History cards mount silently; only later changes are announced.
    if (!before) return;
    const changed = members
      .filter((m) => before.get(m.sessionId) !== m.status)
      .map((m) => `${m.name} ${teamStatusLabels[m.status]}`);
    if (changed.length) setAnnouncement(changed.join('，'));
  }, [members]);
  return announcement;
}

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
  const announcement = useStatusAnnouncement(snapshot.members);
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
  const title = interrupted
    ? `团队 · 已中断 · ${snapshot.members.length} 个成员`
    : `团队 · ${snapshot.members.length} 个成员 · ${counts}`;
  const meta = `用时 ${elapsed(Math.max(0, (snapshot.endedAt ?? now) - snapshot.startedAt))} · ${compactGoalTokens(
    snapshot.members.reduce((n, m) => n + m.tokens, 0),
  )} tokens${lineChanges(
    snapshot.members.reduce((n, m) => n + m.added, 0),
    snapshot.members.reduce((n, m) => n + m.removed, 0),
  )}`;
  const heading = (
    <>
      <span className="team-card-name">{title}</span>
      <small>{meta}</small>
    </>
  );
  return (
    <section className="team-card" data-team-call={snapshot.toolCallId} ref={root} aria-label="团队卡">
      <span className="team-status-announcement" role="status" aria-live="polite">
        {announcement}
      </span>
      <header>
        {/* Running cards stay expanded, so the title is only a toggle afterwards. */}
        {active ? (
          <div className="team-card-title">{heading}</div>
        ) : (
          <button className="team-card-title" onClick={() => ctx.toggleTool(key, !open)} aria-expanded={open}>
            <ChevronDown size={14} />
            {heading}
          </button>
        )}
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
            const failed = member.status === 'failed';
            const expanded =
              ctx.expanded.includes(rowKey) || (failed && !ctx.expanded.includes(collapsedKey)) || match;
            const deleted = !ctx.teamSessions?.some((s) => s.id === member.sessionId);
            const reportOpen = reports.includes(member.sessionId) || match;
            return (
              <li key={member.sessionId} className={'team-member ' + member.status}>
                <button
                  className="team-member-row"
                  aria-expanded={expanded}
                  onClick={() => {
                    // Failed rows open by default, so they remember a collapse instead.
                    if (failed) {
                      ctx.toggleTool(collapsedKey, expanded);
                      if (expanded) ctx.toggleTool(rowKey, false);
                    } else ctx.toggleTool(rowKey, !expanded);
                  }}
                >
                  <span className="team-member-identity">
                    <span>
                      {icons[member.status]} {teamStatusLabels[member.status]}
                    </span>
                    <strong title={member.name}>
                      <SearchHighlight text={member.name} query={query ?? ''} />
                    </strong>
                    <small>{teamRoleLabel(member.role)}</small>
                  </span>
                  <span className="team-member-progress">
                    <span>
                      {deleted
                        ? '会话已删除'
                        : (member.queueReason ??
                          member.error?.message ??
                          (member.status === 'completed'
                            ? teamReportHeadline(member.report)
                            : statusAction(member.status, member.action)) ??
                          '—')}
                    </span>
                    <small>
                      {member.startedAt
                        ? elapsed(Math.max(0, (member.endedAt ?? now) - member.startedAt))
                        : '—'}{' '}
                      · {compactGoalTokens(member.tokens)} tokens
                      {lineChanges(member.added, member.removed)}
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
                            aria-expanded={reportOpen}
                            onClick={() =>
                              setReports((before) =>
                                before.includes(member.sessionId)
                                  ? before.filter((id) => id !== member.sessionId)
                                  : [...before, member.sessionId],
                              )
                            }
                          >
                            {reportOpen ? '收起汇报' : '查看汇报'}
                          </button>
                          <button onClick={() => ctx.quoteTeam?.(member.report!, snapshot.toolCallId)}>
                            引用
                          </button>
                        </>
                      )}
                    </div>
                    <TeamTask task={member.task} query={query} forced={match} />
                    {member.warning && <p className="team-warning">{member.warning}</p>}
                    {member.error && <p className="team-error">{member.error.message}</p>}
                    {member.recent.length > 0 && (
                      <ol className="team-recent">
                        {member.recent.map((action, i) => (
                          <li key={i}>
                            {action.status === 'running' ? '◐' : action.status === 'error' ? '✕' : '✓'}{' '}
                            {teamToolAction(action.tool, action.target)}
                          </li>
                        ))}
                      </ol>
                    )}
                    {reportOpen && member.report && (
                      <div className="team-report">
                        <TeamReport text={member.report} open={match} />
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
