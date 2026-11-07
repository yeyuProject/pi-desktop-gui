import { isReadTool, type ApprovalMode } from './approval';
import { parseAttachmentSpec } from './attachments';
import type { ModelErrorKind } from './errors';

export const TEAM_TOOLS = ['desktop_team_roles', 'desktop_team_dispatch'] as const;
export const TEAM_REPORT_BYTES = 50 * 1024;
export const TEAM_MAX_DISPATCHES = 3;
export interface TeamSettings {
  concurrency: number;
  /** null means unlimited; same accounting basis as Goal. */
  memberTokenBudget: number | null;
  memberModel: { provider: string; id: string } | null;
}
export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  concurrency: 3,
  memberTokenBudget: 1_000_000,
  memberModel: null,
};
export interface TeamRole {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  body: string;
  source: 'builtin' | 'user' | 'project';
  path?: string;
  revision: string;
  editable: boolean;
}
export interface TeamRoleInput {
  name: string;
  source: 'user' | 'project';
  text: string;
  revision?: string;
}
export interface TeamDispatchRequest {
  members: {
    name: string;
    role?: string;
    task: string;
    files?: string[];
    include_changes?: boolean;
  }[];
}
export type TeamMemberStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'budget_limited'
  | 'interrupted';
export interface TeamLink {
  leadId: string;
  dispatchId: string;
  toolCallId: string;
  name: string;
  role: string;
  roleSnapshot: TeamRole;
  task: string;
  /** Frozen ceiling, never relaxed by a preference change in the member page. */
  approvalMode: ApprovalMode;
  status: TeamMemberStatus;
}
export interface TeamMemberSnapshot {
  sessionId: string;
  name: string;
  role: string;
  writable: boolean;
  status: TeamMemberStatus;
  queueReason?: '等待空位' | '等待其他可写成员结束';
  task: string;
  action?: string;
  recent: { status: 'running' | 'done' | 'error'; tool: string; target: string }[];
  startedAt?: number;
  endedAt?: number;
  tokens: number;
  billedTokens: number;
  cost: number;
  added: number;
  removed: number;
  files: string[];
  error?: { kind: ModelErrorKind; message: string };
  warning?: string;
  report?: string;
  reportTruncated?: boolean;
}
export interface TeamSnapshot {
  version: 1;
  leadId: string;
  dispatchId: string;
  toolCallId: string;
  startedAt: number;
  endedAt?: number;
  cancelled?: boolean;
  members: TeamMemberSnapshot[];
}
export interface TeamResult extends TeamSnapshot {
  endedAt: number;
}
export const teamMemberActive = (status: TeamMemberStatus) =>
  ['queued', 'starting', 'running', 'waiting'].includes(status);
export const teamStatusLabels: Record<TeamMemberStatus, string> = {
  queued: '排队中',
  starting: '启动中',
  running: '运行中',
  waiting: '等待确认',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
  budget_limited: '达到上限',
  interrupted: '已中断',
};
const teamRoleLabels: Record<string, string> = {
  scout: '调研员',
  planner: '规划者',
  worker: '实现者',
  reviewer: '审查员',
};
/** Built-in roles keep their file names; the interface shows their Chinese names. */
export const teamRoleLabel = (role: string) => teamRoleLabels[role] ?? role;
const teamToolVerbs: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '修改',
  bash: '运行',
  powershell: '运行',
  grep: '搜索',
  find: '查找',
  ls: '列出',
};
/** One-line description of a tool call, e.g. "读取 src/app.ts". */
export function teamToolAction(tool: string, target: string) {
  const verb = teamToolVerbs[tool];
  return [verb ?? tool, target].filter(Boolean).join(' ');
}
const inlineMarkdown = (line: string) =>
  line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .trim();
/**
 * The first readable sentence of a Markdown report. Headings, rules, fences and
 * table rows are skipped so a report starting with "## 结论" shows its content.
 */
export function teamReportHeadline(report?: string) {
  if (!report) return undefined;
  let fence = false;
  let heading: string | undefined;
  for (const raw of report.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line || /^([-*_])(\s*\1){2,}$/.test(line) || line.startsWith('|')) continue;
    const title = /^#{1,6}\s+(.*)$/.exec(line);
    if (title) {
      heading ??= inlineMarkdown(title[1].replace(/\s+#+$/, ''));
      continue;
    }
    const text = inlineMarkdown(line.replace(/^>\s*/, '').replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''));
    if (text) return text.slice(0, 200);
  }
  return heading?.slice(0, 200) || undefined;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
export const validRoleName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
export function isTeamSettings(value: unknown): value is TeamSettings {
  return (
    object(value) &&
    integer(value.concurrency) &&
    value.concurrency >= 1 &&
    value.concurrency <= 6 &&
    (value.memberTokenBudget === null || (integer(value.memberTokenBudget) && value.memberTokenBudget > 0)) &&
    (value.memberModel === null ||
      (object(value.memberModel) && text(value.memberModel.provider, 200) && text(value.memberModel.id, 500)))
  );
}
export function isTeamRole(value: unknown): value is TeamRole {
  return (
    object(value) &&
    validRoleName(value.name) &&
    text(value.description, 2000) &&
    typeof value.body === 'string' &&
    value.body.length <= 64 * 1024 &&
    optional(
      value.tools,
      (tools) => Array.isArray(tools) && tools.length <= 100 && tools.every((t) => text(t, 100)),
    ) &&
    optional(value.model, (v) => text(v, 700)) &&
    optional(value.thinking, (v) =>
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(v)),
    ) &&
    ['builtin', 'user', 'project'].includes(String(value.source)) &&
    text(value.revision, 64) &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    optional(value.path, (v) => text(v, 4096)) &&
    typeof value.editable === 'boolean'
  );
}
export function isTeamLink(value: unknown): value is TeamLink {
  return (
    object(value) &&
    text(value.leadId, 100) &&
    text(value.dispatchId, 100) &&
    text(value.toolCallId, 200) &&
    text(value.name, 24) &&
    validRoleName(value.role) &&
    isTeamRole(value.roleSnapshot) &&
    value.role === value.roleSnapshot.name &&
    text(value.task, 8000) &&
    ['readonly', 'confirm', 'auto'].includes(String(value.approvalMode)) &&
    typeof value.status === 'string' &&
    Object.hasOwn(teamStatusLabels, value.status)
  );
}
export function validateDispatchRequest(value: unknown): asserts value is TeamDispatchRequest {
  if (!object(value) || !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 8)
    throw new Error('每次分派需要 1–8 个成员。');
  const names = new Set<string>();
  for (const member of value.members) {
    if (
      !object(member) ||
      !text(member.name, 24) ||
      !text(member.task, 8000) ||
      (member.role !== undefined && !validRoleName(member.role))
    )
      throw new Error('成员名需为 1–24 字，任务需为 1–8000 字，并使用有效的角色名。');
    if (names.has(member.name.trim())) throw new Error('同次分派的成员名不能重复。');
    names.add(member.name.trim());
    if (!optional(member.include_changes, (v) => typeof v === 'boolean'))
      throw new Error('变更摘要选项无效。');
    if (member.files !== undefined) {
      if (!Array.isArray(member.files) || member.files.length > 20)
        throw new Error('最多引用 20 个项目内文件。');
      for (const file of member.files) {
        if (!text(file, 4096)) throw new Error('引用文件路径无效。');
        const spec = parseAttachmentSpec(file);
        if (/^(?:[/\\~]|[A-Za-z]:)/.test(spec.path) || spec.path.split(/[/\\]/).includes('..'))
          throw new Error('成员只能引用项目内的相对路径。');
      }
    }
  }
}
export function stricterApprovalMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  const order: ApprovalMode[] = ['readonly', 'confirm', 'auto'];
  return order[Math.min(order.indexOf(a), order.indexOf(b))];
}
export function roleApprovalCeiling(role: Pick<TeamRole, 'tools'>): ApprovalMode {
  // An omitted tools list means Pi defaults, not a read-only role. An explicit empty list is safe.
  return role.tools?.every(isReadTool) ? 'readonly' : 'auto';
}
/** UTF-8 byte cap without cutting a code point; works in the bridge, main process and renderer. */
export function truncateTeamReport(value: string, limit = TEAM_REPORT_BYTES) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= limit) return { report: value, reportTruncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { report: new TextDecoder().decode(bytes.subarray(0, end)), reportTruncated: true };
}
export function isTeamSnapshot(value: unknown): value is TeamSnapshot {
  if (
    !object(value) ||
    value.version !== 1 ||
    !text(value.leadId, 100) ||
    !text(value.dispatchId, 100) ||
    !text(value.toolCallId, 200) ||
    !integer(value.startedAt) ||
    !optional(value.endedAt, integer) ||
    !optional(value.cancelled, (v) => typeof v === 'boolean') ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 8
  )
    return false;
  const ids = new Set<string>();
  return value.members.every((m) => {
    if (
      !object(m) ||
      !text(m.sessionId, 100) ||
      ids.has(m.sessionId) ||
      !text(m.name, 24) ||
      !validRoleName(m.role) ||
      typeof m.writable !== 'boolean' ||
      !text(m.task, 8000) ||
      typeof m.status !== 'string' ||
      !Object.hasOwn(teamStatusLabels, m.status) ||
      ![m.tokens, m.billedTokens, m.added, m.removed].every(integer) ||
      !number(m.cost) ||
      !optional(m.startedAt, integer) ||
      !optional(m.endedAt, integer) ||
      !optional(m.action, (v) => typeof v === 'string' && v.length <= 120) ||
      !optional(m.queueReason, (v) => v === '等待空位' || v === '等待其他可写成员结束') ||
      !Array.isArray(m.files) ||
      m.files.length > 1000 ||
      !m.files.every((v) => text(v, 4096)) ||
      !Array.isArray(m.recent) ||
      m.recent.length > 8 ||
      !m.recent.every(
        (r) =>
          object(r) &&
          ['running', 'done', 'error'].includes(String(r.status)) &&
          text(r.tool, 100) &&
          typeof r.target === 'string' &&
          r.target.length <= 120,
      ) ||
      !optional(
        m.report,
        (v) => typeof v === 'string' && new TextEncoder().encode(v).length <= TEAM_REPORT_BYTES,
      ) ||
      !optional(m.reportTruncated, (v) => typeof v === 'boolean') ||
      !optional(m.warning, (v) => text(v, 2000)) ||
      !optional(
        m.error,
        (v) =>
          object(v) &&
          ['auth', 'quota', 'busy', 'context', 'model', 'network', 'unknown'].includes(String(v.kind)) &&
          text(v.message, 2000),
      )
    )
      return false;
    ids.add(m.sessionId);
    return true;
  });
}
export function validateTeamResult(value: unknown): asserts value is TeamResult {
  if (
    !isTeamSnapshot(value) ||
    value.endedAt === undefined ||
    value.members.some((m) => teamMemberActive(m.status))
  )
    throw new Error('团队结果格式无效，已拒绝交给模型。');
}
export function formatTeamResult(result: TeamResult) {
  validateTeamResult(result);
  return [
    result.cancelled ? 'Team dispatch cancelled.' : 'Team dispatch finished.',
    ...result.members.map(
      (m) =>
        `### ${m.name} · ${m.role} · ${m.status}\nSession: ${m.sessionId}\nFiles: ${m.files.join(', ') || '(none)'}\nUsage: ${m.tokens} tokens (excluding cache hits)\n${m.error ? `Error (${m.error.kind}): ${m.error.message}\n` : ''}${m.warning ? m.warning + '\n' : ''}\n${m.report ?? ''}${m.reportTruncated ? '\n\n完整汇报见成员会话（汇报已截断）。' : ''}`,
    ),
  ].join('\n\n');
}
