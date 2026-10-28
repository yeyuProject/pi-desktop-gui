import { EventEmitter } from 'node:events';
import { AgentService } from './agent';
import type { Store } from './store';
import type { Workspace } from './workspace';
import { emptyRuntime, type Runtime, type RuntimePatch } from '../shared/types';
import { samePath } from './platform';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import { agentDirectory } from './environment';

/** Each connected conversation owns its process, queue and operation ordering. */
export class SessionAgents extends EventEmitter {
  private agents = new Map<string, AgentService>();
  private empty = emptyRuntime();
  private closing = false;
  private workspaceOperations = new Map<symbol, { root: string; write: boolean; finished: Promise<void> }>();
  private resourceMaintenance?: { directory: string; cwd?: string };
  private terminalHandoffs = new Set<string>();
  private reloadSuspended = false;
  private touched = new Map<string, { at: number; version: number }>();
  private collecting = false;
  private releasing = new Set<string>();
  private readonly idleTimer: NodeJS.Timeout;

  constructor(
    private store: Store,
    private workspace: Workspace,
    private developmentRoot?: string,
    private bridgeSource?: string,
    private terminalOpen?: (id: string) => Promise<boolean>,
    private idleMs = 5 * 60 * 1000,
  ) {
    super();
    this.idleTimer = setInterval(() => {
      void this.collectIdle().catch(() => {});
    }, 60_000);
    this.idleTimer.unref();
  }

  get(id: string): AgentService {
    if (this.closing) throw new Error('应用正在关闭，请稍后重新打开');
    this.store.session(id);
    this.touched.set(id, { at: Date.now(), version: (this.touched.get(id)?.version ?? 0) + 1 });
    const existing = this.agents.get(id);
    if (existing) return existing;
    const agent = new AgentService(
      this.store,
      this.workspace,
      this.developmentRoot,
      this.bridgeSource,
      async (operation, target) => {
        if (await this.inTerminal(id))
          throw new Error('此会话已交给 Pi 终端，请关闭该终端后重新连接；其他会话仍可使用');
        await this.assertResourcesAvailable(id);
        if (operation !== 'read') {
          const root = await canonicalWritePath(target ?? (await this.store.sessionDirectory(id)));
          if (
            [...this.workspaceOperations.values()].some(
              (item) =>
                item.write && (isWithinDirectory(root, item.root) || isWithinDirectory(item.root, root)),
            )
          )
            throw new Error('此目录正在撤销或修改文件，请完成后重试；仍可查看已保存的历史');
        }
      },
    );
    agent.suspendReload(this.reloadSuspended);
    this.agents.set(id, agent);
    agent.on('runtimePatch', (patch: RuntimePatch) => {
      if (agent.hasPendingWork) {
        const touched = this.touched.get(id);
        if (touched) touched.at = Date.now();
      }
      this.emit('runtimePatch', patch);
      this.emit('attention', agent.runtime);
    });
    agent.on('state', (state) => {
      this.emit('state', state);
    });
    return agent;
  }

  get runtime(): Runtime {
    return this.agents.get(this.store.state.selectedSessionId ?? '')?.runtime ?? this.empty;
  }
  get disposed() {
    return this.closing;
  }

  get hasPendingWork() {
    return (
      this.workspaceOperations.size > 0 || [...this.agents.values()].some((agent) => agent.hasPendingWork)
    );
  }
  get requiresStopConfirmation() {
    return [...this.agents.values()].some((agent) => agent.requiresStopConfirmation);
  }
  diagnostics() {
    return [...this.agents.values()].map((agent) => agent.diagnostics());
  }

  setThinking(id: string, level: string) {
    return this.get(id).setThinking(id, level);
  }

  active(id: string) {
    return this.agents.get(id)?.hasPendingWork ?? false;
  }

  connected(id: string) {
    const agent = this.agents.get(id);
    return Boolean(agent && (agent.runtime.connected || agent.hasPendingWork));
  }
  async inTerminal(id: string) {
    return this.terminalHandoffs.has(id) || (await this.terminalOpen?.(id)) || false;
  }
  async handoffToTerminal<T>(id: string, action: () => Promise<T>) {
    if (await this.inTerminal(id)) throw new Error('此会话已交给 Pi 终端，或正在交接，请关闭相关终端后重试');
    if (this.terminalHandoffs.has(id)) throw new Error('此会话正在交给 Pi 终端，请稍候');
    this.terminalHandoffs.add(id);
    try {
      await this.assertResourcesAvailable(id);
      await this.get(id).disconnect();
      return await action();
    } finally {
      this.terminalHandoffs.delete(id);
    }
  }
  async assertResourcesAvailable(id: string) {
    const maintenance = this.resourceMaintenance;
    if (!maintenance) return;
    const session = this.store.session(id);
    const cwd =
      this.agents.get(id)?.runtime.cwd ??
      (session.projectId ? this.store.project(session.projectId).path : session.cwd);
    const directory =
      this.agents.get(id)?.configurationDirectory ?? agentDirectory(this.store.state.settings);
    if (
      maintenance.cwd
        ? cwd && samePath(await canonicalWritePath(cwd), maintenance.cwd)
        : samePath(await canonicalWritePath(directory), maintenance.directory)
    )
      throw new Error('相关资源包正在安装、更新或移除，请完成后再启动任务；其他目录仍可使用');
  }
  async updatePackages<T>(id: string, local: boolean, action: () => Promise<T>) {
    const directory = await canonicalWritePath(agentDirectory(this.store.state.settings));
    const cwd = local ? await canonicalWritePath(await this.store.sessionDirectory(id)) : undefined;
    this.resourceMaintenance = { directory, cwd };
    try {
      for (const session of this.store.state.sessions) {
        if (!(await this.inTerminal(session.id))) continue;
        const target = local
          ? await canonicalWritePath(await this.store.sessionDirectory(session.id))
          : await canonicalWritePath(
              this.agents.get(session.id)?.configurationDirectory ??
                agentDirectory(this.store.state.settings),
            );
        if (samePath(target, cwd ?? directory))
          throw new Error(`会话“${session.title}”的 Pi 终端仍在使用相关资源，请关闭该终端后管理资源包`);
      }
      const candidates = await Promise.all(
        [...this.agents.values()].map(async (agent) => ({
          agent,
          matches: cwd
            ? agent.runtime.cwd && samePath(await canonicalWritePath(agent.runtime.cwd), cwd)
            : samePath(await canonicalWritePath(agent.configurationDirectory), directory),
        })),
      );
      const affected = candidates.filter((item) => item.matches).map((item) => item.agent);
      for (const agent of affected) {
        agent.assertCommandsStopped();
        if (agent.hasPendingWork)
          throw new Error(
            '相关会话仍在使用这个资源包，请停止相关任务后安装、更新或移除；配置文件仍可编辑保存',
          );
      }
      await Promise.all(affected.map((agent) => agent.disconnect()));
      return await action();
    } finally {
      this.resourceMaintenance = undefined;
    }
  }

  projectBusy(projectId: string) {
    return this.store.state.sessions.some(
      (session) => session.projectId === projectId && this.active(session.id),
    );
  }
  async inWorkspace<T>(root: string, write: boolean, action: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('应用正在关闭，请稍后重新打开');
    const real = await canonicalWritePath(root);
    const overlaps = (other: string) => isWithinDirectory(real, other) || isWithinDirectory(other, real);
    if (
      [...this.workspaceOperations.values()].some(
        (operation) => overlaps(operation.root) && (write || operation.write),
      )
    )
      throw new Error('这个目录正在执行相关操作，请稍后重试；其他项目仍可使用');
    const token = Symbol();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Reserve before any further await, so a new send cannot slip between an idle check and an undo.
    this.workspaceOperations.set(token, { root: real, write, finished });
    try {
      if (write) {
        for (const [id, agent] of this.agents) {
          const cwd = agent.runtime.cwd ?? (await this.store.sessionDirectory(id));
          const targets = await Promise.all(
            [cwd, ...agent.writingPaths].map((target) => canonicalWritePath(target)),
          );
          if (!targets.some(overlaps)) continue;
          agent.assertCommandsStopped();
          if (agent.workspaceInUse)
            throw new Error(`会话“${this.store.session(id).title}”正在使用这个目录，请停止相关任务后执行`);
        }
      }
      return await action();
    } finally {
      this.workspaceOperations.delete(token);
      finish();
    }
  }
  async reloadConfiguration(id: string, local: boolean) {
    const cwd = local ? await canonicalWritePath(await this.store.sessionDirectory(id)) : undefined;
    const directory = await canonicalWritePath(agentDirectory(this.store.state.settings));
    const candidates = await Promise.all(
      [...this.agents.entries()].map(async ([sessionId, agent]) => ({
        sessionId,
        agent,
        matches: local
          ? samePath(
              await canonicalWritePath(agent.runtime.cwd ?? (await this.store.sessionDirectory(sessionId))),
              cwd!,
            )
          : samePath(await canonicalWritePath(agent.configurationDirectory), directory),
      })),
    );
    const affected = candidates
      .filter((item) => item.matches)
      .map(({ sessionId, agent }) => [sessionId, agent] as const);
    for (const [, agent] of affected) agent.invalidateModels();
    const loaded = affected.filter(([, agent]) => agent.runtime.connected || agent.hasPendingWork);
    if (!loaded.length) return { applied: false, deferred: true };
    const results = await Promise.allSettled(loaded.map(([, agent]) => agent.scheduleReload()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
      return { applied: false, warning: String(failure.reason?.message ?? failure.reason) };
    let deferred = results.some((result) => result.status === 'fulfilled' && !result.value);
    for (const session of this.store.state.sessions) {
      if (!(await this.inTerminal(session.id))) continue;
      const target = local
        ? await canonicalWritePath(await this.store.sessionDirectory(session.id))
        : await canonicalWritePath(
            this.agents.get(session.id)?.configurationDirectory ?? agentDirectory(this.store.state.settings),
          );
      if (samePath(target, cwd ?? directory)) deferred = true;
    }
    return { applied: !deferred, ...(deferred ? { deferred: true } : {}) };
  }

  invalidateModels() {
    for (const agent of this.agents.values()) agent.invalidateModels();
  }

  resync() {
    for (const agent of this.agents.values()) {
      agent.resync();
      agent.publish(true);
    }
  }

  assertCommandsStopped() {
    for (const agent of this.agents.values()) agent.assertCommandsStopped();
  }

  async release(id: string) {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.hasPendingWork) throw new Error('请先等待这个会话的操作结束或停止任务');
    this.releasing.add(id);
    try {
      await agent.disconnect();
      await agent.dispose();
      if (this.agents.get(id) !== agent) return;
      this.agents.delete(id);
      this.touched.delete(id);
      this.emit('runtimeRemoved', id);
    } finally {
      this.releasing.delete(id);
    }
  }
  async collectIdle(now = Date.now()) {
    if (this.closing || this.collecting || this.resourceMaintenance || this.workspaceOperations.size) return;
    this.collecting = true;
    try {
      for (const [id, agent] of this.agents) {
        const touched = this.touched.get(id);
        if (!touched || this.releasing.has(id)) continue;
        if (
          id === this.store.state.selectedSessionId ||
          agent.hasPendingWork ||
          this.terminalHandoffs.has(id)
        ) {
          touched.at = now;
          continue;
        }
        if (now - touched.at < this.idleMs) continue;
        const version = touched.version;
        if (!(await agent.releaseIdleProcess())) continue;
        if (
          this.closing ||
          this.releasing.has(id) ||
          this.agents.get(id) !== agent ||
          id === this.store.state.selectedSessionId ||
          agent.hasPendingWork ||
          this.touched.get(id)?.version !== version
        )
          continue;
        // No await between the final ownership check and detaching the idle instance.
        this.agents.delete(id);
        this.touched.delete(id);
        agent.removeAllListeners();
        this.emit('runtimeRemoved', id);
        await agent.dispose();
      }
    } finally {
      this.collecting = false;
    }
  }

  async disconnect() {
    if (this.hasPendingWork) throw new Error('请先等待所有会话的任务和操作结束');
    await Promise.all([...this.agents.values()].map((agent) => agent.disconnect()));
  }

  async stop() {
    const results = await Promise.allSettled(
      [...this.agents.values()].map(async (agent) => {
        await agent.stopSideChat();
        await agent.stop();
        agent.assertCommandsStopped();
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  suspendReload(value: boolean) {
    this.reloadSuspended = value;
    for (const agent of this.agents.values()) agent.suspendReload(value);
  }

  async dispose() {
    this.closing = true;
    clearInterval(this.idleTimer);
    // Start cancellation first. A workspace operation may be waiting for a Pi
    // reader/dialog which only AgentService.dispose can close.
    const disposing = [...this.agents.values()].map((agent) => agent.dispose());
    await Promise.all([
      ...disposing,
      ...[...this.workspaceOperations.values()].map((operation) => operation.finished),
    ]);
    this.agents.clear();
    this.touched.clear();
  }
}
