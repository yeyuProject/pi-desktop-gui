// Tool approval policy shared by the Pi bridge (decides) and the desktop UI (renders).
export type ApprovalMode = 'auto' | 'confirm' | 'readonly';
export const APPROVAL_PREFIX = '__PI_DESKTOP_APPROVAL__';
export const APPROVAL_ALLOW = '允许一次';
export const APPROVAL_ALWAYS = '本会话总是允许';
export const APPROVAL_DENY = '拒绝';

export type WriteTarget = 'project' | 'outside' | 'sensitive';
export type ReadTarget = 'project' | 'outside';
export type ApprovalGrant =
  // Keep parsing old bridge responses, but never honor legacy prefix grants.
  | { id: string; kind: 'shell-prefix' | 'shell-exact'; toolName: string; command: string }
  | { id: string; kind: 'write-project' }
  | { id: string; kind: 'tool'; toolName: string };

export interface ApprovalRequest {
  toolName: string;
  kind: 'shell' | 'write' | 'read' | 'other';
  /** Command line, file path or short JSON summary shown to the user. */
  summary: string;
  /** Unified diff for edit, or new file content for write (truncated). */
  detail?: string;
  path?: string;
  writeTarget?: WriteTarget;
  readTarget?: ReadTarget;
  /** Prepared by the bridge after resolving the write target, never by the renderer. */
  grant?: ApprovalGrant;
}

export const isReadTool = (name: string) => ['read', 'grep', 'find', 'ls'].includes(name);
const shellTools = new Set(['bash', 'powershell']);

/** 'allow' runs the tool, 'ask' needs the user, 'deny' blocks it without asking. */
export function decide(
  mode: ApprovalMode,
  toolName: string,
  readTarget?: ReadTarget,
): 'allow' | 'ask' | 'deny' {
  // These bundled Goal tools only record completion/blocker evidence in the session.
  if (
    mode === 'auto' ||
    ['tool_search', 'desktop_goal_complete', 'desktop_goal_blocked'].includes(toolName) ||
    (isReadTool(toolName) && readTarget === 'project')
  )
    return 'allow';
  // External annotations are hints, not a trusted grant to run without approval.
  return mode === 'readonly' ? 'deny' : 'ask';
}

export function describe(toolName: string, input: any): ApprovalRequest {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…（已截断）' : s);
  if (shellTools.has(toolName)) return { toolName, kind: 'shell', summary: String(input?.command ?? '') };
  if (isReadTool(toolName))
    return {
      toolName,
      kind: 'read',
      path:
        typeof input?.path === 'string'
          ? input.path || (toolName === 'read' ? '' : '.')
          : input?.path === undefined && toolName !== 'read'
            ? '.'
            : '',
      summary: clip(JSON.stringify(input ?? {}), 2000),
    };
  if (toolName === 'edit') {
    const edits: { oldText?: string; newText?: string }[] = Array.isArray(input?.edits) ? input.edits : [];
    const detail = edits
      .map((e) =>
        [
          ...String(e.oldText ?? '')
            .split('\n')
            .map((l) => '-' + l),
          ...String(e.newText ?? '')
            .split('\n')
            .map((l) => '+' + l),
        ].join('\n'),
      )
      .join('\n@@\n');
    return {
      toolName,
      kind: 'write',
      summary: String(input?.path ?? ''),
      path: String(input?.path ?? ''),
      detail: clip(detail, 20000),
    };
  }
  if (toolName === 'write')
    return {
      toolName,
      kind: 'write',
      summary: String(input?.path ?? ''),
      path: String(input?.path ?? ''),
      detail: clip(
        String(input?.content ?? '')
          .split('\n')
          .map((l) => '+' + l)
          .join('\n'),
        20000,
      ),
    };
  return { toolName, kind: 'other', summary: clip(JSON.stringify(input ?? {}), 2000) };
}

/** Key for "always allow in this session": the exact command, or the tool name for other tools. */
export const alwaysKey = (r: ApprovalRequest) =>
  r.kind === 'shell' ? `${r.toolName}\u0000${r.summary}` : r.toolName;

export const sensitiveWritePath = (name: string) =>
  /(^|[\\/])(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519|[^/\\]+\.(?:pem|key|p12|pfx))$/i.test(
    name,
  );

export function grantForRequest(request: ApprovalRequest): ApprovalGrant | undefined {
  if (request.kind === 'read') return undefined;
  if (request.kind === 'write')
    return request.writeTarget === 'project' ? { id: 'write:project', kind: 'write-project' } : undefined;
  if (request.kind === 'shell') {
    // Arguments and repository configuration can turn a seemingly read-only command
    // into code execution or writes. Only the reviewed command text is reusable.
    const kind = 'shell-exact';
    const command = request.summary;
    return { id: `${kind}:${request.toolName}:${command}`, kind, toolName: request.toolName, command };
  }
  return { id: `tool:${request.toolName}`, kind: 'tool', toolName: request.toolName };
}

export function matchesGrant(grant: ApprovalGrant, request: ApprovalRequest): boolean {
  if (grant.kind === 'write-project') return request.kind === 'write' && request.writeTarget === 'project';
  if (grant.kind === 'tool') return request.kind === 'other' && request.toolName === grant.toolName;
  if (request.kind !== 'shell' || request.toolName !== grant.toolName) return false;
  return grant.kind === 'shell-exact' && request.summary === grant.command;
}

export function grantLabel(grant: ApprovalGrant): string {
  if (grant.kind === 'write-project') return '项目内修改：edit / write';
  if (grant.kind === 'tool') return `工具：${grant.toolName}`;
  return `${grant.kind === 'shell-prefix' ? '命令前缀' : '完整命令'}：${grant.command}`;
}

export function grantActionLabel(grant: ApprovalGrant): string {
  if (grant.kind === 'write-project') return '本会话允许修改项目内文件';
  if (grant.kind === 'tool') return `本会话总是允许 ${grant.toolName}`;
  return grant.kind === 'shell-prefix' ? `本会话允许 ${grant.command} 开头` : '本会话总是允许此完整命令';
}

export function isApprovalGrant(value: unknown): value is ApprovalGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as ApprovalGrant;
  if (typeof grant.id !== 'string' || !grant.id) return false;
  if (grant.kind === 'write-project') return grant.id === 'write:project';
  if (typeof grant.toolName !== 'string' || !grant.toolName) return false;
  if (grant.kind === 'tool') return true;
  return (grant.kind === 'shell-prefix' || grant.kind === 'shell-exact') && typeof grant.command === 'string';
}
