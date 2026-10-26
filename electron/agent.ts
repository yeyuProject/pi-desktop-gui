import { splitUserContent } from '../shared/message-content';
import { composeDraftText, type DraftSnippet } from '../shared/draft';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { load as loadYaml } from 'js-yaml';
import { PiRpc } from './rpc';
import { agentDirectory, preparePi } from './environment';
import { Store, readSessionFile } from './store';
import { Workspace, attachmentPrompt } from './workspace';
import { CheckpointRecorder, type WorkspaceRequest } from './checkpoint-recorder';
import { stripAnsi } from '../shared/ansi';
import {
  busy,
  emptyRuntime,
  messageText,
  type Runtime,
  type Message,
  type RunStatus,
  type SendMode,
  type Session,
  type Model,
  type ImageAttachment,
  type TreeEntry,
  type MessageAction,
  type RuntimeNotification,
  type ApprovalMode,
  type ApprovalRequest,
  type ToolActivity,
} from '../shared/types';
import { APPROVAL_DENY, APPROVAL_PREFIX } from '../shared/approval';
import { validateImages } from './images';
import { piShellEnvironment, samePath } from './platform';
import { sessionStats } from './pi/protocol';
import { normalizePiToolPath } from './pi/tool-path';
import { DESKTOP_BRIDGE_COMMAND, DESKTOP_WORKSPACE_PREFIX } from '../shared/pi-bridge';
import { classifyModelError, redact, redactMessageError, type ModelErrorKind } from '../shared/errors';
export { redact } from '../shared/errors';

// Pi model records may contain provider headers. Keep only display metadata in IPC.
const displayModel = (model: any): Model | undefined =>
  model
    ? {
        id: model.id,
        provider: model.provider,
        name: model.name ?? model.id,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        input: model.input,
      }
    : undefined;

export const toolPatch = (result: any): string | undefined => {
  const patch = result?.details?.patch;
  return typeof patch === 'string' && patch ? patch.slice(0, 200000) : undefined;
};
export async function argumentHint(file: string) {
  if (!/\.md$/i.test(file)) return undefined;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1];
      const values = front ? loadYaml(front) : undefined;
      const hint =
        values && typeof values === 'object'
          ? (values as Record<string, unknown>)['argument-hint']
          : undefined;
      return typeof hint === 'string' && hint.trim() ? hint.trim().slice(0, 200) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Connection and configuration status is not conversation activity. Persist content/run boundaries,
// rather than every streamed token, so browsing does not change recency or unread state.
const sessionActivityEvents = new Set([
  'agent_start',
  'message_start',
  'message_end',
  'tool_execution_start',
  'tool_execution_end',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'agent_settled',
]);
interface QueuedDraft {
  text: string;
  original: string;
  attachments: string[];
  images: ImageAttachment[];
  snippets: DraftSnippet[];
  mode: SendMode;
  observed: boolean;
}

export class AgentService extends EventEmitter {
  runtime: Runtime = emptyRuntime();
  private rpc?: PiRpc;
  private modelReader?: PiRpc;
  private modelCatalogRevision = 0;
  private publishing?: NodeJS.Timeout;
  private savingState?: Promise<void>;
  private operation = Promise.resolve();
  private settingsOperation = Promise.resolve();
  private reading = 0;
  private preferring = 0;
  private activeWriteTargets = new Map<string, string>();
  private pendingOperations = 0;
  private stopRequested = false;
  private retryNotice?: number;
  private retryCancelled = false;
  private connecting = false;
  private shutdown = false;
  private reloadSuspended = false;
  private fullOutput = '';
  private dialogTimers = new Map<string, NodeJS.Timeout>();
  private probe?: PiRpc;
  private probing = false;
  private stopEpoch = 0;
  private historyRevision = 0;
  private reconciledHistoryRevision = 0;
  private queuedDrafts: QueuedDraft[] = [];
  private pendingDraft?: QueuedDraft;
  private notificationId = 0;
  private crashTimes = new Map<string, number>();
  private crashCleanup = Promise.resolve();
  private unsafeExit = false;
  private processAgentDir?: string;
  private switchEvents?: any[];
  private switchStarted = false;
  // Pi allocates a path before its first message creates the file. Never infer this on resume.
  private freshSessionFile?: string;
  lastSwitch?: { mode: 'reuse' | 'restart'; elapsedMs: number; reason?: string; pid?: number };
  recentModelErrors: { kind: ModelErrorKind; at: number }[] = [];
  private errorCounts = new Map<string, { kind: ModelErrorKind; count: number }>();
  private checkpointRecorder: CheckpointRecorder;
  get hasPendingWork() {
    return this.pendingOperations > 0 || this.requiresStopConfirmation;
  }
  get requiresStopConfirmation() {
    return (
      busy(this.runtime.status) ||
      this.probing ||
      this.connecting ||
      this.runtime.modelsLoading ||
      this.unsafeExit ||
      this.runtime.dialogs.length > 0
    );
  }
  get workspaceInUse() {
    // Passive RPC reads and an isolated --no-tools connection probe do not modify the project.
    return (
      this.pendingOperations > this.reading ||
      busy(this.runtime.status) ||
      this.connecting ||
      this.unsafeExit ||
      this.runtime.dialogs.length > 0
    );
  }
  get configurationDirectory() {
    return this.processAgentDir ?? agentDirectory(this.store.state.settings);
  }
  get writingPaths() {
    return [...this.activeWriteTargets.values()];
  }
  diagnostics() {
    return {
      sessionId: this.runtime.sessionId,
      status: this.runtime.status,
      connected: this.runtime.connected,
      connecting: this.connecting,
      probing: this.probing,
      unsafeExit: this.unsafeExit,
      pendingOperations: this.pendingOperations,
      dialogs: this.runtime.dialogs.map(({ id, title }) => ({ id, title })),
      crash: this.runtime.crash,
    };
  }
  suspendReload(value: boolean) {
    this.reloadSuspended = value;
    if (!value && this.runtime.configurationPending && !busy(this.runtime.status))
      void this.scheduleReload().catch((error) => this.diagnostic(errorText(error)));
  }
  constructor(
    readonly store: Store,
    readonly workspace: Workspace,
    private developmentRoot?: string,
    private bridgeSource = path.resolve('dist-electron/pi-bridge.mjs'),
    private beforeConnect?: (operation: 'connect' | 'read' | 'write', target?: string) => Promise<void>,
  ) {
    super();
    this.checkpointRecorder = new CheckpointRecorder(store, workspace);
  }
  publish(immediate = false) {
    if (immediate) {
      if (this.publishing) clearTimeout(this.publishing);
      this.publishing = undefined;
      this.flush();
      return;
    }
    this.publishing ??= setTimeout(() => {
      this.publishing = undefined;
      this.flush();
    }, 40);
  }
  /** What the UI last received, as JSON strings per item, to send only what changed since. */
  private sent = {
    sessionId: undefined as string | undefined,
    messages: [] as string[],
    tools: [] as string[],
  };
  private serialized = new WeakMap<object, string>();
  private sentFields = new Map<string, { value: unknown; json: string | undefined }>();
  private flush() {
    if (this.listenerCount('runtime')) this.emit('runtime', structuredClone(this.runtime));
    if (!this.listenerCount('runtimePatch')) return;
    const r = this.runtime;
    const reset = this.sent.sessionId !== r.sessionId;
    // Messages are only mutated in place at the end (streaming) and tools only while running;
    // everything else is replaced wholesale, so settled objects reuse their cached serialization.
    const changedFrom = (
      items: object[],
      previous: string[],
      next: string[],
      seen: WeakMap<object, string>,
      mutable: (item: object, index: number) => boolean,
    ) => {
      let from = reset ? 0 : Math.min(previous.length, items.length);
      for (let i = 0; i < items.length; i++) {
        const changing = mutable(items[i], i);
        const frozen = !changing && seen.get(items[i]);
        next[i] = frozen || JSON.stringify(items[i]);
        if (changing) seen.delete(items[i]);
        else if (!frozen) seen.set(items[i], next[i]);
        if (i < from && next[i] !== previous[i]) from = i;
      }
      return from;
    };
    const messages: string[] = [],
      tools: string[] = [];
    const messagesFrom = changedFrom(
      r.messages,
      this.sent.messages,
      messages,
      this.serialized,
      (item, index) => index === r.messages.length - 1 && (item as Message).role === 'assistant',
    );
    // Preserve late updates to recent tools and the final transition of older
    // concurrent tools, which must remain uncached while running.
    const toolsFrom = changedFrom(
      r.tools,
      this.sent.tools,
      tools,
      this.serialized,
      (item, index) => index >= r.tools.length - 8 || (item as ToolActivity).status === 'running',
    );
    const { messages: _m, tools: _t, ...rest } = r;
    const fields: Record<string, unknown> = {};
    const removed = [...this.sentFields.keys()].filter((key) => !(key in rest));
    for (const key of removed) this.sentFields.delete(key);
    for (const [key, value] of Object.entries(rest)) {
      const before = this.sentFields.get(key);
      // These collections are replaced when updated. Avoid scanning large diagnostics
      // and model catalogs on every token; other (mutable) fields are compared by value.
      const replaced = key === 'diagnostic' || key === 'models' || key === 'commands';
      if (!reset && before && (replaced || typeof value !== 'object') && before.value === value) continue;
      const json = JSON.stringify(value);
      if (reset || !before || before.json !== json) fields[key] = structuredClone(value);
      this.sentFields.set(key, { value, json });
    }
    this.sent = { sessionId: r.sessionId, messages, tools };
    this.emit('runtimePatch', {
      ...fields,
      sessionId: r.sessionId,
      ...(removed.length ? { removed } : {}),
      messagesFrom,
      messages: messages.slice(messagesFrom).map((s) => JSON.parse(s)),
      messageCount: messages.length,
      toolsFrom,
      tools: tools.slice(toolsFrom).map((s) => JSON.parse(s)),
      toolCount: tools.length,
    });
  }
  /** Next patch carries the whole runtime, e.g. after the window reloads. */
  resync() {
    this.sent = { sessionId: undefined, messages: [], tools: [] };
    this.serialized = new WeakMap();
    this.sentFields.clear();
  }
  private save(immediate = true) {
    const saving = immediate ? this.store.save() : this.store.scheduleSave();
    if (this.savingState === saving) return;
    this.savingState = saving;
    void saving
      .then(() => {
        // A later save includes earlier changes; broadcast once after that write completes.
        if (this.savingState !== saving) return;
        this.savingState = undefined;
        this.emit('state', this.store.state);
      })
      .catch((e) => {
        if (this.savingState === saving) this.savingState = undefined;
        this.setError(`本地保存失败：${errorText(e)}`);
        this.publish();
      });
  }
  private protectSession(id: string) {
    const transient = this.store.isTransientSession(id);
    const session = this.store.promoteSession(id);
    // Persist accepted intent even if a later resource/trust check fails or the task
    // is cancelled before Pi starts. ensureConnected still observes the write barrier.
    if (transient) this.save();
    return session;
  }
  private status(status: RunStatus) {
    if (!busy(status))
      this.finishRetry(
        status === 'completed' ? 'recovered' : status === 'stopped' ? 'cancelled' : 'interrupted',
      );
    this.runtime.status = status;
    if (this.runtime.sessionId) {
      const s = this.store.session(this.runtime.sessionId);
      s.lastStatus = status;
      this.save(!busy(status));
    }
    this.publish(true);
  }
  private activity() {
    if (!this.runtime.sessionId) return;
    const session = this.store.session(this.runtime.sessionId);
    session.updatedAt = Date.now();
    if (!busy(this.runtime.status)) session.unread = this.store.state.selectedSessionId !== session.id;
    this.save(!busy(this.runtime.status));
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const result = this.operation.then(action, action);
    this.operation = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.pendingOperations--;
    });
  }
  private preference<T>(action: () => Promise<T>): Promise<T> {
    this.preferring++;
    this.pendingOperations++;
    const result = this.settingsOperation.then(action, action);
    this.settingsOperation = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.pendingOperations--;
      this.preferring--;
      if (!this.preferring && this.runtime.configurationPending && !busy(this.runtime.status))
        void this.exclusive(() => this.applyPendingConfiguration()).catch((error) =>
          this.diagnostic(errorText(error)),
        );
    });
  }
  private diagnostic(s: string) {
    this.runtime.diagnostic.push(redact(s).slice(-4000));
    this.runtime.diagnostic = this.runtime.diagnostic.slice(-100);
    this.publish();
  }
  private setError(error?: string) {
    this.runtime.error = error === undefined ? undefined : redact(error);
    this.runtime.errorKind = undefined;
    this.runtime.errorCount = undefined;
  }
  private updateStats(stats: Runtime['stats']) {
    this.runtime.stats = stats;
    if (!stats || !this.runtime.sessionId) return;
    const session = this.store.session(this.runtime.sessionId);
    if (session.stats?.tokens === stats.tokens && session.stats?.cost === stats.cost) return;
    session.stats = { tokens: stats.tokens, cost: stats.cost };
    this.save();
  }
  private modelError(error: string, settled: boolean) {
    const kind = classifyModelError(error).kind;
    this.runtime.error = redact(error);
    this.runtime.errorKind = kind;
    const id = this.runtime.sessionId;
    if (settled && id) {
      const previous = this.errorCounts.get(id);
      const count = previous?.kind === kind ? previous.count + 1 : 1;
      this.errorCounts.set(id, { kind, count });
      this.runtime.errorCount = count;
      this.recentModelErrors = [...this.recentModelErrors, { kind, at: Date.now() }].slice(-5);
    }
  }
  private notify(text: string, level: RuntimeNotification['level'] = 'info', keepInHistory = true) {
    text = redact(text);
    const r = this.runtime;
    if (keepInHistory) r.notices.push(text);
    r.notifications = [...(r.notifications ?? []), { id: ++this.notificationId, text, level }].slice(-5);
  }
  private clearDialogs() {
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    this.runtime.dialogs = [];
  }
  private updateRetryNotice(text: string) {
    const notices = this.runtime.notices;
    if (this.retryNotice === undefined) {
      this.retryNotice = notices.length;
      notices.push(redact(text));
    } else notices[this.retryNotice] = redact(text);
  }
  private finishRetry(outcome: 'recovered' | 'failed' | 'cancelled' | 'interrupted') {
    const retry = this.runtime.retry;
    if (!retry) return;
    if (outcome === 'recovered') {
      if (this.retryNotice !== undefined) this.runtime.notices.splice(this.retryNotice, 1);
      this.notify('连接已恢复', 'info', false);
    } else {
      const label = {
        failed: '重试失败',
        cancelled: '重试已取消',
        interrupted: '重试已中断',
      }[outcome];
      this.updateRetryNotice(
        `${label}（${retry.attempt}/${retry.maxAttempts}）${retry.error ? `：${retry.error}` : ''}`,
      );
    }
    this.runtime.retry = undefined;
    this.retryNotice = undefined;
  }
  private onEvent(record: any) {
    const r = this.runtime;
    switch (record.type) {
      case 'desktop_approval_grants':
        r.approvalGrants = record.grants;
        break;
      case 'desktop_auth':
        r.auth = record.clear
          ? undefined
          : { message: record.message ?? '', url: record.url, code: record.code };
        break;
      case 'bash_execution_update': {
        const t = r.tools.find((t) => t.id === 'desktop-bash');
        if (t) t.output = (t.output + String(record.delta ?? '')).slice(-100000);
        break;
      }
      case 'agent_start':
        if (r.retry) {
          r.retry.phase = 'requesting';
          r.retry.requestedAt = Date.now();
          this.updateRetryNotice(
            `正在重试 ${r.retry.attempt}/${r.retry.maxAttempts}，等待模型响应${r.retry.error ? `：${r.retry.error}` : ''}`,
          );
        } else this.retryCancelled = false;
        if (!this.stopRequested) this.status(r.retry ? 'retrying' : 'running');
        break;
      case 'message_start':
        r.messages.push(redactMessageError(record.message));
        break;
      case 'message_update': {
        let m = r.messages.at(-1);
        if (!m || m.role !== 'assistant') {
          this.historyRevision++;
          m = { role: 'assistant', content: [], timestamp: Date.now() };
          r.messages.push(m);
        }
        if (typeof m.content === 'string') m.content = [{ type: 'text', text: m.content }];
        const e = record.assistantMessageEvent,
          i = e?.contentIndex ?? 0;
        if (!e) break;
        if (e.type === 'text_start') m.content[i] = { type: 'text', text: '' };
        if (e.type === 'text_delta') {
          m.content[i] ??= { type: 'text', text: '' };
          m.content[i].text = (m.content[i].text ?? '') + (e.delta ?? '');
        }
        if (e.type === 'text_end') m.content[i] = { type: 'text', text: e.content ?? '' };
        if (e.type === 'thinking_start') m.content[i] = { type: 'thinking', thinking: '' };
        if (e.type === 'thinking_delta') {
          m.content[i] ??= { type: 'thinking', thinking: '' };
          m.content[i].thinking = (m.content[i].thinking ?? '') + (e.delta ?? '');
        }
        if (e.type === 'thinking_end') m.content[i] = { type: 'thinking', thinking: e.content ?? '' };
        if (e.type === 'toolcall_start')
          m.content[i] = { type: 'toolCall', id: e.id, name: e.toolName, arguments: {}, partialJson: '' };
        if (e.type === 'toolcall_delta' && m.content[i]?.type === 'toolCall')
          m.content[i].partialJson = (String(m.content[i].partialJson ?? '') + (e.delta ?? '')).slice(
            -200000,
          );
        if (e.type === 'toolcall_end') m.content[i] = e.toolCall;
        break;
      }
      case 'message_end': {
        const last = r.messages.at(-1);
        if (last && last.role === record.message?.role)
          r.messages[r.messages.length - 1] = redactMessageError(record.message);
        else r.messages.push(redactMessageError(record.message));
        break;
      }
      case 'tool_execution_start':
        r.tools.push({
          id: record.toolCallId,
          parentToolCallId: record.parentToolCallId,
          name: record.toolName,
          args: record.args ?? {},
          status: 'running',
          output: '',
          startedAt: Date.now(),
        });
        break;
      case 'tool_execution_update': {
        const t = r.tools.find((t) => t.id === record.toolCallId);
        if (t)
          t.output = messageText(record.partialResult ?? { content: '' })
            .split('\n')
            .slice(-200)
            .join('\n');
        break;
      }
      case 'tool_execution_end': {
        const output = messageText(record.result ?? { content: '' });
        let t = r.tools.find((t) => t.id === record.toolCallId);
        if (!t) {
          t = {
            id: record.toolCallId,
            parentToolCallId: record.parentToolCallId,
            name: record.toolName,
            args: {},
            status: 'running',
            output: '',
            startedAt: Date.now(),
          };
          r.tools.push(t);
        }
        t.output = output.split('\n').slice(-200).join('\n');
        t.patch = toolPatch(record.result);
        t.status = record.isError ? 'error' : 'done';
        t.durationMs = record.durationMs ?? Date.now() - t.startedAt;
        this.fullOutput = (this.fullOutput + `\n\n[${t.name}] ${JSON.stringify(t.args)}\n${output}`).slice(
          -10 * 1024 * 1024,
        );
        break;
      }
      case 'queue_update': {
        const previous = { steer: r.steering, followUp: r.followUp };
        r.steering = record.steering ?? [];
        r.followUp = record.followUp ?? [];
        const current = { steer: r.steering, followUp: r.followUp };
        const pending = this.pendingDraft;
        if (pending && !pending.observed) {
          const before = previous[pending.mode],
            after = current[pending.mode];
          if (after.length > before.length && before.every((text, index) => after[index] === text)) {
            // Pi reports expanded template text before acknowledging the queued prompt.
            pending.text = after.at(-1)!;
            pending.observed = true;
            this.queuedDrafts.push(pending);
          }
        }
        const remaining = { steer: [...r.steering], followUp: [...r.followUp] };
        this.queuedDrafts = this.queuedDrafts
          .slice()
          .reverse()
          .filter((draft) => {
            const queue = remaining[draft.mode];
            const index = queue.lastIndexOf(draft.text);
            if (index < 0) return false;
            queue.splice(index, 1);
            return true;
          })
          .reverse();
        break;
      }
      case 'compaction_start':
        if (!this.stopRequested) this.status('compacting');
        break;
      case 'compaction_end':
        this.historyRevision++;
        if (record.errorMessage) this.notify(`上下文压缩失败：${record.errorMessage}`, 'warning');
        if (!this.stopRequested)
          this.status(record.reason === 'manual' && !record.willRetry ? 'idle' : 'running');
        break;
      case 'auto_retry_start':
        this.updateRetryNotice(
          `等待重试 ${record.attempt}/${record.maxAttempts}：${record.errorMessage ?? ''}`,
        );
        r.retry = {
          attempt: record.attempt,
          maxAttempts: record.maxAttempts,
          delayMs: record.delayMs ?? 0,
          startedAt: Date.now(),
          phase: 'delay',
          error: record.errorMessage ? redact(record.errorMessage) : undefined,
        };
        if (!this.stopRequested) this.status('retrying');
        break;
      case 'auto_retry_end': {
        const cancelled =
          this.stopRequested || this.retryCancelled || record.finalError === 'Retry cancelled';
        if (cancelled) this.retryCancelled = true;
        this.finishRetry(cancelled ? 'cancelled' : record.success ? 'recovered' : 'failed');
        if (!record.success && !cancelled && record.finalError) this.modelError(record.finalError, false);
        if (!this.stopRequested) this.status('running');
        break;
      }
      case 'agent_settled': {
        const aborted = record.aborted || this.retryCancelled;
        const last = r.messages.findLast((m) => m.role === 'assistant');
        const failed = last?.stopReason === 'error';
        this.finishRetry(this.stopRequested || aborted ? 'cancelled' : failed ? 'failed' : 'recovered');
        if (this.stopRequested) break;
        if (failed && !aborted) this.modelError(last.errorMessage || '模型请求失败', true);
        else {
          this.setError();
          if (!aborted && r.sessionId) this.errorCounts.delete(r.sessionId);
        }
        this.status(aborted ? 'stopped' : failed ? 'error' : 'completed');
        for (const t of r.tools)
          if (t.status === 'running') {
            t.status = 'error';
            t.output += '\n执行已结束但未收到工具结果';
          }
        void this.refresh(r.messages.at(-1)?.role !== 'assistant' || !last?.stopReason).catch((e) =>
          this.diagnostic(errorText(e)),
        );
        const sessionId = r.sessionId;
        void this.exclusive(async () => {
          if (sessionId) await this.checkpointRecorder.finish(sessionId);
          this.activeWriteTargets.clear();
          await this.syncApprovalMode();
          await this.applyPendingConfiguration();
        }).catch((e) => this.diagnostic(errorText(e)));
        break;
      }
      case 'session_info_changed':
        if (r.sessionId && record.name) {
          this.store.session(r.sessionId).title = String(record.name).slice(0, 120);
          this.save();
        }
        break;
      case 'thinking_level_changed':
        r.thinking = record.level;
        break;
      case 'extension_error':
        this.notify(`扩展错误：${record.error}`, 'error');
        break;
      case 'extension_ui_request':
        this.extension(record);
        break;
      // agent_end is deliberately not a terminal state: recovery and queued work may follow.
    }
    if (r.messages.length) this.freshSessionFile = undefined;
    if (!this.connecting && sessionActivityEvents.has(record.type)) this.activity();
    const dropped = Math.max(0, r.notices.length - 20);
    if (dropped) {
      r.notices = r.notices.slice(-20);
      if (this.retryNotice !== undefined) {
        this.retryNotice -= dropped;
        if (this.retryNotice < 0) this.retryNotice = undefined;
      }
    }
    if (r.tools.length > 1000) r.tools = r.tools.slice(-1000);
    this.publish();
  }
  private extension(record: any) {
    const r = this.runtime;
    if (record.method === 'input' && String(record.title).startsWith(DESKTOP_WORKSPACE_PREFIX)) {
      const rpc = this.rpc;
      const epoch = this.stopEpoch;
      void (async () => {
        let result: { ok: boolean; error?: string };
        try {
          if (!r.sessionId || this.stopRequested) throw new Error('检查点操作已取消');
          const request = JSON.parse(
            String(record.title).slice(DESKTOP_WORKSPACE_PREFIX.length),
          ) as WorkspaceRequest;
          if (
            request.phase === 'tool-start' &&
            ['write', 'edit'].includes(request.toolName ?? '') &&
            typeof request.args?.path === 'string'
          ) {
            const target = normalizePiToolPath(r.cwd!, request.args.path);
            this.activeWriteTargets.set(request.toolId!, target);
            try {
              await this.beforeConnect?.('write', target);
            } catch (error) {
              this.activeWriteTargets.delete(request.toolId!);
              throw error;
            }
          }
          await this.checkpointRecorder.handle(r.sessionId, request);
          if (request.phase === 'tool-end') this.activeWriteTargets.delete(request.toolId!);
          if (this.rpc !== rpc || this.runtime !== r || epoch !== this.stopEpoch || this.stopRequested)
            throw new Error('检查点操作已取消');
          result = { ok: true };
        } catch (error) {
          result = { ok: false, error: redact(errorText(error)) };
          if (this.runtime === r && !this.stopRequested)
            this.notify(`无法保存文件检查点：${result.error}`, 'error');
        }
        await rpc?.write({ type: 'extension_ui_response', id: record.id, value: JSON.stringify(result) });
      })().catch((error) => this.diagnostic(errorText(error)));
      return;
    }
    if (['select', 'confirm', 'input', 'editor'].includes(record.method)) {
      const expiresAt = record.timeout ? Date.now() + record.timeout : undefined;
      let approval: ApprovalRequest | undefined;
      if (record.method === 'select' && String(record.title ?? '').startsWith(APPROVAL_PREFIX)) {
        try {
          approval = JSON.parse(String(record.title).slice(APPROVAL_PREFIX.length));
        } catch {}
      }
      r.dialogs.push(
        approval
          ? { ...record, title: `允许 ${approval.toolName}？`, approval, expiresAt }
          : { ...record, expiresAt },
      );
      if (!this.stopRequested && !this.modelReader) this.status('waiting');
      if (record.timeout)
        this.dialogTimers.set(
          record.id,
          setTimeout(() => {
            r.dialogs = r.dialogs.filter((d) => d.id !== record.id);
            this.dialogTimers.delete(record.id);
            if (r.status === 'waiting') this.status(this.connecting ? 'starting' : 'running');
            this.publish(true);
          }, record.timeout),
        );
    } else if (record.method === 'notify')
      this.notify(
        String(record.message ?? ''),
        record.notifyType === 'error' ? 'error' : record.notifyType === 'warning' ? 'warning' : 'info',
      );
    else if (record.method === 'setStatus') {
      if (record.statusText) r.statuses[record.statusKey] = record.statusText;
      else delete r.statuses[record.statusKey];
    } else if (record.method === 'setWidget') {
      if (record.widgetLines) r.widgets[record.widgetKey] = record.widgetLines;
      else delete r.widgets[record.widgetKey];
      (r.widgetPlacements ??= {})[record.widgetKey] = record.widgetPlacement ?? 'aboveEditor';
    } else if (record.method === 'set_editor_text' && r.sessionId) {
      this.store.session(r.sessionId).draft = String(record.text ?? '');
      this.store.session(r.sessionId).draftSnippets = [];
      this.save();
    } else if (record.method === 'setTitle') r.title = String(record.title ?? 'Pi Desktop');
    else this.notify(`扩展界面能力 ${record.method} 暂不支持，请在终端使用该扩展。`, 'warning');
  }
  async respond(id: string, values: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const d = this.runtime.dialogs.find((d) => d.id === id);
    if (!d || (d.expiresAt && Date.now() >= d.expiresAt)) throw new Error('这个问题已失效');
    const denyWithReason = d.approval && values.value?.startsWith(APPROVAL_DENY + '：');
    if (
      d.method === 'select' &&
      !values.cancelled &&
      !denyWithReason &&
      !d.options?.includes(values.value ?? '')
    )
      throw new Error('请选择有效选项');
    if (denyWithReason) values = { value: values.value!.slice(0, APPROVAL_DENY.length + 1 + 2000) };
    await (this.modelReader ?? this.rpc)?.write({ type: 'extension_ui_response', id, ...values });
    const timer = this.dialogTimers.get(id);
    if (timer) clearTimeout(timer);
    this.dialogTimers.delete(id);
    this.runtime.dialogs = this.runtime.dialogs.filter((d) => d.id !== id);
    if (this.runtime.status === 'waiting' && !this.runtime.dialogs.length)
      this.status(this.connecting ? 'starting' : 'running');
    this.publish(true);
  }
  private async refresh(reconcile = true) {
    const rpc = this.rpc;
    const runtime = this.runtime;
    if (!rpc || rpc.closed || this.switchEvents) return;
    const state = await rpc.request('get_state');
    if (this.rpc !== rpc || this.runtime !== runtime || this.switchEvents) return;
    this.runtime.model = displayModel(state.model);
    this.runtime.thinking = state.thinkingLevel;
    this.runtime.autoCompaction = state.autoCompactionEnabled;
    this.runtime.steeringMode = state.steeringMode;
    this.runtime.followUpMode = state.followUpMode;
    if (this.runtime.sessionId && state.sessionFile) {
      this.store.session(this.runtime.sessionId).file = state.sessionFile;
      this.save();
    }
    if (!busy(this.runtime.status)) {
      if (reconcile || this.historyRevision !== this.reconciledHistoryRevision) {
        const revision = this.historyRevision;
        const before = runtime.messages,
          count = before.length,
          last = before.at(-1);
        const context = await rpc.request('get_messages');
        const messages = await this.readTranscript(state.sessionFile, context.messages);
        if (
          this.rpc === rpc &&
          this.runtime === runtime &&
          !this.switchEvents &&
          !busy(runtime.status) &&
          runtime.messages === before &&
          before.length === count &&
          before.at(-1) === last
        ) {
          runtime.messages = messages;
          this.reconciledHistoryRevision = revision;
          // Reconcile after compaction, navigation or recovery; ordinary turns already arrive as events.
          this.resync();
        }
      }
      try {
        const stats = await rpc.request('get_session_stats');
        if (this.rpc === rpc && this.runtime === runtime && !this.switchEvents)
          this.updateStats(sessionStats(stats));
      } catch {}
    }
    this.publish();
  }
  private async readTranscript(
    file: string | undefined,
    fallback: Message[],
    sessionId = this.runtime.sessionId,
  ): Promise<Message[]> {
    const runtime = this.runtime;
    if (fallback.length && this.freshSessionFile === file) this.freshSessionFile = undefined;
    if (file) {
      try {
        const transcript = await readSessionFile(file);
        const session = this.store.state?.sessions?.find((item) => item.id === sessionId);
        if (session && session.historyNotice !== transcript.warning) {
          session.historyNotice = transcript.warning;
          this.emit('state', this.store.state);
        }
        if (this.runtime === runtime && this.runtime.historyNotice !== transcript.warning) {
          this.runtime.historyNotice = transcript.warning;
          this.publish();
        }
        if (this.runtime === runtime && this.freshSessionFile === file) this.freshSessionFile = undefined;
        return transcript.messages.map(redactMessageError);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (this.runtime === runtime && this.freshSessionFile === file) this.freshSessionFile = undefined;
          throw error;
        }
      }
    }
    return fallback.map(redactMessageError);
  }
  connect(sessionId: string) {
    this.protectSession(sessionId);
    return this.exclusive(async () => {
      await this.ensureConnected(sessionId);
      await this.applyPendingConfiguration();
    });
  }
  readModels(sessionId: string, aroundRead: (read: () => Promise<void>) => Promise<void> = (read) => read()) {
    // Reserve the existing operation queue before outer terminal/workspace checks
    // await I/O. Reading a catalog alone does not make a conversation permanent.
    return this.exclusive(() =>
      aroundRead(async () => {
        if (this.runtime.connected && this.runtime.sessionId === sessionId) return;
        const session = this.store.session(sessionId);
        const settings = this.store.state.settings;
        const wanted =
          session.model ??
          (!session.file && settings.provider && settings.modelId
            ? { provider: settings.provider, id: settings.modelId }
            : undefined);
        await this.readModelCatalog(sessionId, wanted, session.thinking, false);
      }),
    );
  }
  invalidateModels() {
    this.modelCatalogRevision++;
    this.runtime.modelsLoaded = false;
    this.publish(true);
  }
  /** Read Pi's real project/provider metadata without creating a conversation or loading the desktop bridge. */
  private async readModelCatalog(
    sessionId: string,
    model?: Session['model'],
    thinking?: string,
    requireModel = true,
  ) {
    const epoch = this.stopEpoch;
    const catalogRevision = this.modelCatalogRevision;
    await this.crashCleanup;
    this.assertCommandsStopped();
    // An explicit model choice may have just promoted a placeholder. Its queued
    // save must succeed before even the disposable metadata process is started.
    await this.store.flush();
    this.store.assertWritable();
    if (this.shutdown) throw new Error('应用正在关闭，请稍后重新打开');
    const session = this.store.session(sessionId);
    const project = session.projectId ? this.store.project(session.projectId) : undefined;
    if (project && !project.trusted) throw new Error('请先确认此项目可以由 Pi 读取、修改和执行命令');
    await this.beforeConnect?.('connect');
    const cwd = await this.store.sessionDirectory(sessionId);
    if (this.shutdown || epoch !== this.stopEpoch) throw new Error('读取模型已取消');
    this.runtime.sessionId = sessionId;
    this.runtime.cwd = cwd;
    this.stopRequested = false;
    this.setError();
    this.runtime.modelsLoading = true;
    this.runtime.modelsLoaded = false;
    this.publish(true);
    const reader = new PiRpc();
    this.modelReader = reader;
    reader.on('diagnostic', (message) => this.diagnostic(message));
    reader.on('event', (event) => {
      if (
        event.type === 'extension_ui_request' &&
        ['select', 'confirm', 'input', 'editor', 'notify'].includes(event.method)
      )
        this.extension(event);
    });
    let temporarySessionDir: string | undefined;
    let temporarySessionFile: string | undefined;
    try {
      // Pi restores branch selections itself. Give it a disposable copy so reading an old
      // conversation cannot append metadata or change the original session file.
      // A missing transcript must not fail the catalog read: fall back to the same
      // disposable --no-session probe.
      if (session.file) {
        temporarySessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-models-'));
        const copiedFile = path.join(temporarySessionDir, 'session.jsonl');
        try {
          await fs.copyFile(session.file, copiedFile);
          temporarySessionFile = copiedFile;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // Keep the directory for finally cleanup even when the source vanished.
        }
      }
      const { environment, resolved } = await preparePi(this.store.state.settings, this.developmentRoot);
      if (this.shutdown || this.stopRequested || epoch !== this.stopEpoch) throw new Error('读取模型已取消');
      this.processAgentDir = agentDirectory(this.store.state.settings);
      reader.start(
        resolved.spec,
        cwd,
        [
          '--mode',
          'rpc',
          ...(temporarySessionFile ? ['--session', temporarySessionFile] : ['--no-session']),
          '--no-tools',
          '--no-mcp',
          '--no-skills',
          '--no-context-files',
          '--no-prompt-templates',
          '--no-themes',
          ...(project?.trusted ? ['--approve'] : []),
        ],
        {
          PI_CODING_AGENT_DIR: agentDirectory(this.store.state.settings),
          PI_TELEMETRY: '0',
          ...piShellEnvironment(environment.bash),
        },
      );
      await reader.request('get_state', {}, 120000);
      const available = await reader.request('get_available_models');
      const modelAvailable =
        !model || available.models.some((item) => item.provider === model.provider && item.id === model.id);
      if (model && (requireModel || modelAvailable))
        await reader.request('set_model', { provider: model.provider, modelId: model.id });
      if (thinking) await reader.request('set_thinking_level', { level: thinking });
      const [state, levels] = await Promise.all([
        reader.request('get_state'),
        reader.request('get_available_thinking_levels'),
      ]);
      if (this.shutdown || this.stopRequested || epoch !== this.stopEpoch) throw new Error('读取模型已取消');
      this.runtime.models = available.models.map(displayModel).filter((item): item is Model => Boolean(item));
      this.runtime.modelsLoaded = catalogRevision === this.modelCatalogRevision;
      this.runtime.model = modelAvailable ? displayModel(state.model) : undefined;
      this.runtime.thinking = state.thinkingLevel;
      this.runtime.thinkingLevels = modelAvailable ? levels.levels : [];
      this.runtime.connected = false;
    } catch (error) {
      this.setError(errorText(error));
      throw error;
    } finally {
      try {
        await reader.close();
      } finally {
        this.modelReader = undefined;
        this.clearDialogs();
        this.runtime.modelsLoading = false;
        this.publish(true);
        if (temporarySessionDir) await fs.rm(temporarySessionDir, { recursive: true, force: true });
      }
    }
  }
  assertCommandsStopped() {
    if (this.unsafeExit)
      throw new Error(
        '无法确认本会话启动的命令已结束，暂不能重连本会话或撤销相关目录的文件。其他会话仍可使用。请在任务管理器或终端结束残留命令，再重新启动 Pi Desktop；可先打开诊断查看最后的命令。',
      );
  }
  private async ensureConnected(sessionId: string) {
    this.protectSession(sessionId);
    const started = performance.now();
    const epoch = this.stopEpoch;
    await this.crashCleanup;
    this.assertCommandsStopped();
    await this.store.flush();
    this.store.assertWritable();
    if (this.shutdown) throw new Error('应用正在关闭，请稍后重新打开');
    if (this.probing) throw new Error('正在测试模型连接，请稍候');
    const session = this.store.session(sessionId),
      project = session.projectId ? this.store.project(session.projectId) : undefined;
    const resuming = Boolean(session.file);
    if (project && !project.trusted) throw new Error('请先确认此项目可以由 Pi 读取、修改和执行命令');
    if (busy(this.runtime.status) && this.runtime.sessionId !== sessionId)
      throw new Error('另一个会话正在运行，请先停止或等待完成');
    if (this.rpc && !this.rpc.closed && this.runtime.connected && this.runtime.sessionId === sessionId) {
      await this.applyPendingConfiguration();
      await this.syncApprovalMode();
      if (this.shutdown) throw new Error('应用正在关闭，请稍后重新打开');
      return;
    }
    await this.beforeConnect?.('connect');
    const cwd = await this.store.sessionDirectory(sessionId);
    let reason = this.rpc?.closed ? 'Pi 进程已退出' : '当前没有 Pi 连接';
    const outgoing = this.store.state.sessions.find((s) => s.id === this.runtime.sessionId);
    // Pi's new_session inherits the open file's directory. A legacy desktop
    // history must remain resumable without sending the next new chat there.
    const legacyDirectory =
      !session.file &&
      outgoing?.file &&
      samePath(path.dirname(outgoing.file), path.join(this.store.dir, 'sessions'));
    if (
      this.rpc &&
      !this.rpc.closed &&
      this.runtime.connected &&
      this.runtime.cwd &&
      samePath(cwd, this.runtime.cwd) &&
      !legacyDirectory
    ) {
      const previousStatus = this.runtime.status;
      const events: any[] = [];
      this.switchEvents = events;
      this.switchStarted = false;
      this.connecting = true;
      let cancelled = false;
      try {
        const result = session.file
          ? await this.rpc.request('switch_session', { sessionPath: session.file }, 120000)
          : await this.rpc.request('new_session', {}, 120000);
        cancelled = result?.cancelled === true;
        if (cancelled) throw new Error('Pi 扩展取消了会话切换，原会话保持不变');
        if (!this.switchStarted) throw new Error('桌面适配扩展未确认新会话已开始');
        if (epoch !== this.stopEpoch || this.shutdown) throw new Error('会话切换已取消');
        this.switchEvents = undefined;
        // A before-switch dialog temporarily changes the outgoing session's status.
        this.store.session(this.runtime.sessionId!).lastStatus = previousStatus;
        this.resetSession(sessionId, cwd);
        for (const event of events) if (event.type !== 'session_info_changed') this.onEvent(event);
        await this.rebindSession(sessionId, resuming);
        this.recordSwitch('reuse', started);
        return;
      } catch (error) {
        if (cancelled) {
          this.clearDialogs();
          this.status(previousStatus);
          throw error;
        }
        reason = `复用切换失败：${redact(errorText(error))}`;
      } finally {
        this.switchEvents = undefined;
        this.switchStarted = false;
        this.connecting = false;
      }
    } else if (this.rpc && !this.rpc.closed)
      reason = legacyDirectory ? '新会话使用 Pi 原生目录' : '工作目录不同，重新加载项目环境';
    if (this.rpc) await this.closeRpc();
    if (epoch !== this.stopEpoch || this.shutdown) throw new Error('会话切换已取消');
    this.resetSession(sessionId, cwd);
    this.connecting = true;
    this.status('starting');
    try {
      const { environment, resolved } = await preparePi(this.store.state.settings, this.developmentRoot);
      if (this.stopRequested) throw new Error('启动已取消');
      const rpc = new PiRpc();
      this.rpc = rpc;
      this.installRpcHandlers(rpc);
      // Let Pi resolve its native per-cwd directory and any sessionDir override.
      const args = ['--mode', 'rpc', '--name', session.title];
      if (session.file) args.push('--session', session.file);
      else args.push('--session-id', session.id);
      const bridge = path.join(this.store.dir, `desktop-bridge-${sessionId}.mjs`);
      await fs.copyFile(this.bridgeSource, bridge);
      args.push('--extension', bridge);
      // RPC startup cannot prompt for project trust. Reuse the explicit desktop decision.
      if (project?.trusted) args.push('--approve');
      const shellEnv: NodeJS.ProcessEnv = {
        PI_CODING_AGENT_DIR: agentDirectory(this.store.state.settings),
        PI_TELEMETRY: '0',
        PI_DESKTOP_APPROVAL: session.approvalMode ?? 'auto',
        PI_DESKTOP_CHECKPOINTS: '1',
        ...piShellEnvironment(environment.bash),
      };
      this.processAgentDir = agentDirectory(this.store.state.settings);
      // Pi searches PATH after conventional Git locations. Prefer the Git Bash we detected,
      // including installations on another drive, over Windows' legacy WSL bash launcher.
      rpc.start(resolved.spec, cwd, args, shellEnv);
      await this.rebindSession(sessionId, resuming);
      this.recordSwitch('restart', started, reason);
      if (reason.startsWith('复用切换失败')) this.diagnostic(reason);
    } catch (e) {
      this.setError(errorText(e));
      this.runtime.connected = false;
      this.status(this.stopRequested ? 'stopped' : this.runtime.crash ? 'interrupted' : 'error');
      await this.closeRpc();
      throw e;
    } finally {
      this.connecting = false;
    }
  }
  private resetSession(sessionId: string, cwd: string) {
    this.freshSessionFile = undefined;
    this.checkpointRecorder.reset();
    this.activeWriteTargets.clear();
    this.clearDialogs();
    const crash = this.runtime.sessionId === sessionId ? this.runtime.crash : undefined;
    const configurationPending = this.runtime.configurationPending;
    this.runtime = { ...emptyRuntime(), sessionId, cwd, crash, configurationPending };
    this.retryNotice = undefined;
    this.retryCancelled = false;
    this.queuedDrafts = [];
    this.stopRequested = false;
    this.fullOutput = '';
  }
  private recordSwitch(mode: 'reuse' | 'restart', started: number, reason?: string) {
    this.lastSwitch = {
      mode,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      reason,
      pid: this.rpc?.child?.pid,
    };
  }
  private installRpcHandlers(rpc: PiRpc) {
    rpc.on('event', (e) => {
      if (this.rpc !== rpc) return;
      if (this.switchEvents && e.type === 'desktop_session_start') {
        this.switchStarted = true;
        return;
      }
      // Old hooks still own their editor changes. The bridge's session_start signal separates
      // those from target startup events. Dialogs stay answerable while the request is pending.
      const dialog =
        e.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(e.method);
      if (this.switchEvents && this.switchStarted && !dialog) this.switchEvents.push(e);
      else this.onEvent(e);
    });
    rpc.on('diagnostic', (s) => {
      if (this.rpc === rpc) this.diagnostic(s);
    });
    rpc.on('protocolError', (e) => {
      if (this.rpc === rpc) {
        this.setError(errorText(e));
        this.status('error');
        if (!this.connecting) this.activity();
        void rpc.killTree().catch(() => {});
      }
    });
    rpc.on('fault', (e) => {
      if (this.rpc === rpc) {
        this.setError(errorText(e));
        this.runtime.connected = false;
        this.status('error');
        if (!this.connecting) this.activity();
      }
    });
    rpc.on('exit', (code: number | null, signal: string | null) => {
      if (this.rpc !== rpc || this.shutdown) return;
      const sessionId = this.runtime.sessionId!;
      this.runtime.connected = false;
      this.clearDialogs();
      const last = this.runtime.tools.findLast((tool) => tool.status === 'running');
      this.restoreQueuedDrafts([...this.runtime.steering, ...this.runtime.followUp], this.queuedDrafts);
      this.runtime.steering = [];
      this.runtime.followUp = [];
      this.queuedDrafts = [];
      if (last) {
        this.unsafeExit = true;
        this.crashCleanup = rpc.treeTerminationConfirmed().then(async (confirmed) => {
          this.unsafeExit = !confirmed;
          if (confirmed)
            await this.checkpointRecorder
              .finish(sessionId)
              .catch((error) => this.diagnostic(errorText(error)));
          if (confirmed) this.activeWriteTargets.clear();
          if (this.runtime.crash) this.runtime.crash.cleanup = confirmed ? 'confirmed' : 'unconfirmed';
          if (!confirmed) this.setError('无法确认残留命令已结束，请结束命令后重新启动 Pi Desktop。');
          this.publish(true);
        });
      }
      if (this.stopRequested) {
        this.status('stopped');
        if (!this.connecting) this.activity();
        return;
      }
      const at = Date.now();
      this.runtime.crash = {
        cleanup: last ? 'checking' : 'confirmed',
        code,
        signal,
        at,
        repeated: at - (this.crashTimes.get(sessionId) ?? 0) <= 10000,
        lastTool: last
          ? {
              name: last.name,
              target: redact(String(last.args.command ?? last.args.path ?? '')).slice(0, 2000),
              seconds: Math.max(0, Math.floor((at - last.startedAt) / 1000)),
            }
          : undefined,
        log: this.runtime.diagnostic
          .flatMap((line) => line.split(/\r?\n/))
          .filter(Boolean)
          .slice(-20),
      };
      this.crashTimes.set(sessionId, at);
      for (const tool of this.runtime.tools)
        if (tool.status === 'running') {
          tool.status = 'error';
          tool.durationMs = at - tool.startedAt;
          tool.output += '\nPi 意外退出，工具是否完成需要检查当前文件。';
        }
      this.setError('Pi 意外退出，已保留会话和本轮文件快照。请检查文件后重新连接。');
      this.status('interrupted');
      if (!this.connecting) this.activity();
    });
  }
  private async rebindSession(sessionId: string, resuming: boolean) {
    const rpc = this.rpc!;
    const epoch = this.stopEpoch;
    const assertActive = () => {
      if (this.shutdown || this.stopRequested || epoch !== this.stopEpoch) throw new Error('会话连接已取消');
      if (this.rpc !== rpc || rpc.closed) throw new Error('Pi 在加载会话时已退出，请重新连接');
    };
    const session = this.store.session(sessionId);
    let state = await rpc.request('get_state', {}, 120000);
    assertActive();
    if (state.sessionFile) session.file = state.sessionFile;
    if (!resuming && !this.runtime.messages.length) this.freshSessionFile = state.sessionFile;
    this.runtime.model = displayModel(state.model);
    this.runtime.thinking = state.thinkingLevel;
    const [messages] = await Promise.all([rpc.request('get_messages'), this.refreshCapabilities()]);
    const transcript = await this.readTranscript(session.file, messages.messages);
    assertActive();
    this.runtime.messages = transcript;
    this.runtime.autoCompaction = state.autoCompactionEnabled;
    this.runtime.steeringMode = state.steeringMode;
    this.runtime.followUpMode = state.followUpMode;
    const calls = new Map(
      this.runtime.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === 'toolCall')
        .map((b) => [b.id, b]),
    );
    this.runtime.tools = this.runtime.messages
      .filter((m) => m.role === 'toolResult')
      .slice(-1000)
      .map((m) => ({
        id: m.toolCallId ?? '',
        name: m.toolName ?? 'tool',
        args: calls.get(m.toolCallId)?.arguments ?? {},
        status: m.isError ? 'error' : 'done',
        output: messageText(m).split('\n').slice(-200).join('\n'),
        startedAt: m.timestamp ?? 0,
        durationMs: typeof m.durationMs === 'number' ? m.durationMs : undefined,
        patch: toolPatch(m),
      }));
    this.fullOutput = this.runtime.messages
      .filter((m) => m.role === 'toolResult')
      .map((m) => `[${m.toolName ?? 'tool'}]\n${messageText(m)}`)
      .join('\n\n')
      .slice(-10 * 1024 * 1024);
    const settings = this.store.state.settings;
    const wanted =
      session.model ?? (resuming ? undefined : { provider: settings.provider, id: settings.modelId });
    if (
      wanted?.provider &&
      wanted.id &&
      (this.runtime.model?.provider !== wanted.provider || this.runtime.model?.id !== wanted.id) &&
      this.runtime.models.some((m) => m.provider === wanted.provider && m.id === wanted.id)
    ) {
      this.runtime.model = displayModel(
        await rpc.request('set_model', { provider: wanted.provider, modelId: wanted.id }),
      );
      state = await rpc.request('get_state');
    }
    await this.loadThinkingLevels(rpc);
    this.runtime.model = displayModel(state.model);
    this.runtime.thinking = state.thinkingLevel;
    // New sessions use Pi's effective default (including project overrides).
    // Only an existing session's own choice should override it.
    const thinking = session.thinking;
    if (thinking && thinking !== this.runtime.thinking && this.runtime.thinkingLevels.includes(thinking)) {
      await rpc.request('set_thinking_level', { level: thinking });
      this.runtime.thinking = thinking;
    }
    try {
      this.updateStats(sessionStats(await rpc.request('get_session_stats')));
    } catch {}
    assertActive();
    this.runtime.status = 'idle';
    this.runtime.connected = true;
    await this.syncApprovalMode();
    if (state.sessionName !== session.title) await rpc.request('set_session_name', { name: session.title });
    assertActive();
    this.runtime.crash = undefined;
    session.model = this.runtime.model
      ? { provider: this.runtime.model.provider, id: this.runtime.model.id }
      : undefined;
    session.thinking = this.runtime.thinking;
    this.status('idle');
  }
  send(id: string, text: string, attachments: string[], mode: SendMode, images: ImageAttachment[] = []) {
    validateImages(images);
    if (!text.trim() && !images.length) return Promise.reject(new Error('请输入任务内容或添加图片'));
    this.protectSession(id);
    const epoch = this.stopEpoch;
    return this.exclusive(() => this.sendInOperation(id, text, attachments, mode, images, epoch));
  }
  recover(id: string, continuePrompt?: string) {
    this.protectSession(id);
    const epoch = this.stopEpoch;
    return this.exclusive(async () => {
      if (this.runtime.sessionId !== id || !this.runtime.crash || busy(this.runtime.status))
        throw new Error('这个会话没有等待恢复的中断，请使用正常连接或等待当前操作结束');
      if (continuePrompt !== undefined && !continuePrompt.trim())
        throw new Error('请填写继续任务的内容，或选择“重新连接”');
      if (continuePrompt === undefined) await this.ensureConnected(id);
      else await this.sendInOperation(id, continuePrompt, [], 'steer', [], epoch);
    });
  }
  private async sendInOperation(
    id: string,
    text: string,
    attachments: string[],
    mode: SendMode,
    images: ImageAttachment[],
    epoch: number,
  ) {
    this.store.assertWritable();
    if (epoch !== this.stopEpoch) throw new Error('任务已取消，内容保留在草稿中');
    if (this.probing) throw new Error('正在测试模型连接，请稍候');
    validateImages(images);
    if (!text.trim() && !images.length) throw new Error('请输入任务内容或添加图片');
    const session = this.store.session(id),
      project = session.projectId ? this.store.project(session.projectId) : undefined;
    if (busy(this.runtime.status) && this.runtime.sessionId !== id)
      throw new Error('已有会话运行中，请先等待完成或停止');
    if (this.runtime.status === 'stopping') throw new Error('正在停止，请稍候');
    if (!project && attachments.length) throw new Error('引用本地文件需要在项目会话中进行');
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('消息超过 1 MiB，请缩短后发送');
    const prompt = project ? await attachmentPrompt(project, text, attachments) : text;
    const previousRuntime = this.runtime;
    await this.ensureConnected(id);
    // A tool continuation or a queued steer/follow-up is still the same user task.
    if (!busy(this.runtime.status)) await this.applyTaskSelection(id);
    const shellCommand = text.startsWith('!') && text.replace(/^!!?/, '').trim().length > 0;
    if (!this.runtime.model && !text.startsWith('/') && !shellCommand) throw new Error('请选择一个可用模型');
    if (images.length && !this.runtime.model?.input?.includes('image'))
      throw new Error('当前模型未声明图片能力，请切换到支持图片的模型');
    const isActive = busy(this.runtime.status);
    if (isActive && images.length) validateImages([...this.queuedDrafts.flatMap((q) => q.images), ...images]);
    if (shellCommand && isActive) throw new Error('请等待当前任务完成后再执行命令');
    if (!isActive) {
      this.stopRequested = false;
      this.retryCancelled = false;
      this.setError();
      this.runtime.tools = [];
      // A new connection already has a fresh log; retain its startup notifications.
      if (this.runtime === previousRuntime) {
        this.runtime.notices = [];
        this.retryNotice = undefined;
      }
      this.runtime.startedAt = Date.now();
      this.status('starting');
      if (project)
        try {
          if (shellCommand)
            await this.workspace.captureCheckpoint(project, id, await this.workspace.nextCheckpointTurn(id));
          else if (!text.startsWith('/')) await this.checkpointRecorder.prepare(id);
        } catch (error) {
          this.setError(`无法建立本轮快照，任务未开始：${errorText(error)}`);
          this.status(this.stopRequested ? 'stopped' : 'error');
          throw new Error(this.runtime.error, { cause: error });
        }
    }
    if (this.stopRequested || epoch !== this.stopEpoch) throw new Error('任务已取消，内容保留在草稿中');
    try {
      // Persist the pending draft and run state before any command can reach Pi. An asynchronous
      // status save alone can fail after the entry guard but before prompt/bash starts execution.
      await this.store.save();
      if (this.stopRequested || epoch !== this.stopEpoch) throw new Error('任务已取消，内容保留在草稿中');
      let result: any;
      if (shellCommand) {
        if (images.length || attachments.length) throw new Error('终端命令不能附带附件');
        this.status('running');
        this.activity();
        await this.store.flush();
        if (this.stopRequested || epoch !== this.stopEpoch) throw new Error('任务已取消，内容保留在草稿中');
        if (project)
          await this.workspace.beginTool(project, id, 'desktop-bash', 'bash', {
            command: text.replace(/^!!?/, ''),
          });
        this.runtime.tools.push({
          id: 'desktop-bash',
          name: 'bash',
          args: { command: text.replace(/^!!?/, '') },
          status: 'running',
          output: '',
          startedAt: Date.now(),
        });
        const output = await this.rpc!.request(
          'bash',
          { command: text.replace(/^!!?/, ''), excludeFromContext: text.startsWith('!!') },
          3600000,
        );
        if (project) await this.workspace.endTool(project, id, 'desktop-bash');
        const tool = this.runtime.tools.find((t) => t.id === 'desktop-bash')!;
        tool.output = output.output;
        tool.status = output.exitCode === 0 ? 'done' : 'error';
        tool.durationMs = Date.now() - tool.startedAt;
        this.status(output.cancelled ? 'stopped' : output.exitCode === 0 ? 'completed' : 'error');
        await this.refresh();
        await this.syncApprovalMode();
        await this.applyPendingConfiguration();
      } else {
        const matches = this.store.matchesDraft(session, text, attachments, images);
        const draft: QueuedDraft = {
          text: prompt,
          original: matches ? session.draft : text,
          attachments: [...attachments],
          images: structuredClone(images),
          snippets: matches ? structuredClone(session.draftSnippets ?? []) : [],
          mode,
          observed: false,
        };
        this.pendingDraft = draft;
        try {
          result = await this.rpc!.request(
            'prompt',
            {
              message: prompt,
              ...(isActive ? { streamingBehavior: mode } : {}),
              ...(images.length
                ? { images: images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType })) }
                : {}),
            },
            text.startsWith('/') ? 600000 : 30000,
          );
          if (result?.disposition === 'queued' && !draft.observed) this.queuedDrafts.push(draft);
          if (result?.disposition !== 'queued')
            this.queuedDrafts = this.queuedDrafts.filter((item) => item !== draft);
        } finally {
          if (this.pendingDraft === draft) this.pendingDraft = undefined;
        }
      }
      if (result?.disposition === 'handled' && !this.stopRequested) {
        const state = await this.rpc!.request('get_state');
        if (!state.isStreaming && !state.isCompacting && !state.pendingMessageCount) this.status('idle');
      }
      if (this.store.matchesDraft(session, text, attachments, images)) {
        session.draft = '';
        session.attachments = [];
        session.images = [];
        session.draftSnippets = [];
      }
      if (session.title === '新会话' || session.title === '新对话') {
        session.title = text.trim().split('\n')[0].slice(0, 28) || images[0]?.name || '图片对话';
        void this.rpc!.request('set_session_name', { name: session.title }).catch(() => {});
      }
      this.activity();
    } catch (e) {
      this.setError(errorText(e));
      if (!isActive && !this.stopRequested) {
        this.status(this.runtime.crash ? 'interrupted' : 'error');
        this.activity();
      }
      throw e;
    }
  }
  private async loadThinkingLevels(rpc: PiRpc) {
    const levels = await rpc.request('get_available_thinking_levels');
    this.runtime.thinkingLevels = levels.levels;
  }
  setModel(id: string, provider: string, modelId: string) {
    this.protectSession(id);
    return this.preference(async () => {
      const session = this.store.session(id);
      const previous = { model: session.model, thinking: session.thinking, nextTask: this.runtime.nextTask };
      try {
        const rpc = this.rpc;
        if (rpc && !rpc.closed && this.runtime.sessionId === id) {
          if (!this.runtime.models.some((m) => m.provider === provider && m.id === modelId))
            throw new Error('该模型当前不可用，请刷新模型列表');
          const options = await rpc.bridge('task_options', {
            provider,
            modelId,
            thinking: session.thinking ?? this.runtime.thinking ?? 'off',
          });
          session.thinking = options.thinking;
          this.runtime.nextTask = {
            model: this.runtime.models.find((m) => m.provider === provider && m.id === modelId)!,
            thinking: options.thinking,
            thinkingLevels: options.thinkingLevels,
          };
        } else {
          await this.exclusive(() =>
            this.readModelCatalog(id, { provider, id: modelId }, session.thinking ?? this.runtime.thinking),
          );
          session.thinking = this.runtime.thinking;
        }
        session.model = { provider, id: modelId };
        if (!busy(this.runtime.status))
          await this.exclusive(async () => {
            if (!busy(this.runtime.status)) await this.applyTaskSelection(id);
          });
      } catch (error) {
        session.model = previous.model;
        session.thinking = previous.thinking;
        this.runtime.nextTask = previous.nextTask;
        this.save();
        this.publish(true);
        throw error;
      }
      this.store.state.settings.provider = provider;
      this.store.state.settings.modelId = modelId;
      this.clearUnchangedSelection();
      this.save();
      this.publish(true);
    });
  }
  setThinking(id: string, level: string) {
    this.protectSession(id);
    return this.preference(async () => {
      const session = this.store.session(id);
      const previous = { thinking: session.thinking, nextTask: this.runtime.nextTask };
      try {
        const rpc = this.rpc;
        if (rpc && !rpc.closed && this.runtime.sessionId === id) {
          const levels = this.runtime.nextTask?.thinkingLevels ?? this.runtime.thinkingLevels;
          if (!levels.includes(level)) throw new Error('所选模型不支持这个推理级别');
          if (this.runtime.model)
            this.runtime.nextTask = {
              model: this.runtime.nextTask?.model ?? this.runtime.model,
              thinking: level,
              thinkingLevels: levels,
            };
        } else if (this.runtime.sessionId === id && this.runtime.models.length) {
          if (!this.runtime.thinkingLevels.includes(level)) throw new Error('所选模型不支持这个推理级别');
          this.runtime.thinking = level;
        }
        session.thinking = level;
        if (!busy(this.runtime.status))
          await this.exclusive(async () => {
            if (!busy(this.runtime.status)) await this.applyTaskSelection(id);
          });
      } catch (error) {
        session.thinking = previous.thinking;
        this.runtime.nextTask = previous.nextTask;
        this.save();
        this.publish(true);
        throw error;
      }
      this.store.state.settings.thinking = level;
      this.clearUnchangedSelection();
      this.save();
      this.publish(true);
    });
  }
  private clearUnchangedSelection() {
    const next = this.runtime.nextTask;
    if (
      next &&
      next.model.provider === this.runtime.model?.provider &&
      next.model.id === this.runtime.model?.id &&
      next.thinking === this.runtime.thinking
    )
      this.runtime.nextTask = undefined;
  }
  private async applyTaskSelection(id: string) {
    const rpc = this.rpc;
    if (!rpc || rpc.closed || this.runtime.sessionId !== id) return;
    const session = this.store.session(id);
    const model = session.model;
    if (model && (model.provider !== this.runtime.model?.provider || model.id !== this.runtime.model?.id)) {
      this.runtime.model = displayModel(
        await rpc.request('set_model', { provider: model.provider, modelId: model.id }),
      );
      await this.loadThinkingLevels(rpc);
    }
    if (session.thinking && session.thinking !== this.runtime.thinking) {
      await rpc.request('set_thinking_level', { level: session.thinking });
    }
    const state = await rpc.request('get_state');
    this.runtime.model = displayModel(state.model);
    this.runtime.thinking = state.thinkingLevel;
    this.runtime.nextTask = undefined;
    session.thinking = state.thinkingLevel;
    this.publish(true);
  }
  async setApprovalMode(id: string, mode: ApprovalMode) {
    if (!['auto', 'confirm', 'readonly'].includes(mode)) throw new Error('审批模式无效');
    this.store.promoteSession(id).approvalMode = mode;
    this.save();
    if (this.runtime.sessionId === id) await this.preference(() => this.syncApprovalMode());
    this.publish(true);
  }
  private async syncApprovalMode() {
    const rpc = this.rpc;
    const id = this.runtime.sessionId;
    if (!rpc || rpc.closed || !id || !this.runtime.connected) return;
    // Read the current session's saved choice, including changes made before a stop or reconnect.
    const mode = this.store.session(id).approvalMode ?? 'auto';
    if (this.runtime.approvalMode === mode) return;
    const result = await rpc.bridge('approval_mode', { mode });
    if (this.rpc === rpc && this.runtime.sessionId === id) {
      this.runtime.approvalMode = result.approvalMode;
      this.runtime.approvalGrants = result.approvalGrants;
      this.publish(true);
    }
  }
  async abortRetry() {
    if (!this.rpc || this.rpc.closed || !this.runtime.retry) return;
    // Pi's abort_retry only cancels backoff. Use the normal stop path for both phases:
    // the next request may start while the cancellation command is being delivered.
    return this.stop();
  }
  async revokeApproval(id: string, grantId?: string) {
    this.store.assertWritable();
    this.store.session(id);
    const rpc = this.rpc;
    if (!rpc || rpc.closed || this.runtime.sessionId !== id || !this.runtime.connected || this.connecting)
      throw new Error('请先连接这个会话，再撤回授权');
    const result = await rpc.bridge('revoke_approval', grantId === undefined ? {} : { id: grantId });
    if (this.rpc === rpc && this.runtime.sessionId === id) {
      this.runtime.approvalGrants = result.approvalGrants;
      this.publish(true);
    }
  }
  private async entryFor(rpc: PiRpc, role: string, timestamp: number) {
    const { entries = [], leafId } = await rpc.request('get_entries');
    const byId = new Map<string, any>(entries.map((e: any) => [e.id, e]));
    const branch: any[] = [];
    for (let e = byId.get(leafId); e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.push(e);
    const index = branch.findIndex(
      (e) => e.type === 'message' && e.message?.role === role && e.message?.timestamp === timestamp,
    );
    if (index < 0) throw new Error('这条消息不在当前分支上，请在会话树中切换后再试');
    const userIndex =
      role === 'user' ? index : branch.findIndex((e, i) => i > index && e.message?.role === 'user');
    if (userIndex < 0) throw new Error('找不到这条回复对应的提问');
    return branch[userIndex];
  }
  async messageAction(id: string, action: MessageAction, role: string, timestamp: number) {
    if (action === 'fork') {
      const entry = await this.readTask(id, (rpc) => this.entryFor(rpc, role, timestamp));
      return this.branch(id, 'fork', entry.id);
    }
    const restored = await this.idleTask(
      id,
      async (rpc) => {
        const entry = await this.entryFor(rpc, role, timestamp);
        const content = entry.message.content;
        const text = typeof content === 'string' ? content : messageText(entry.message);
        const images: ImageAttachment[] = (Array.isArray(content) ? content : [])
          .filter((b: any) => b.type === 'image' && typeof b.data === 'string')
          .map((b: any, i: number) => ({
            id: randomUUID(),
            name: `历史图片 ${i + 1}`,
            data: b.data,
            mimeType: b.mimeType,
          }));
        const result = await rpc.bridge('navigate', {
          entryId: entry.id,
          summarize: false,
          instructions: '',
        });
        if (result?.cancelled) throw new Error('Pi 扩展取消了这次操作');
        // Tools from the abandoned branch must not be rendered as unpersisted live work.
        this.runtime.tools = [];
        return { text, images };
      },
      true,
    );
    const session = this.store.session(id);
    if (action === 'regenerate') return this.send(id, restored.text, [], 'steer', restored.images);
    session.draft = splitUserContent(restored.text).text;
    session.draftSnippets = [];
    session.attachments = [];
    session.images = restored.images;
    await this.store.save();
    this.publish(true);
    this.emit('state', this.store.state);
  }
  async clearQueue() {
    if (!this.rpc || this.rpc.closed) return;
    const queuedDrafts = [...this.queuedDrafts];
    const result = await this.rpc.request('clear_queue');
    const returned = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
    this.restoreQueuedDrafts(returned, queuedDrafts);
    this.runtime.steering = [];
    this.runtime.followUp = [];
    this.queuedDrafts = [];
    // Stopping remains available even after disk failure; recovered drafts remain visible in memory.
    await this.store.save().catch((error) => this.diagnostic(errorText(error)));
    this.emit('state', this.store.state);
    this.publish(true);
  }
  private restoreQueuedDrafts(returned: string[], queuedDrafts: QueuedDraft[]) {
    if (!returned.length || !this.runtime.sessionId) return;
    const session = this.store.session(this.runtime.sessionId);
    const selectedId = this.store.state.selectedSessionId;
    // clear_queue returns steering first, followed by follow-ups. Match each occurrence once.
    const candidates = [...queuedDrafts].sort(
      (a, b) => Number(a.mode === 'followUp') - Number(b.mode === 'followUp'),
    );
    for (const expanded of returned) {
      const index = candidates.findIndex((draft) => draft.text === expanded);
      const draft = index < 0 ? undefined : candidates.splice(index, 1)[0];
      const text = draft?.original ?? splitUserContent(expanded).text;
      const attachments = [...new Set([...session.attachments, ...(draft?.attachments ?? [])])];
      const separator =
        (session.draft || session.draftSnippets?.length) && (text || draft?.snippets.length) ? '\n\n' : '';
      const offset = session.draft.length + separator.length;
      try {
        if (
          attachments.length > 20 ||
          Buffer.byteLength(
            composeDraftText(session.draft, session.draftSnippets ?? []) +
              separator +
              composeDraftText(text, draft?.snippets ?? []),
            'utf8',
          ) >
            1024 * 1024
        )
          throw new Error('草稿容量不足');
        this.store.appendDraftImages(session, draft?.images ?? []);
        session.draft += separator + text;
        session.attachments = attachments;
        session.draftSnippets = [
          ...(session.draftSnippets ?? []),
          ...(draft?.snippets ?? []).map((snippet) => ({
            ...snippet,
            id: randomUUID(),
            offset: offset + snippet.offset,
          })),
        ];
      } catch {
        const recovered = this.store.createSession(session.projectId);
        if (!session.projectId) recovered.cwd = this.runtime.cwd;
        recovered.title = draft?.images.length ? '已恢复的图片消息' : '已恢复的待发送消息';
        recovered.draft = text;
        recovered.images = draft?.images ?? [];
        recovered.attachments = draft?.attachments ?? [];
        recovered.draftSnippets = draft?.snippets ?? [];
        this.runtime.notices.push('未发送的消息已保存在新的恢复会话中。');
      }
    }
    if (selectedId) this.store.selectSession(selectedId);
  }
  private async refreshCapabilities() {
    if (!this.rpc || this.rpc.closed) return;
    this.runtime.commands = await Promise.all(
      ((await this.rpc.request('get_commands')).commands ?? [])
        .filter((c: any) => c.name !== DESKTOP_BRIDGE_COMMAND)
        .map(async (c: any) =>
          c.source === 'prompt' && c.sourceInfo?.path
            ? { ...c, argumentHint: await argumentHint(c.sourceInfo.path) }
            : c,
        ),
    );
    this.runtime.models = ((await this.rpc.request('get_available_models')).models ?? [])
      .map(displayModel)
      .filter((model): model is Model => Boolean(model));
    this.runtime.modelsLoaded = true;
    const options = await this.rpc.bridge('options');
    this.runtime.autoRetry = options.autoRetry;
    this.runtime.approvalMode = options.approvalMode ?? 'auto';
    this.runtime.approvalGrants = options.approvalGrants;
  }
  private idleTask<T>(id: string, action: (rpc: PiRpc) => Promise<T>, changesContent = false): Promise<T> {
    this.protectSession(id);
    return this.exclusive(async () => {
      await this.ensureConnected(id);
      if (busy(this.runtime.status)) throw new Error('请先等待当前任务结束');
      this.stopRequested = false;
      this.setError();
      this.status('starting');
      let changed = false;
      try {
        const result = await action(this.rpc!);
        changed = changesContent;
        return result;
      } finally {
        this.clearDialogs();
        try {
          if (!this.stopRequested && this.runtime.connected) {
            this.status('idle');
            await this.refresh();
            await this.applyPendingConfiguration();
          }
        } finally {
          // Selection can change while the operation or its final refresh is awaiting Pi.
          if (changed) this.activity();
        }
      }
    });
  }
  private async readTask<T>(id: string, action: (rpc: PiRpc) => Promise<T>): Promise<T> {
    this.protectSession(id);
    await this.beforeConnect?.('read');
    this.reading++;
    this.pendingOperations++;
    try {
      if (!this.rpc || this.rpc.closed || this.runtime.sessionId !== id) await this.connect(id);
      return await action(this.rpc!);
    } finally {
      this.reading--;
      this.pendingOperations--;
      if (!this.reading && this.runtime.configurationPending && !busy(this.runtime.status))
        void this.exclusive(() => this.applyPendingConfiguration()).catch((error) =>
          this.diagnostic(errorText(error)),
        );
    }
  }
  async scheduleReload() {
    if (!this.runtime.connected && !this.connecting) return true;
    this.runtime.configurationPending = true;
    this.publish(true);
    // Do not queue a resource reload behind a long-running manual compaction.
    if (
      busy(this.runtime.status) ||
      this.connecting ||
      this.probing ||
      this.reading ||
      this.preferring ||
      this.runtime.dialogs.length ||
      this.unsafeExit
    )
      return false;
    return this.exclusive(() => this.applyPendingConfiguration());
  }
  private async applyPendingConfiguration() {
    if (this.shutdown || this.reloadSuspended) return false;
    if (!this.runtime.configurationPending) return true;
    if (
      busy(this.runtime.status) ||
      this.runtime.dialogs.length ||
      this.connecting ||
      this.probing ||
      this.reading ||
      this.preferring ||
      this.unsafeExit
    )
      return false;
    const id = this.runtime.sessionId!;
    const status = this.runtime.status;
    const epoch = this.stopEpoch;
    const rpc = this.rpc;
    this.rpc = undefined;
    await rpc?.close();
    this.runtime.connected = false;
    this.runtime.configurationPending = undefined;
    try {
      await this.ensureConnected(id);
      this.status(status);
      return true;
    } catch (error) {
      this.runtime.configurationPending = true;
      if (epoch === this.stopEpoch) this.status(status);
      this.notify(`配置已保存，加载失败：${errorText(error)}。可修正配置后重新连接。`, 'warning');
      throw error;
    }
  }
  tree(id: string): Promise<TreeEntry[]> {
    return this.readTask(id, (rpc) => rpc.bridge('tree'));
  }
  branch(
    id: string,
    kind: 'fork' | 'clone' | 'navigate',
    entryId?: string,
    summarize = false,
    instructions = '',
  ) {
    if (kind !== 'navigate') return this.forkCopy(id, kind, entryId);
    return this.idleTask(
      id,
      async (rpc) => {
        const result = await rpc.bridge('navigate', { entryId, summarize, instructions });
        if (result?.cancelled) throw new Error('Pi 扩展取消了这次操作');
        this.runtime.tools = [];
      },
      true,
    );
  }
  private async forkCopy(id: string, kind: 'fork' | 'clone', entryId?: string) {
    const old = this.store.session(id);
    const result = await this.readTask(id, (rpc) => rpc.bridge('fork_copy', { kind, entryId }));
    const next = this.store.createSession(old.projectId);
    next.file = result.file;
    if (!next.projectId) next.cwd = await this.store.sessionDirectory(id);
    next.title = old.title + (kind === 'fork' ? ' · 分支' : ' · 副本');
    next.model = old.model ? { ...old.model } : undefined;
    next.thinking = old.thinking;
    next.approvalMode = old.approvalMode;
    if (result.message) {
      next.draft = splitUserContent(messageText(result.message)).text;
      next.images = (Array.isArray(result.message.content) ? result.message.content : [])
        .filter((b: any) => b.type === 'image')
        .map((b: any, i: number) => ({
          id: randomUUID(),
          name: `历史图片 ${i + 1}`,
          data: b.data,
          mimeType: b.mimeType,
        }));
    }
    await this.store.save();
    this.emit('state', this.store.state);
  }
  compact(id: string, customInstructions: string) {
    return this.readTask(id, async (rpc) => {
      if (busy(this.runtime.status)) throw new Error('本会话正在执行任务，请停止后再手动压缩');
      this.status('compacting');
      try {
        return await rpc.request('compact', { customInstructions }, 600000);
      } finally {
        if (!this.stopRequested) this.status('idle');
        await this.exclusive(() => this.applyPendingConfiguration());
      }
    });
  }
  option(id: string, key: string, value: boolean | string) {
    const command = {
      autoCompaction: 'set_auto_compaction',
      autoRetry: 'set_auto_retry',
      steeringMode: 'set_steering_mode',
      followUpMode: 'set_follow_up_mode',
    }[key];
    if (!command) throw new Error('未知 Pi 设置');
    if (key.endsWith('Mode') ? !['all', 'one-at-a-time'].includes(String(value)) : typeof value !== 'boolean')
      throw new Error('设置值无效');
    return this.readTask(id, async (rpc) => {
      await rpc.request(command, key.endsWith('Mode') ? { mode: value } : { enabled: value });
      await this.refresh();
      await this.refreshCapabilities();
    });
  }
  admin(id: string, method: string, params: unknown = {}) {
    const task = ['tree', 'resources', 'providers', 'options', 'set_label'].includes(method)
      ? this.readTask.bind(this)
      : this.idleTask.bind(this);
    return task(id, async (rpc) => {
      const result = await rpc.bridge(method, params);
      if (['login', 'logout', 'reload'].includes(method)) await this.refreshCapabilities();
      return result;
    });
  }
  async cancelLogin() {
    await this.rpc?.bridge('cancel_auth');
  }
  exportHtml(id: string, outputPath: string) {
    return this.readTask(id, (rpc) => rpc.request('export_html', { outputPath }, 120000));
  }
  async captureExport(id: string, format: 'html' | 'jsonl', temporary: string): Promise<Buffer> {
    const session = this.store.session(id);
    const file = session.file;
    if (!file) throw new Error('会话尚未产生可导出的内容');
    const runtime = this.runtime;
    const isFreshEmpty = () =>
      this.runtime === runtime &&
      runtime.sessionId === id &&
      runtime.connected &&
      !busy(runtime.status) &&
      !runtime.messages.length &&
      session.file === file &&
      this.freshSessionFile === file;
    const freshEmpty = isFreshEmpty();
    const current = runtime.sessionId === id && busy(runtime.status);
    const message = current ? structuredClone(runtime.messages.at(-1)) : undefined;
    const output = current
      ? runtime.tools
          .filter((tool) => tool.status === 'running' && tool.output)
          .map((tool) => ({ name: tool.name, output: tool.output }))
      : [];
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && freshEmpty && isFreshEmpty())
        throw new Error('会话尚未产生可导出的内容', { cause: error });
      throw error;
    }
    if (this.runtime === runtime && this.freshSessionFile === file) this.freshSessionFile = undefined;
    const entries = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const partial =
      message?.role === 'assistant' &&
      !entries.some(
        (entry) => entry.message?.role === 'assistant' && entry.message?.timestamp === message.timestamp,
      )
        ? message
        : undefined;
    if (format === 'jsonl') {
      let parentId = entries.at(-1)?.id ?? null;
      const append = (entry: object) => {
        const id = randomUUID().slice(0, 8);
        entries.push({ ...entry, id, parentId, timestamp: new Date().toISOString() });
        parentId = id;
      };
      if (partial)
        append({
          type: 'message',
          message: {
            ...partial,
            stopReason: 'aborted',
            errorMessage: '导出快照：此回复在导出时尚未完成，原任务继续运行。',
          },
        });
      if (output.length) append({ type: 'custom', customType: 'desktop-export-output', data: output });
      return Buffer.from(entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    }
    await this.exportHtml(id, temporary);
    let html = await fs.readFile(temporary, 'utf8');
    const live = [partial && messageText(partial), ...output.map((tool) => `[${tool.name}]\n${tool.output}`)]
      .filter(Boolean)
      .join('\n\n');
    if (live) {
      const escaped = live.replace(
        /[&<>"']/g,
        (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
      );
      html = html.replace(
        '</body>',
        `<section style="padding:24px"><h2>导出时尚未完成的输出</h2><p>以下内容固定于导出时，原任务继续运行。</p><pre style="white-space:pre-wrap">${escaped}</pre></section></body>`,
      );
    }
    return Buffer.from(html);
  }
  async rename(id: string, name: string) {
    this.protectSession(id);
    if (this.runtime.sessionId === id && this.runtime.connected)
      await this.rpc!.request('set_session_name', { name });
  }
  async stop() {
    if (!busy(this.runtime.status) && !this.modelReader) return;
    const wasConnecting = this.connecting || Boolean(this.modelReader);
    this.stopEpoch++;
    this.stopRequested = true;
    this.runtime.stopStartedAt = Date.now();
    this.status('stopping');
    if (this.modelReader) {
      await this.modelReader.killTree();
      this.clearDialogs();
      this.status('stopped');
      return;
    }
    if (!this.rpc || this.rpc.closed) {
      this.status('stopped');
      if (!wasConnecting) this.activity();
      return;
    }
    const rpc = this.rpc;
    try {
      if (this.runtime.auth) await this.cancelLogin();
      for (const dialog of [...this.runtime.dialogs])
        await this.respond(dialog.id, { cancelled: true }).catch(() => {});
      try {
        await this.clearQueue();
        if (!rpc.closed) await rpc.request('abort_bash');
        if (!rpc.closed) await rpc.request('abort', {}, 60000);
      } catch (error) {
        // A cancelled startup/reload can close this process while stop is awaiting its response.
        // closeRpc detaches it before the exit event: finish that close before
        // interpreting a rejected abort as a failure to stop.
        if (wasConnecting && this.rpc !== rpc && !rpc.closed) await rpc.close();
        if (!rpc.closed) throw error;
        await this.crashCleanup;
        this.assertCommandsStopped();
      }
      if (!rpc.closed) {
        const state = await rpc.request('get_state');
        if (state.isStreaming || state.isCompacting || state.pendingMessageCount)
          throw new Error('Pi 尚未停止，请重试或强制结束');
      }
      this.clearDialogs();
      if (this.runtime.sessionId)
        await this.checkpointRecorder
          .finish(this.runtime.sessionId)
          .catch((error) => this.diagnostic(errorText(error)));
      this.status('stopped');
      if (!wasConnecting) this.activity();
      this.activeWriteTargets.clear();
      await this.refresh();
      await this.exclusive(async () => {
        await this.syncApprovalMode().catch((error) => this.diagnostic(errorText(error)));
        await this.applyPendingConfiguration().catch((error) => this.diagnostic(errorText(error)));
      });
    } catch (e) {
      this.setError(`停止未完成：${errorText(e)}`);
      this.publish(true);
      throw e;
    }
  }
  async forceStop() {
    const wasRunning = busy(this.runtime.status) && !this.connecting;
    this.stopEpoch++;
    this.stopRequested = true;
    await this.modelReader?.killTree();
    await this.rpc?.killTree();
    this.activeWriteTargets.clear();
    if (this.runtime.sessionId)
      await this.checkpointRecorder
        .finish(this.runtime.sessionId)
        .catch((error) => this.diagnostic(errorText(error)));
    this.runtime.connected = false;
    this.clearDialogs();
    this.status('stopped');
    if (wasRunning) this.activity();
  }
  private async closeRpc() {
    const rpc = this.rpc;
    this.rpc = undefined;
    this.runtime.connected = false;
    try {
      await rpc?.close();
    } catch (error) {
      if (rpc && !rpc.closed) this.rpc = rpc;
      this.setError('Pi 进程尚未确认退出，重新连接前会重试关闭。' + errorText(error));
      this.publish(true);
      throw error;
    }
  }
  async disconnect() {
    await this.crashCleanup;
    this.assertCommandsStopped();
    if (this.connecting || this.pendingOperations > 0)
      throw new Error('正在处理会话操作，请等待完成后再断开或修改运行环境。');
    if (busy(this.runtime.status) || this.probing) throw new Error('请先等待当前任务或连接测试结束');
    await this.closeRpc();
    this.invalidateModels();
  }
  /** Serialize idle teardown with sends/connects, so a new request can safely reconnect. */
  releaseIdleProcess() {
    if (this.hasPendingWork) return Promise.resolve(false);
    return this.exclusive(async () => {
      if (
        this.pendingOperations > 1 ||
        this.requiresStopConfirmation ||
        this.runtime.configurationPending ||
        this.runtime.auth ||
        this.runtime.steering.length ||
        this.runtime.followUp.length
      )
        return false;
      await this.closeRpc();
      this.publish(true);
      return true;
    });
  }
  async testConnection(sessionId: string) {
    const epoch = this.stopEpoch;
    this.assertCommandsStopped();
    this.store.assertWritable();
    if (busy(this.runtime.status) || this.probing) throw new Error('请先等待当前任务结束');
    const session = this.protectSession(sessionId);
    const cwd = await this.store.sessionDirectory(session.id);
    if (this.shutdown || epoch !== this.stopEpoch) throw new Error('模型连接测试已取消');
    const settings = this.store.state.settings;
    const model = session.model ?? this.runtime.model;
    const provider = model?.provider || settings.provider,
      modelId = model?.id || settings.modelId;
    if (!provider || !modelId) throw new Error('请先连接 Pi 并选择模型');
    this.probing = true;
    const probe = new PiRpc();
    this.probe = probe;
    const started = Date.now();
    let answer = '';
    let failure = '';
    let timer: NodeJS.Timeout | undefined;
    try {
      const { resolved } = await preparePi(settings, this.developmentRoot);
      // A concurrent draft/model save may have promoted this ID before this
      // request arrived. Probe startup must observe that queued write as well.
      await this.store.flush();
      this.store.assertWritable();
      if (this.shutdown || epoch !== this.stopEpoch) throw new Error('模型连接测试已取消');
      const settled = new Promise<void>((resolve, reject) => {
        probe.on('event', (e) => {
          if (e.type === 'message_end' && e.message?.role === 'assistant') {
            answer = messageText(e.message);
            if (e.message.stopReason === 'error') failure = e.message.errorMessage ?? '模型连接失败';
          }
          if (e.type === 'agent_settled') {
            if (failure) reject(new Error(failure));
            else resolve();
          }
        });
        probe.on('fault', reject);
        probe.on('exit', () => reject(new Error('连接测试进程已退出')));
      });
      settled.catch(() => {});
      probe.start(
        resolved.spec,
        cwd,
        [
          '--mode',
          'rpc',
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-mcp',
          '--no-skills',
          '--no-context-files',
          '--no-prompt-templates',
          '--no-approve',
          '--provider',
          provider,
          '--model',
          modelId,
        ],
        { PI_CODING_AGENT_DIR: agentDirectory(settings), PI_TELEMETRY: '0' },
      );
      timer = setTimeout(() => {
        failure = '模型连接测试超过 45 秒';
        void probe.killTree().catch(() => {});
      }, 45000);
      await probe.request('get_state');
      await probe.request('prompt', { message: 'Reply with only OK.' });
      await settled;
      return { elapsed: Date.now() - started, text: answer };
    } finally {
      if (timer) clearTimeout(timer);
      await probe.close();
      this.probe = undefined;
      this.probing = false;
      if (this.runtime.configurationPending)
        void this.exclusive(() => this.applyPendingConfiguration()).catch((error) =>
          this.diagnostic(errorText(error)),
        );
    }
  }
  output() {
    return (
      'Pi Desktop 导出：当前会话已接收的工具结果（最多最近 10 MiB）。Pi 自身可能截断长输出，完整日志位置以工具结果为准。\n\n' +
      stripAnsi(this.fullOutput || this.runtime.tools.map((t) => `[${t.name}]\n${t.output}`).join('\n\n'))
    );
  }
  async history(id: string): Promise<Message[]> {
    const s = this.store.session(id);
    const live = this.runtime.sessionId === id ? this.runtime.messages : [];
    if (busy(this.runtime.status) && this.runtime.sessionId === id && !(this.connecting && !live.length))
      return live;
    return this.readTranscript(s.file, live, id);
  }
  async dispose() {
    this.shutdown = true;
    this.stopEpoch++;
    this.stopRequested = true;
    if (this.publishing) clearTimeout(this.publishing);
    await this.modelReader?.close();
    await this.probe?.close();
    if (busy(this.runtime.status)) {
      await this.stop().catch(() => {});
    }
    await this.settingsOperation;
    await this.operation;
    this.clearDialogs();
    await this.rpc?.close();
    await this.store.flush().catch((e) => this.diagnostic(errorText(e)));
  }
}
