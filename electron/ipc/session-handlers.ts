import { BrowserWindow, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aggregateUsage } from '../../shared/usage';
import { listPiSessions, searchSessionContents } from '../history';
import { removeSessionScratch } from '../local-data';
import { pathKey, samePath } from '../platform';
import { fillSessionUsage, hasSessionData, isEmptySession } from '../session-maintenance';
import { SideChats } from '../side-chats';
import type { HandlerContext, HandlerMap } from './handler-context';

interface SessionHandlerContext extends Pick<
  HandlerContext,
  'store' | 'service' | 'workspace' | 'text' | 'send' | 'save' | 'showAppDialog'
> {
  window: BrowserWindow | undefined;
  sideChats: SideChats;
  getSideFlight: () => { sessionId: string; cancelled?: boolean; done?: Promise<void> } | undefined;
  newSession: (projectId?: string) => Promise<import('../../shared/types').Session>;
  chooseFile: (title: string, filters?: Electron.FileFilter[]) => Promise<string | null>;
  adoptSessionFile: (file: string, projectId?: string) => Promise<import('../../shared/types').Session>;
  sessionRoots: () => string[];
  assertTerminalClosed: (id: string) => Promise<void>;
  assertWorkspaceTerminalsClosed: (root: string) => Promise<void>;
}
export type SessionHandlerName =
  | 'addProject'
  | 'renameProject'
  | 'removeProject'
  | 'trustProject'
  | 'newSession'
  | 'importSession'
  | 'selectSession'
  | 'renameSession'
  | 'deleteSession'
  | 'pinSession'
  | 'cleanupEmptySessions'
  | 'searchSessions'
  | 'piSessions'
  | 'openPiSession'
  | 'usageSummary';
export function createSessionHandlers(context: SessionHandlerContext) {
  const {
    store,
    service,
    workspace,
    save,
    send,
    showAppDialog,
    sideChats,
    getSideFlight,
    newSession,
    chooseFile,
    adoptSessionFile,
    sessionRoots,
    assertTerminalClosed,
    assertWorkspaceTerminalsClosed,
  } = context;
  const text: HandlerContext['text'] = context.text;
  let searchController: AbortController | undefined;
  const handlers: HandlerMap<SessionHandlerName> = {
    addProject: async () => {
      const chosen = await dialog.showOpenDialog(context.window!, {
        title: '添加本地项目',
        properties: ['openDirectory'],
      });
      if (chosen.canceled) return null;
      const folder = await fs.realpath(chosen.filePaths[0]);
      const existing = store.state.projects.find((p) => samePath(p.path, folder));
      if (existing) {
        const session =
          store.durableSessions().find((s) => s.projectId === existing.id) ??
          store.createPlaceholder(existing.id, (id) => service.connected(id));
        store.selectSession(session.id);
        await save();
        return existing;
      }
      const p = {
        id: randomUUID(),
        name: path.basename(folder),
        path: folder,
        trusted: false,
        createdAt: Date.now(),
      };
      store.state.projects.push(p);
      await newSession(p.id);
      return p;
    },
    renameProject: async (id, name) => {
      text(id, 100);
      text(name, 120);
      if (!name.trim()) return;
      store.project(id).name = name.trim();
      await save();
    },
    removeProject: async (id) => {
      text(id, 100);
      if (service.projectBusy(id)) throw new Error('请先停止该项目的任务');
      const p = store.project(id);
      await assertWorkspaceTerminalsClosed(p.path);
      const result = await showAppDialog({
        type: 'question',
        message: `从列表移除 ${p.name}？`,
        detail: '磁盘项目和 Pi 会话文件将保留。',
        buttons: ['取消', '移除入口'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return;
      if (service.projectBusy(id)) throw new Error('请先停止该项目的任务');
      await assertWorkspaceTerminalsClosed(p.path);
      await Promise.all(
        store.state.sessions.filter((s) => s.projectId === id).map((s) => service.release(s.id)),
      );
      store.state.projects = store.state.projects.filter((p) => p.id !== id);
      store.removeSessions(store.state.sessions.filter((s) => s.projectId === id).map((s) => s.id));
      if (store.state.selectedProjectId === id) {
        const next = store.durableSessions()[0] ?? store.createPlaceholder();
        store.selectSession(next.id);
      }
      await save();
    },
    trustProject: async (id) => {
      text(id, 100);
      const p = store.project(id);
      if (p.trusted) return;
      const result = await showAppDialog({
        type: 'question',
        message: `启用项目 ${p.name}`,
        detail: `Pi 将使用当前用户权限读取、修改文件、执行命令，并加载项目配置、Skills 和扩展。项目扩展可以直接执行代码，请只启用可信项目。\n\n${p.path}`,
        buttons: ['取消', '信任并启用'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response === 1) {
        p.trusted = true;
        await save();
      }
    },
    newSession: async (id) => {
      if (id !== undefined) text(id, 100);
      return newSession(id);
    },
    importSession: async (projectId) => {
      if (projectId !== undefined) text(projectId, 100);
      const p = projectId ? store.project(projectId) : undefined;
      const file = await chooseFile('导入 Pi 会话', [{ name: 'Pi 会话', extensions: ['jsonl'] }]);
      if (!file) return null;
      return adoptSessionFile(file, p?.id);
    },
    selectSession: async (id) => {
      text(id, 100);
      const s = store.session(id);
      store.selectSession(s.id);
      if (store.storage.writable) {
        // Browsing only selects and reads history. Sending or an explicit connection
        // starts Pi; existing background tasks keep their own process and runtime.
        const saving = store.save();
        try {
          send({ type: 'state', state: store.state });
        } finally {
          await saving;
        }
      } else send({ type: 'state', state: store.state });
    },
    renameSession: async (id, name) => {
      text(id, 100);
      text(name, 120);
      if (!name.trim()) return;
      store.promoteSession(id).title = name.trim();
      await save();
      await service.get(id).rename(id, name.trim());
    },
    deleteSession: async (id) => {
      text(id, 100);
      await assertTerminalClosed(id);
      const s = store.session(id);
      if (service.active(id)) throw new Error('请先停止这个会话的任务');
      const flight = getSideFlight();
      if (flight?.sessionId === id) {
        flight.cancelled = true;
        await service.get(id).stopSideChat();
        await flight.done;
      }
      const result = await showAppDialog({
        type: 'warning',
        message: `删除会话“${s.title}”？`,
        detail:
          (s.file ? 'Pi 会话文件会移到回收站，可从回收站恢复。' : '会话将从列表移除。') +
          '此会话的检查点、临时草稿和备份草稿将永久清理。',
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
      if (!store.state.sessions.includes(s)) return false;
      let removedFile = false;
      if (service.active(id)) throw new Error('请先停止这个会话的任务');
      await service.release(id);
      await assertTerminalClosed(id);
      if (s.file) {
        const exists = await fs.lstat(s.file).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        if (exists) {
          await shell.trashItem(s.file);
          removedFile = true;
        }
      }
      await workspace.removeSession(id);
      await sideChats.remove(id);
      await removeSessionScratch(store.dir, id);
      store.removeSessions([id]);
      if (store.state.selectedSessionId === id) {
        const next =
          store.durableSessions().find((x) => x.projectId === s.projectId) ??
          store.durableSessions().find((x) => !x.projectId) ??
          store.createPlaceholder(s.projectId);
        store.selectSession(next.id);
      }
      await save();
      await store.purgeDeletedSession(id);
      return { trashed: removedFile };
    },
    pinSession: async (id, pinned) => {
      text(id, 100);
      store.promoteSession(id).pinned = pinned === true;
      await save();
    },
    cleanupEmptySessions: async () => {
      const candidates = (
        await Promise.all(
          store
            .durableSessions()
            .map(async (session) =>
              (await isEmptySession(
                session,
                service.connected(session.id) || (await service.inTerminal(session.id))
                  ? session.id
                  : undefined,
              ))
                ? session.id
                : undefined,
            ),
        )
      ).filter((id): id is string => !!id);
      if (!candidates.length) return 0;
      const result = await showAppDialog({
        type: 'question',
        message: `清理 ${candidates.length} 个空会话？`,
        detail:
          '只移除未置顶、没有消息或未发送内容的会话入口。草稿、附件、图片、自定义名称、模型与审批设置和已连接会话会保留；磁盘文件不会删除。',
        buttons: ['取消', '清理空会话'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return 0;
      const removable = new Set<string>();
      for (const id of candidates) {
        const session = store.state.sessions.find((item) => item.id === id);
        if (
          session &&
          (await isEmptySession(
            session,
            service.connected(id) || (await service.inTerminal(id)) ? id : undefined,
          ))
        )
          removable.add(id);
      }
      await Promise.all([...removable].map((id) => service.release(id)));
      // Draft saves can arrive while the file checks above await I/O; inspect current fields once more.
      const before = store.state.sessions.length;
      store.removeSessions(
        store.state.sessions
          .filter(
            (session) =>
              removable.has(session.id) && !service.connected(session.id) && !hasSessionData(session),
          )
          .map((session) => session.id),
      );
      const removed = before - store.state.sessions.length;
      if (!store.state.sessions.some((session) => session.id === store.state.selectedSessionId)) {
        const next = store.durableSessions()[0] ?? store.createPlaceholder(store.state.selectedProjectId);
        store.selectSession(next.id);
      }
      await save();
      return removed;
    },
    searchSessions: async (query) => {
      text(query, 200);
      searchController?.abort();
      const controller = new AbortController();
      searchController = controller;
      try {
        return await searchSessionContents(store.durableSessions(), query, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return [];
        throw error;
      }
    },
    piSessions: async () => {
      const known = new Set(store.state.sessions.filter((s) => s.file).map((s) => pathKey(s.file!)));
      return listPiSessions(sessionRoots(), known);
    },
    openPiSession: async (file) => {
      text(file, 4096);
      const resolved = path.resolve(file);
      const inside = sessionRoots().some((root) => {
        const relative = path.relative(root, resolved);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      });
      if (!inside || !resolved.endsWith('.jsonl')) throw new Error('只能打开 Pi 会话目录中的会话');
      return adoptSessionFile(resolved);
    },
    usageSummary: async () => {
      await fillSessionUsage(store);
      return aggregateUsage(store.durableSessions(), store.state.projects);
    },
  };
  return handlers;
}
