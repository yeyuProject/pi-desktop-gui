import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { Workspace } from './workspace';
import { attachmentPrompt, git } from './workspace';
import type { AgentService } from './agent';
import { agentDirectory } from './environment';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import { listTeamRoles, type TeamRoleContext } from './team-roles';
import { busy, messageText, type Model, type Runtime, type Session } from '../shared/types';
import { describeModelError, describeOperationError } from '../shared/errors';
import {
  roleApprovalCeiling,
  stricterApprovalMode,
  truncateTeamReport,
  validateDispatchRequest,
  type TeamResult,
  type TeamRole,
  type TeamSnapshot,
  type TeamMemberSnapshot,
} from '../shared/team';

interface MemberRun {
  snapshot: TeamMemberSnapshot;
  session: Session;
  root: string;
  prompt: string;
  files: string[];
  launched: boolean;
  settled: boolean;
  finalizing?: Promise<void>;
  stop?: 'stopped' | 'interrupted';
  stopping?: Promise<void>;
  budgetLimited: boolean;
  changes?: Promise<void>;
  changesAt?: number;
  changesKey?: string;
  changesReady?: boolean;
}
interface Dispatch {
  snapshot: TeamSnapshot;
  members: MemberRun[];
  resolve: (result: TeamResult) => void;
  remaining?: number;
  ending: boolean;
}
interface TeamHost {
  get: (id: string) => AgentService;
  publish: (leadId: string, snapshots: TeamSnapshot[]) => void;
  changed: () => void;
}
/** All process ownership stays in SessionAgents/AgentService. This only schedules managed sessions. */
export class TeamService {
  private dispatches = new Map<string, Dispatch>();
  private runs = new Map<string, MemberRun>();
  private closing = false;
  private pumping = false;
  private dirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(
    private store: Store,
    private workspace: Workspace,
    private host: TeamHost,
  ) {}
  get active() {
    return this.dispatches.size > 0;
  }
  owns(id: string) {
    return this.runs.has(id);
  }
  assertMayConnect(id: string) {
    const run = this.runs.get(id);
    if (run && !run.launched) throw new Error('成员仍在排队，请等待调度启动。');
  }
  assertMaySend(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    if (!run.launched) throw new Error('成员仍在排队，请等待调度启动。');
    if (run.finalizing || run.settled)
      throw new Error('本次分派尚未收尾，请等负责人收到汇报后再开始新任务。');
  }
  hasLead(id: string) {
    return [...this.dispatches.values()].some((d) => d.snapshot.leadId === id);
  }
  roleContext(id: string): TeamRoleContext {
    const session = this.store.session(id);
    const project = session.projectId ? this.store.project(session.projectId) : undefined;
    return {
      agentDir: agentDirectory(this.store.state.settings),
      cwd: project?.path,
      trusted: project?.trusted ?? false,
    };
  }
  async roles(id: string) {
    const session = this.store.session(id);
    const project = session.projectId ? this.store.project(session.projectId) : undefined;
    return (await listTeamRoles(this.roleContext(id))).map((role) => ({
      ...role,
      writable: roleApprovalCeiling(role) !== 'readonly',
      needsApproval: role.source === 'project' && project?.teamRoleApprovals?.[role.name] !== role.revision,
    }));
  }
  async setEnabled(id: string, enabled: boolean) {
    this.store.assertWritable();
    const session = this.store.promoteSession(id);
    if (typeof enabled !== 'boolean' || session.team) throw new Error('成员不能开启团队。');
    if (enabled && !session.teamHintSeen) {
      const agent = this.host.get(id);
      agent.runtime.notices = [
        ...agent.runtime.notices,
        '开启后 Pi 可以把子任务交给成员并行处理，用量随成员数量增加。',
      ];
      session.teamHintSeen = true;
      agent.publish(true);
    }
    session.teamEnabled = enabled;
    await this.store.save();
    this.host.changed();
  }
  async handle(id: string, value: unknown, valid: () => boolean): Promise<unknown> {
    if (!value || typeof value !== 'object') throw new Error('团队请求无效。');
    const p = value as Record<string, unknown>;
    if (!valid() || this.closing) throw new Error('团队请求已取消。');
    if (this.store.session(id).team) throw new Error('成员不能再次分派。');
    if (p.action === 'enabled') {
      if (typeof p.enabled !== 'boolean') throw new Error('团队开关无效。');
      await this.setEnabled(id, p.enabled);
      return {};
    }
    if (p.action === 'roles') return this.roles(id);
    if (p.action === 'info') {
      const roles = await this.roles(id);
      const members = this.store.state.sessions.filter((s) => s.team?.leadId === id);
      return `团队${this.store.session(id).teamEnabled ? '已开启' : '已关闭'} · 并行上限 ${this.store.state.settings.team.concurrency}\n${roles.map((r) => `${r.name}：${r.description}`).join('\n')}\n成员：${members.map((s) => s.team!.name).join('、') || '暂无'}`;
    }
    if (p.action !== 'dispatch') throw new Error('团队操作无效。');
    return this.dispatch(id, p, valid);
  }
  private async dispatch(id: string, p: Record<string, unknown>, valid: () => boolean) {
    this.store.assertWritable();
    const lead = this.store.session(id);
    if (!lead.teamEnabled || lead.team) throw new Error('请由用户先开启团队。');
    if (this.hasLead(id)) throw new Error('请先等待当前分派结束。');
    validateDispatchRequest(p.request);
    if (typeof p.toolCallId !== 'string' || !p.toolCallId || p.toolCallId.length > 200)
      throw new Error('分派工具标识无效。');
    const leadRuntime = this.host.get(id).runtime;
    const available = await this.roles(id);
    const chosen: TeamRole[] = [];
    const approved =
      p.approvedRoles && typeof p.approvedRoles === 'object'
        ? (p.approvedRoles as Record<string, unknown>)
        : {};
    for (const item of p.request.members) {
      const role = available.find((r) => r.name === (item.role ?? 'worker'));
      if (!role) throw new Error(`角色不存在，可用角色：${available.map((r) => r.name).join('、')}`);
      if ((lead.approvalMode ?? 'auto') === 'readonly' && role.writable)
        throw new Error(
          `只读负责人只能分派只读角色：${available
            .filter((r) => !r.writable)
            .map((r) => r.name)
            .join('、')}`,
        );
      if (role.needsApproval && approved[role.name] !== role.revision)
        throw new Error('项目角色已变化或尚未确认，请重新分派。');
      chosen.push(structuredClone(role));
    }
    const cwd = await this.store.sessionDirectory(id);
    const root = await canonicalWritePath(cwd);
    const project = lead.projectId ? this.store.project(lead.projectId) : undefined;
    const prompts: string[] = [];
    for (let index = 0; index < p.request.members.length; index++) {
      const item = p.request.members[index];
      if (item.files?.length) {
        if (!project) throw new Error('引用文件需要项目会话。');
        // Validate real paths, sensitive files and aggregate attachment size before creating any session.
        await attachmentPrompt(project, item.task, item.files);
      }
      let prompt = `负责人分派任务（${item.name}）：\n${item.task}`;
      if (project && (item.include_changes ?? chosen[index].name === 'reviewer')) {
        const summary = await git(project, ['diff', '--stat', 'HEAD', '--'], 128 * 1024).catch(() => '');
        prompt +=
          '\n\n当前未提交变更摘要（仅供参考，请核对实际文件）：\n' +
          truncateTeamReport(summary, 64 * 1024).report;
      }
      prompts.push(prompt);
    }
    if (!valid() || this.closing) throw new Error('分派已取消。');
    // Role and material reads await I/O. Another invocation may have reserved this
    // leader meanwhile; recheck before the synchronous member creation section.
    if (
      this.hasLead(id) ||
      this.store.state.sessions.some((s) => s.team?.leadId === id && s.team.status === 'queued')
    )
      throw new Error('请先等待当前分派结束。');
    const dispatchId = randomUUID();
    const snapshot: TeamSnapshot = {
      version: 1,
      dispatchId,
      leadId: id,
      toolCallId: p.toolCallId,
      startedAt: Date.now(),
      members: [],
    };
    const selected = {
      sessionId: this.store.state.selectedSessionId,
      projectId: this.store.state.selectedProjectId,
    };
    const members: MemberRun[] = [];
    for (let index = 0; index < p.request.members.length; index++) {
      const task = p.request.members[index];
      const role = chosen[index];
      const session = this.store.createSession(lead.projectId);
      const mode = stricterApprovalMode(lead.approvalMode ?? 'auto', roleApprovalCeiling(role));
      session.title = `${task.name.trim()} · ${role.name}`;
      session.cwd = cwd;
      session.approvalMode = mode;
      session.team = {
        leadId: id,
        dispatchId,
        toolCallId: p.toolCallId,
        name: task.name.trim(),
        role: role.name,
        roleSnapshot: role,
        task: task.task,
        approvalMode: mode,
        status: 'queued',
      };
      const wanted =
        role.model ??
        (this.store.state.settings.team.memberModel
          ? `${this.store.state.settings.team.memberModel.provider}/${this.store.state.settings.team.memberModel.id}`
          : undefined);
      const model = wanted
        ? leadRuntime.models.find((m: Model) => `${m.provider}/${m.id}` === wanted || m.id === wanted)
        : undefined;
      session.model = model
        ? { provider: model.provider, id: model.id }
        : leadRuntime.model
          ? { provider: leadRuntime.model.provider, id: leadRuntime.model.id }
          : lead.model;
      session.thinking = role.thinking ?? leadRuntime.thinking ?? lead.thinking;
      const member: TeamMemberSnapshot = {
        sessionId: session.id,
        name: task.name.trim(),
        role: role.name,
        writable: mode !== 'readonly',
        status: 'queued',
        queueReason: '等待空位',
        task: task.task,
        recent: [],
        tokens: 0,
        billedTokens: 0,
        cost: 0,
        added: 0,
        removed: 0,
        files: [],
        ...(wanted && !model
          ? { warning: `角色指定的模型不可用，已改用 ${session.model?.id ?? '负责人模型'}` }
          : {}),
      };
      snapshot.members.push(member);
      members.push({
        snapshot: member,
        session,
        root,
        prompt: prompts[index],
        files: task.files ?? [],
        launched: false,
        settled: false,
        budgetLimited: false,
      });
    }
    this.store.state.selectedSessionId = selected.sessionId;
    this.store.state.selectedProjectId = selected.projectId;
    if (project)
      for (const role of chosen)
        if (role.source === 'project') (project.teamRoleApprovals ??= {})[role.name] = role.revision;
    try {
      await this.store.save();
    } catch (error) {
      // A backup can fail after state.json committed. Keep recoverable member records,
      // but never launch an unpersisted dispatch or leave phantom queued members.
      for (const run of members) run.session.team!.status = 'interrupted';
      this.host.changed();
      throw error;
    }
    this.host.changed();
    if (!valid() || this.closing) {
      for (const run of members) {
        run.snapshot.status = 'interrupted';
        run.session.team!.status = 'interrupted';
      }
      await this.store.save();
      return { ...snapshot, endedAt: Date.now(), cancelled: true };
    }
    return new Promise<TeamResult>((resolve) => {
      const remaining =
        typeof p.goalRemaining === 'number' && Number.isSafeInteger(p.goalRemaining) && p.goalRemaining >= 0
          ? p.goalRemaining
          : undefined;
      this.dispatches.set(dispatchId, { snapshot, members, resolve, remaining, ending: false });
      for (const run of members) {
        this.runs.set(run.session.id, run);
        this.workspace.linkTeamMember(run.session.id, id);
      }
      this.publish(id);
      this.pump();
    });
  }
  private publish(id: string) {
    this.dirty.add(id);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const leadId of this.dirty)
        this.host.publish(
          leadId,
          structuredClone(
            [...this.dispatches.values()].filter((d) => d.snapshot.leadId === leadId).map((d) => d.snapshot),
          ),
        );
      this.dirty.clear();
    }, 1000);
    this.timer.unref();
  }
  settingsChanged() {
    this.pump();
    for (const dispatch of this.dispatches.values()) this.publish(dispatch.snapshot.leadId);
  }
  private pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (const dispatch of this.dispatches.values())
        for (const run of dispatch.members) {
          if (run.launched || run.settled || run.finalizing || run.stop) continue;
          if (dispatch.remaining === 0) {
            run.budgetLimited = true;
            run.snapshot.status = 'budget_limited';
            void this.finish(run).catch(() => {});
            continue;
          }
          const active = [...this.runs.values()].filter((r) => r.launched && !r.settled);
          const conflict =
            run.snapshot.writable &&
            active.some(
              (r) =>
                r.snapshot.writable &&
                (isWithinDirectory(run.root, r.root) || isWithinDirectory(r.root, run.root)),
            );
          run.snapshot.queueReason = conflict ? '等待其他可写成员结束' : '等待空位';
          if (conflict || active.length >= this.store.state.settings.team.concurrency) continue;
          run.launched = true;
          run.snapshot.startedAt = Date.now();
          run.snapshot.status = 'starting';
          delete run.snapshot.queueReason;
          run.session.team!.status = 'starting';
          void this.start(run).catch((error) => this.finishFailure(run, error));
        }
    } finally {
      this.pumping = false;
    }
  }
  private async start(run: MemberRun) {
    const agent = this.host.get(run.session.id);
    await agent.send(run.session.id, run.prompt, run.files, 'steer');
    this.observe(run.session.id, agent.runtime);
    if (run.stop) await this.stopMember(run.session.id, run.stop);
  }
  private finishFailure(run: MemberRun, error: unknown) {
    if (run.settled) return;
    run.snapshot.error = { kind: 'unknown', message: describeOperationError(error) };
    run.snapshot.status = run.stop ?? 'failed';
    void this.finish(run).catch(() => {});
  }
  observe(id: string, runtime: Runtime) {
    const run = this.runs.get(id);
    if (!run || !run.launched || run.settled || run.finalizing) return;
    const member = run.snapshot;
    if (!run.changesReady) {
      member.added = 0;
      member.removed = 0;
      const files = new Set<string>();
      for (const tool of runtime.tools) {
        if (
          ['edit', 'write'].includes(tool.name) &&
          typeof tool.args.path === 'string' &&
          tool.status === 'done'
        )
          files.add(tool.args.path);
        for (const line of tool.patch?.split('\n') ?? []) {
          if (line.startsWith('+') && !line.startsWith('+++')) member.added++;
          if (line.startsWith('-') && !line.startsWith('---')) member.removed++;
        }
      }
      member.files = [...files].slice(0, 1000);
    }
    const writes = runtime.tools.filter(
      (tool) => ['edit', 'write', 'bash', 'powershell'].includes(tool.name) && tool.status !== 'running',
    );
    const changesKey = `${writes.length}:${writes.at(-1)?.id ?? ''}`;
    if (
      writes.length &&
      changesKey !== run.changesKey &&
      !run.changes &&
      Date.now() - (run.changesAt ?? 0) >= 1000
    ) {
      run.changesKey = changesKey;
      void this.refreshChanges(run);
    }
    member.recent = runtime.tools.slice(-8).map((tool) => ({
      status: tool.status,
      tool: tool.name,
      target: String(tool.args.path ?? tool.args.command ?? tool.args.pattern ?? '').slice(0, 120),
    }));
    const plan = runtime.plan?.steps.find((step) => step.status === 'in_progress');
    const tool = runtime.tools.at(-1);
    member.action = (
      runtime.dialogs[0]?.approval?.summary ??
      plan?.text ??
      (tool?.status === 'running'
        ? `${tool.name} ${String(tool.args.path ?? tool.args.command ?? tool.args.pattern ?? '')}`
        : '正在撰写汇报')
    ).slice(0, 120);
    if (busy(runtime.status))
      member.status =
        runtime.status === 'waiting' ? 'waiting' : runtime.status === 'starting' ? 'starting' : 'running';
    else if (['completed', 'stopped', 'error', 'interrupted'].includes(runtime.status)) {
      member.status =
        run.stop ??
        (run.budgetLimited
          ? 'budget_limited'
          : runtime.status === 'completed'
            ? 'completed'
            : runtime.status === 'stopped'
              ? 'stopped'
              : 'failed');
      if (member.status === 'failed')
        member.error = {
          kind: runtime.errorKind ?? 'unknown',
          message: runtime.errorKind
            ? describeModelError(runtime.errorKind).title
            : describeOperationError(runtime.error ?? '成员运行失败，请打开成员查看详情。'),
        };
      const last = runtime.messages.findLast((m) => m.role === 'assistant');
      Object.assign(member, truncateTeamReport(last ? messageText(last) : ''));
      void this.finish(run).catch(() => {});
    }
    run.session.team!.status = member.status;
    this.publish(run.session.team!.leadId);
  }
  usage(id: string, value: { tokens: number; billedTokens: number; cost: number; budgetLimited: boolean }) {
    const run = this.runs.get(id);
    if (
      !run ||
      run.settled ||
      ![value.tokens, value.billedTokens].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isFinite(value.cost) ||
      value.cost < 0 ||
      typeof value.budgetLimited !== 'boolean' ||
      value.tokens < run.snapshot.tokens ||
      value.billedTokens < run.snapshot.billedTokens ||
      value.cost < run.snapshot.cost
    )
      return;
    Object.assign(run.snapshot, { tokens: value.tokens, billedTokens: value.billedTokens, cost: value.cost });
    run.budgetLimited ||= value.budgetLimited;
    const dispatch = this.dispatches.get(run.session.team!.dispatchId)!;
    if (
      dispatch.remaining !== undefined &&
      dispatch.members.reduce((sum, r) => sum + r.snapshot.tokens, 0) >= dispatch.remaining
    ) {
      for (const other of dispatch.members) {
        if (other.settled || other.budgetLimited) continue;
        other.budgetLimited = true;
        if (other.launched)
          void this.host
            .get(other.session.id)
            .teamWindDown()
            .catch(() => this.stopMember(other.session.id))
            .catch((error) => this.host.get(other.session.id).logTeamError(error));
        else {
          other.snapshot.status = 'budget_limited';
          void this.finish(other).catch(() => {});
        }
      }
    }
    this.publish(dispatch.snapshot.leadId);
  }
  /** Net, attributed changes include shell writes and exclude unrelated manual edits. */
  private refreshChanges(run: MemberRun): Promise<void> {
    if (run.changes) return run.changes;
    if (!run.snapshot.writable || !run.session.projectId) return Promise.resolve();
    run.changesAt = Date.now();
    run.changes = (async () => {
      const project = this.store.project(run.session.projectId!);
      const checkpoint = (await this.workspace.listCheckpoints(project, run.session.id)).at(-1);
      if (!checkpoint?.available) return;
      const preview = await this.workspace.checkpointPreview(project, run.session.id, checkpoint.id);
      const files = preview.files.filter((file) => !file.manual).slice(0, 1000);
      let added = 0,
        removed = 0;
      for (const file of files) {
        const diff = await this.workspace.diff(project, file.path, 'run', {
          sessionId: run.session.id,
          checkpointId: checkpoint.id,
        });
        for (const line of diff.patch.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) added++;
          if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }
      }
      Object.assign(run.snapshot, { added, removed, files: files.map((file) => file.path) });
      run.changesReady = true;
      this.publish(run.session.team!.leadId);
    })()
      .catch((error) => {
        this.host.get(run.session.id).logTeamError(error);
      })
      .finally(() => {
        run.changes = undefined;
      });
    return run.changes;
  }
  private finish(run: MemberRun): Promise<void> {
    if (run.finalizing) return run.finalizing;
    if (run.settled) return Promise.resolve();
    run.finalizing = (async () => {
      if (run.launched) {
        await this.host.get(run.session.id).waitTeamIdle();
        await run.changes;
        await this.refreshChanges(run);
      }
      // Never release a writer slot until process and checkpoint cleanup are confirmed.
      run.snapshot.endedAt = Date.now();
      run.session.team!.status = run.snapshot.status;
      const dispatch = this.dispatches.get(run.session.team!.dispatchId)!;
      await this.store.save().catch((error) => {
        // Store reports the storage failure globally. Do not strand an otherwise
        // safely stopped dispatch: the original queued index restores as interrupted.
        run.snapshot.warning = describeOperationError(error);
      });
      run.settled = true;
      this.publish(dispatch.snapshot.leadId);
      this.host.changed();
      if (dispatch.members.every((r) => r.settled)) this.complete(dispatch);
      this.pump();
    })().catch((error) => {
      run.finalizing = undefined;
      run.snapshot.error = { kind: 'unknown', message: describeOperationError(error) };
      this.host.get(run.session.id).logTeamError(error);
      this.publish(run.session.team!.leadId);
      throw error;
    });
    return run.finalizing;
  }
  private complete(dispatch: Dispatch) {
    if (dispatch.ending) return;
    dispatch.ending = true;
    const result: TeamResult = { ...dispatch.snapshot, endedAt: Date.now() };
    this.dispatches.delete(result.dispatchId);
    for (const run of dispatch.members) {
      this.runs.delete(run.session.id);
      this.workspace.linkTeamMember(run.session.id);
    }
    this.publish(result.leadId);
    dispatch.resolve(structuredClone(result));
  }
  async stopMember(id: string, status: 'stopped' | 'interrupted' = 'stopped', force = false) {
    const run = this.runs.get(id);
    if (!run) return;
    if (run.settled) return run.finalizing;
    run.stop = status;
    if (run.stopping && !force) return run.stopping;
    if (!run.launched) {
      run.snapshot.status = status;
      return this.finish(run);
    }
    run.stopping = (async () => {
      const agent = this.host.get(id);
      if (force) await agent.forceStop();
      else await agent.stop();
      agent.assertCommandsStopped();
      run.snapshot.status = status;
      const last = agent.runtime.messages.findLast((m) => m.role === 'assistant');
      Object.assign(run.snapshot, truncateTeamReport(last ? messageText(last) : ''));
      await this.finish(run);
    })().finally(() => {
      run.stopping = undefined;
    });
    return run.stopping;
  }
  async cancelDispatch(id: string, toolCallId: unknown) {
    if (
      typeof toolCallId !== 'string' ||
      ![...this.dispatches.values()].some(
        (d) => d.snapshot.leadId === id && d.snapshot.toolCallId === toolCallId,
      )
    )
      return;
    await this.stopLead(id);
  }
  async stopLead(id: string, cancelled = true, interrupted = false, force = false) {
    const dispatches = [...this.dispatches.values()].filter((d) => d.snapshot.leadId === id);
    for (const d of dispatches) {
      if (cancelled) d.snapshot.cancelled = true;
      // Reserve every queued cancellation before a stopping member can release a scheduler slot.
      for (const run of d.members) run.stop = interrupted ? 'interrupted' : 'stopped';
    }
    await Promise.all(
      dispatches.flatMap((d) =>
        d.members.map((run) =>
          this.stopMember(run.session.id, interrupted ? 'interrupted' : 'stopped', force),
        ),
      ),
    );
  }
  async dispose() {
    this.closing = true;
    await Promise.all(
      [...new Set([...this.dispatches.values()].map((d) => d.snapshot.leadId))].map((id) =>
        this.stopLead(id, true, true),
      ),
    );
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty.clear();
  }
}
