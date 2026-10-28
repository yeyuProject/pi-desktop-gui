export interface SessionUsage {
  tokens?: number;
  cost?: number;
}
export interface UsageTotals {
  sessions: number;
  tokens: number;
  cost: number;
  missingTokens: number;
  missingCost: number;
}
export interface ProjectUsage extends UsageTotals {
  projectId?: string;
  name: string;
  costShare: number;
}
export interface UsagePeriod extends UsageTotals {
  projects: ProjectUsage[];
  sideChat?: { tokens: number; cost: number };
}
export interface LocalUsageSummary {
  asOf: number;
  today: UsagePeriod;
  week: UsagePeriod;
  all: UsagePeriod;
}
type UsageSession = {
  projectId?: string;
  updatedAt: number;
  stats?: SessionUsage;
  sideUsage?: { tokens: number; cost: number; updatedAt: number };
};
const emptyTotals = (): UsageTotals => ({
  sessions: 0,
  tokens: 0,
  cost: 0,
  missingTokens: 0,
  missingCost: 0,
});

function addUsage(total: UsageTotals, stats?: SessionUsage) {
  total.sessions++;
  if (typeof stats?.tokens === 'number' && Number.isFinite(stats.tokens) && stats.tokens >= 0)
    total.tokens += stats.tokens;
  else total.missingTokens++;
  if (typeof stats?.cost === 'number' && Number.isFinite(stats.cost) && stats.cost >= 0)
    total.cost += stats.cost;
  else total.missingCost++;
}

/** Periods select whole sessions by updatedAt; their lifetime usage is not a daily billing ledger. */
export function aggregateUsage(
  sessions: readonly UsageSession[],
  projects: readonly { id: string; name: string }[],
  now = Date.now(),
): LocalUsageSummary {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(day.getDate() - 6);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const summarize = (since: number): UsagePeriod => {
    const total = emptyTotals();
    const sideChat = { tokens: 0, cost: 0 };
    let hasSide = false;
    const groups = new Map<string, ProjectUsage>();
    for (const session of sessions) {
      if (session.updatedAt < since || (since !== -Infinity && session.updatedAt > now)) continue;
      addUsage(total, session.stats);
      const key = session.projectId ?? '';
      let group = groups.get(key);
      if (!group) {
        group = {
          ...emptyTotals(),
          projectId: session.projectId,
          name: session.projectId ? (names.get(session.projectId) ?? '已移除项目') : '独立对话',
          costShare: 0,
        };
        groups.set(key, group);
      }
      addUsage(group, session.stats);
    }
    for (const session of sessions) {
      const usage = session.sideUsage;
      if (!usage || usage.updatedAt < since || (since !== -Infinity && usage.updatedAt > now)) continue;
      hasSide = true;
      sideChat.tokens += usage.tokens;
      sideChat.cost += usage.cost;
      total.tokens += usage.tokens;
      total.cost += usage.cost;
      const key = session.projectId ?? '';
      let group = groups.get(key);
      if (!group) {
        group = {
          ...emptyTotals(),
          projectId: session.projectId,
          name: session.projectId ? (names.get(session.projectId) ?? '已移除项目') : '独立对话',
          costShare: 0,
        };
        groups.set(key, group);
      }
      group.tokens += usage.tokens;
      group.cost += usage.cost;
    }
    for (const group of groups.values()) group.costShare = total.cost ? group.cost / total.cost : 0;
    return {
      ...total,
      ...(hasSide ? { sideChat } : {}),
      projects: [...groups.values()].sort(
        (a, b) => b.cost - a.cost || b.tokens - a.tokens || a.name.localeCompare(b.name),
      ),
    };
  };
  return {
    asOf: now,
    today: summarize(day.getTime()),
    week: summarize(week.getTime()),
    all: summarize(-Infinity),
  };
}

export function isOlderSession(session: { pinned?: boolean; updatedAt: number }, now = Date.now()) {
  return !session.pinned && session.updatedAt < now - 7 * 24 * 60 * 60 * 1000;
}
