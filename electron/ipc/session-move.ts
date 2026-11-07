import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { describeOperationError as readableError } from '../../shared/errors';
import type { HandlerContext } from './handler-context';

type Context = Pick<HandlerContext, 'store' | 'service' | 'workspace' | 'send' | 'showAppDialog' | 'text'> & {
  assertTerminalClosed: (id: string) => Promise<void>;
  getSideFlight: () => { sessionId: string } | undefined;
};

export function createSessionMoveHandlers(context: Context) {
  const { store, service, workspace, send, showAppDialog, assertTerminalClosed, getSideFlight } = context;
  const previews = new Map<string, { id: string; target: string | null; signature: string }>();
  const moving = new Set<string>();
  const trash = process.platform === 'darwin' ? '废纸篓' : '回收站';
  async function inspect(id: string, target: string | null) {
    context.text(id, 100);
    if (target !== null) context.text(target, 100);
    store.assertWritable();
    await assertTerminalClosed(id);
    const session = store.session(id);
    if (session.team || store.state.sessions.some((s) => s.team?.leadId === id))
      throw new Error('团队会话暂不支持移动');
    const agent = service.get(id);
    if (service.active(id)) throw new Error('任务进行中，结束后才能移动');
    if (agent.runtime.dialogs.length) throw new Error('有待处理的确认，处理后才能移动');
    if (getSideFlight()?.sessionId === id || agent.sideChatRunning)
      throw new Error('侧边对话正在回答，结束后才能移动');
    if ((session.projectId ?? null) === target) throw new Error('会话已在这个分组中，请选择其他项目');
    const project = target === null ? undefined : store.project(target);
    const cwd = project?.path ?? path.join(store.dir, 'chats', 'chat-' + encodeURIComponent(id));
    if (project) {
      try {
        if (!(await fs.stat(cwd)).isDirectory()) throw new Error('不是文件夹');
        await fs.access(cwd, fs.constants.R_OK);
      } catch (cause) {
        throw new Error(`项目文件夹 ${cwd} 不存在或无法访问，请检查后重试`, { cause });
      }
    }
    if (session.file) {
      try {
        await fs.access(session.file);
      } catch (cause) {
        throw new Error('会话文件已不存在，无法移动', { cause });
      }
    }
    const attachments: string[] = [];
    if (project) {
      for (const file of session.attachments) {
        const resolved = path.resolve(cwd, file);
        const relative = path.relative(cwd, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if (
          await fs.stat(resolved).then(
            (s) => s.isFile(),
            () => false,
          )
        )
          attachments.push(file);
      }
    }
    const checkpoints = session.projectId
      ? await workspace.listCheckpoints(store.project(session.projectId), id)
      : [];
    const detail = [
      `之后的任务在 ${cwd} 中运行。历史消息里的文件路径不会改写。`,
      checkpoints.length ? '在原项目中的轮次不能再撤销文件修改，原项目中这个会话的检查点会被清理。' : '',
      agent.runtime.approvalGrants?.length
        ? '这个会话已放行的命令和修改授权会清空，在新项目中需要重新确认。'
        : '',
      attachments.length < session.attachments.length
        ? `草稿中引用的 ${session.attachments.length - attachments.length} 个文件在新项目中不存在，将被移除。`
        : '',
      project && !project.trusted ? '目标项目尚未信任，不会加载项目内的 Pi 配置。' : '',
      project && !session.projectId ? '移入项目后可以引用项目文件，变更面板可用，每轮会创建检查点。' : '',
      !project ? '移到对话后不能引用文件，变更面板不可用。' : '',
      session.file ? `原 Pi 会话文件会移到${trash}，可以从中恢复。` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const signature = JSON.stringify([
      session.projectId,
      session.file,
      session.title,
      session.updatedAt,
      cwd,
      detail,
      attachments,
    ]);
    return { session, cwd, project, attachments, detail, signature };
  }
  return {
    sessionMoveStatus: async (id: string) => {
      context.text(id, 100);
      const session = store.session(id);
      const status = service.moveStatus(id);
      let reason = '';
      if (session.team || store.state.sessions.some((s) => s.team?.leadId === id))
        reason = '团队会话暂不支持移动';
      else if (!store.storage.writable) reason = '本地数据只读，暂时不能移动';
      else if (moving.has(id) || status.moving) reason = '会话正在移动，请稍候';
      else if (status.pending) reason = '有待处理的确认，处理后才能移动';
      else if (status.active) reason = '任务进行中，结束后才能移动';
      else if (status.sideChat || getSideFlight()?.sessionId === id)
        reason = '侧边对话正在回答，结束后才能移动';
      else if (await service.inTerminal(id)) reason = '会话已在 Pi 终端中打开，关闭终端后才能移动';
      else if (
        session.file &&
        !(await fs.access(session.file).then(
          () => true,
          () => false,
        ))
      )
        reason = '会话文件已不存在，无法移动';
      return { reason };
    },
    previewSessionMove: async (id: string, target: string | null) => {
      const info = await inspect(id, target);
      const token = randomUUID();
      // A preview is a one-use confirmation of these exact effects, not a bypass flag.
      for (const [key, value] of previews) if (value.id === id) previews.delete(key);
      previews.set(token, { id, target, signature: info.signature });
      return { token, detail: info.detail };
    },
    moveSession: async (id: string, target: string | null, token?: string) => {
      if (moving.has(id)) throw new Error('这个会话正在移动，请稍后重试');
      moving.add(id);
      let copy: string | undefined;
      let committed = false;
      let unlock: (() => void) | undefined;
      try {
        let info = await inspect(id, target);
        if (token) {
          const preview = previews.get(token);
          previews.delete(token);
          if (
            !preview ||
            preview.id !== id ||
            preview.target !== target ||
            preview.signature !== info.signature
          )
            throw new Error('会话状态已变化，请重新选择目标并确认移动');
        } else if (info.session.file) {
          const result = await showAppDialog({
            type: 'warning',
            message: `把「${info.session.title}」移到「${info.project?.name ?? '对话'}」？`,
            detail: info.detail,
            buttons: ['取消', '移动'],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response !== 1) return false;
          const fresh = await inspect(id, target);
          if (fresh.signature !== info.signature) throw new Error('会话状态已变化，请重新确认移动');
          info = fresh;
        }
        if (!info.project) await fs.mkdir(info.cwd, { recursive: true });
        const oldFile = info.session.file;
        if (oldFile) {
          const result = await service.get(id).moveCopy(id, info.cwd);
          if (typeof result?.file !== 'string' || result.file === oldFile)
            throw new Error('未能生成会话副本，请更新 Pi 后重试');
          copy = result.file;
          await fs.access(result.file);
        }
        // Recheck after the bridge read; no task may be silently stopped by a move.
        const fresh = await inspect(id, target);
        if (fresh.signature !== info.signature) throw new Error('会话状态已变化，请重新确认移动');
        unlock = service.lockSessionMove(id);
        await service.release(id);
        const session = store.session(id);
        await store.commitSessionMove(id, {
          projectId: target ?? undefined,
          cwd: target === null ? info.cwd : undefined,
          file: copy ?? session.file,
          attachments: info.attachments,
        });
        committed = true;
        const warnings: string[] = [];
        try {
          await workspace.removeSession(id);
        } catch (error) {
          console.error('session.move checkpoint cleanup failed', { id, target }, error);
          warnings.push('会话已移动，但原检查点未能清理，请重启后检查');
        }
        if (oldFile) {
          try {
            await shell.trashItem(oldFile);
          } catch (error) {
            console.error('session.move trash failed', { id, target }, error);
            warnings.push(`会话已移动，但原会话文件未能移到${trash}：${readableError(error)}`);
          }
        }
        send({ type: 'state', state: store.state });
        return { warning: warnings.join('\n') || undefined };
      } catch (cause) {
        console.error('session.move failed', { id, target, committed }, cause);
        if (copy && !committed) {
          try {
            await fs.unlink(copy);
          } catch (error) {
            console.error('session.move copy cleanup failed', { id, copy }, error);
          }
        }
        if (committed)
          return { warning: `会话已移动，但后续处理未完成：${readableError(cause)}。请刷新后检查。` };
        throw new Error(`没能移动会话：${readableError(cause)}。会话保留在原处。`, { cause });
      } finally {
        unlock?.();
        moving.delete(id);
      }
    },
  };
}
