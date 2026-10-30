import { APPROVAL_DENY, APPROVAL_PREFIX } from '../shared/approval';
import { validateAskRequest, validateAskAnswer, type AskRequest } from '../shared/ask';
import { DESKTOP_ASK_PREFIX } from '../shared/pi-bridge';
import type { ApprovalRequest, Runtime, RunStatus, ExtensionResponse } from '../shared/types';
import type { PiRpc } from './rpc';

interface DialogContext {
  runtime: () => Runtime;
  rpc: () => PiRpc | undefined;
  resumeStatus: () => RunStatus;
  status: (status: RunStatus) => void;
  publish: () => void;
  diagnostic: (message: string) => void;
}

/** Approval and extension dialogs share expiry, response validation and timer cleanup. */
export class AgentDialogs {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private context: DialogContext) {}

  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.context.runtime().dialogs = [];
  }

  show(record: any, waiting: boolean) {
    const r = this.context.runtime();
    const expiresAt = record.timeout ? Date.now() + record.timeout : undefined;
    let ask: AskRequest | undefined;
    if (record.method === 'input' && String(record.title ?? '').startsWith(DESKTOP_ASK_PREFIX)) {
      try {
        if (!waiting) throw new Error('会话不再接受问题');
        const request: unknown = JSON.parse(String(record.title).slice(DESKTOP_ASK_PREFIX.length));
        validateAskRequest(request);
        ask = request;
      } catch (error) {
        this.context.diagnostic(
          `Invalid desktop question: ${error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'unknown'}`,
        );
        void this.context
          .rpc()
          ?.write({ type: 'extension_ui_response', id: record.id, cancelled: true })
          .catch((error: unknown) => this.context.diagnostic(String(error)));
        return;
      }
    }
    let approval: ApprovalRequest | undefined;
    if (record.method === 'select' && String(record.title ?? '').startsWith(APPROVAL_PREFIX)) {
      try {
        approval = JSON.parse(String(record.title).slice(APPROVAL_PREFIX.length));
      } catch {}
    }
    r.dialogs.push(
      ask
        ? { id: record.id, method: 'input', title: 'Pi 需要你决定', ask, expiresAt }
        : approval
          ? { ...record, title: `允许 ${approval.toolName}？`, approval, expiresAt }
          : { ...record, expiresAt },
    );
    if (waiting) this.context.status('waiting');
    if (record.timeout)
      this.timers.set(
        record.id,
        setTimeout(() => {
          r.dialogs = r.dialogs.filter((d) => d.id !== record.id);
          this.timers.delete(record.id);
          if (r.status === 'waiting' && !r.dialogs.length) this.context.status(this.context.resumeStatus());
          this.context.publish();
        }, record.timeout),
      );
  }

  async respond(id: string, values: ExtensionResponse) {
    const r = this.context.runtime();
    const rpc = this.context.rpc();
    const d = r.dialogs.find((d) => d.id === id);
    if (!d || (d.expiresAt && Date.now() >= d.expiresAt && !values.cancelled))
      throw new Error('这个问题已失效');
    if (!rpc) throw new Error('会话连接已断开，这个问题已失效。');
    if (d.ask) {
      if (
        values.value !== undefined ||
        values.confirmed ||
        [values.ask !== undefined, values.skipped === true, values.cancelled === true].filter(Boolean)
          .length !== 1
      )
        throw new Error('请提交回答、跳过或取消，不能同时执行多个操作。');
      if (values.ask !== undefined) {
        validateAskAnswer(d.ask, values.ask);
        if (values.ask.status !== 'answered') throw new Error('请通过对应按钮跳过或取消问题。');
        values = { value: JSON.stringify(values.ask) };
      } else if (values.skipped) values = { value: JSON.stringify({ status: 'skipped' }) };
      // Stop sends the UI response before Pi processes the abort command. Preserve
      // an explicit cancellation so a simultaneous deadline cannot select defaults.
      else values = { value: JSON.stringify({ status: 'cancelled' }) };
    } else if (values.ask !== undefined || values.skipped !== undefined) {
      throw new Error('这个对话框不是模型提问，请使用它自己的选项。');
    }
    const denyWithReason = d.approval && values.value?.startsWith(APPROVAL_DENY + '：');
    if (
      d.method === 'select' &&
      !values.cancelled &&
      !denyWithReason &&
      !d.options?.includes(values.value ?? '')
    )
      throw new Error('请选择有效选项');
    if (denyWithReason) values = { value: values.value!.slice(0, APPROVAL_DENY.length + 1 + 2000) };
    await rpc.write({ type: 'extension_ui_response', id, ...values });
    if (this.context.runtime() !== r || this.context.rpc() !== rpc) return;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    r.dialogs = r.dialogs.filter((d) => d.id !== id);
    if (r.status === 'waiting' && !r.dialogs.length) this.context.status(this.context.resumeStatus());
    this.context.publish();
  }
}
