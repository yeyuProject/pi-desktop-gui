import { randomUUID } from 'node:crypto';
import type { AppDialog } from '../shared/app-dialogs';

export interface DialogOptions {
  message: string;
  detail?: string;
  buttons?: string[];
  cancelId?: number;
  defaultId?: number;
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
}

/** Main owns every request. Losing a renderer never grants confirmation. */
export class AppDialogRequests {
  private pending = new Map<string, { resolve: (value: { response: number }) => void; dialog: AppDialog }>();

  constructor(private publish: (dialog: AppDialog) => void) {}

  get size() {
    return this.pending.size;
  }

  show(options: DialogOptions) {
    const buttons = [...(options.buttons ?? ['知道了'])];
    const cancelId = options.cancelId ?? 0;
    if (!buttons.length || !Number.isInteger(cancelId) || cancelId < 0 || cancelId >= buttons.length)
      throw new Error('无效对话框选项');
    const dialog: AppDialog = {
      id: randomUUID(),
      message: options.message,
      detail: options.detail,
      buttons,
      cancelId,
    };
    return new Promise<{ response: number }>((resolve) => {
      this.pending.set(dialog.id, { resolve, dialog });
      try {
        this.publish(dialog);
      } catch {
        this.respond(dialog.id, cancelId);
      }
    });
  }

  respond(id: string, response: number) {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (!Number.isInteger(response) || response < 0 || response >= pending.dialog.buttons.length)
      throw new Error('无效对话框回复');
    this.pending.delete(id);
    pending.resolve({ response });
  }

  cancelAll() {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const { resolve, dialog } of requests) resolve({ response: dialog.cancelId });
  }
}
