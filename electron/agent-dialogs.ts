import { APPROVAL_DENY, APPROVAL_PREFIX } from '../shared/approval';
import type { ApprovalRequest, Runtime, RunStatus } from '../shared/types';
import type { PiRpc } from './rpc';

interface DialogContext {
  runtime: () => Runtime;
  rpc: () => PiRpc | undefined;
  resumeStatus: () => RunStatus;
  status: (status: RunStatus) => void;
  publish: () => void;
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
    if (waiting) this.context.status('waiting');
    if (record.timeout)
      this.timers.set(
        record.id,
        setTimeout(() => {
          r.dialogs = r.dialogs.filter((d) => d.id !== record.id);
          this.timers.delete(record.id);
          if (r.status === 'waiting') this.context.status(this.context.resumeStatus());
          this.context.publish();
        }, record.timeout),
      );
  }

  async respond(id: string, values: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const d = this.context.runtime().dialogs.find((d) => d.id === id);
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
    await this.context.rpc()?.write({ type: 'extension_ui_response', id, ...values });
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const r = this.context.runtime();
    r.dialogs = r.dialogs.filter((d) => d.id !== id);
    if (r.status === 'waiting' && !r.dialogs.length) this.context.status(this.context.resumeStatus());
    this.context.publish();
  }
}
