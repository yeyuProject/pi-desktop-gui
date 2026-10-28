import { shell } from 'electron';
import path from 'node:path';
import type { AppEvent } from '../../shared/types';
import type { CheckpointContext } from '../../shared/checkpoints';
import type { DialogOptions } from '../app-dialogs';
import type { Store } from '../store';
import type { SessionAgents } from '../session-agents';
import {
  type Workspace,
  listDirectory,
  allFiles,
  previewFile,
  safePath,
  sensitive,
  attachmentInfo,
} from '../workspace';
import { projectRules, createAgentRules } from '../project-rules';
import { readImageAttachment } from '../images';
import { openTextEditor, openWithApp } from '../platform';

export type WorkspaceHandlerName =
  | 'checkpoints'
  | 'checkpointPreview'
  | 'revertCheckpoint'
  | 'revertChanges'
  | 'projectImage'
  | 'files'
  | 'searchFiles'
  | 'preview'
  | 'attachmentInfo'
  | 'projectRules'
  | 'editProjectRules'
  | 'createAgentRules'
  | 'changes'
  | 'diff'
  | 'cancelDiff'
  | 'openFile'
  | 'referenceDropped';

interface WorkspaceHandlerContext {
  store: Store;
  service: SessionAgents;
  workspace: Workspace;
  text: (value: unknown, max?: number) => asserts value is string;
  strings: (value: unknown) => asserts value is string[];
  send: (event: AppEvent) => void;
  showAppDialog: (options: DialogOptions) => Promise<{ response: number }>;
}

export function createWorkspaceHandlers(context: WorkspaceHandlerContext) {
  const { store, service, workspace, send, showAppDialog } = context;
  const text: WorkspaceHandlerContext['text'] = context.text;
  const strings: WorkspaceHandlerContext['strings'] = context.strings;
  let activeDiff: { id?: string; controller: AbortController } | undefined;
  function checkpointContext(projectId: string, value: unknown): CheckpointContext | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('检查点范围无效');
    const context = value as CheckpointContext;
    text(context.sessionId, 100);
    if (context.checkpointId !== undefined) text(context.checkpointId, 100);
    if (store.session(context.sessionId).projectId !== projectId) throw new Error('该检查点不属于当前项目');
    return { sessionId: context.sessionId, checkpointId: context.checkpointId };
  }

  const handlers: Record<WorkspaceHandlerName, (...args: any[]) => any> = {
    checkpoints: async (id) => {
      text(id, 100);
      const session = store.session(id);
      return session.projectId ? workspace.listCheckpoints(store.project(session.projectId), id) : [];
    },
    checkpointPreview: async (id, checkpointId) => {
      text(id, 100);
      text(checkpointId, 100);
      const session = store.session(id);
      if (!session.projectId) throw new Error('独立对话没有项目检查点');
      return workspace.checkpointPreview(store.project(session.projectId), id, checkpointId);
    },
    revertCheckpoint: async (id, checkpointId, files, revision) => {
      text(id, 100);
      text(checkpointId, 100);
      strings(files);
      text(revision, 200);
      if (!files.length || !revision) throw new Error('请重新查看检查点并选择要撤销的文件');
      const session = store.session(id);
      if (!session.projectId) throw new Error('独立对话没有项目检查点');
      try {
        return await workspace.revert(
          store.project(session.projectId),
          files,
          (file) => shell.trashItem(file),
          { sessionId: id, checkpointId, revision },
        );
      } finally {
        send({ type: 'workspaceChanged', projectId: session.projectId });
      }
    },
    revertChanges: async (projectId, only, rawContext) => {
      text(projectId, 100);
      if (only !== null) strings(only);
      const project = store.project(projectId);
      const context = checkpointContext(projectId, rawContext);
      if (service.projectBusy(projectId)) throw new Error('请等待当前任务结束后再撤销');
      const pending = (await workspace.changes(project, 'run', context)).files.filter(
        (f) => !only || only.includes(f.path),
      );
      if (!pending.length) return [];
      const created = pending.filter((f) => f.status === '新增').length;
      const result = await showAppDialog({
        type: 'warning',
        message:
          only?.length === 1 ? `撤销对 ${only[0]} 的修改？` : `撤销本轮 ${pending.length} 个文件的修改？`,
        detail:
          '文件会恢复为本轮任务开始前的内容。' +
          (created ? `本轮新建的 ${created} 个文件会移到回收站。` : '') +
          (pending.some((f) => f.existedBeforeRun) ? '\n任务开始前就已有的未提交修改会保留。' : ''),
        buttons: ['取消', '撤销修改'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return [];
      if (service.projectBusy(projectId)) throw new Error('任务正在执行，请停止后再撤销');
      try {
        return await workspace.revert(project, only, (file) => shell.trashItem(file), context);
      } finally {
        send({ type: 'workspaceChanged', projectId });
      }
    },
    projectImage: async (id, relative) => {
      text(id, 100);
      text(relative, 4096);
      if (sensitive(relative)) throw new Error('凭据文件不在文件预览和引用范围内');
      const project = store.project(id);
      const file = await safePath(project.path, relative);
      if (sensitive(path.relative(project.path, file))) throw new Error('凭据文件不在文件预览和引用范围内');
      return readImageAttachment(file);
    },
    files: async (id, dir) => {
      text(id, 100);
      text(dir, 4096);
      return listDirectory(store.project(id), dir);
    },
    searchFiles: async (id, query) => {
      text(id, 100);
      text(query, 1000);
      return (await allFiles(store.project(id)))
        .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 80);
    },
    preview: async (id, relative) => {
      text(id, 100);
      text(relative, 4096);
      return previewFile(store.project(id), relative);
    },
    attachmentInfo: async (id, specs) => {
      text(id, 100);
      strings(specs);
      return attachmentInfo(store.project(id), specs);
    },
    projectRules: async (id) => {
      text(id, 100);
      return projectRules(store.project(id));
    },
    editProjectRules: async (id) => {
      text(id, 100);
      const project = store.project(id);
      const rules = await projectRules(project);
      if (!rules) throw new Error('项目规则文件已不存在，请刷新后重新生成');
      await openTextEditor(
        await safePath(project.path, rules.relativePath),
        store.state.settings.editorPath || undefined,
      );
    },
    createAgentRules: async (id) => {
      text(id, 100);
      const project = store.project(id);
      const file = await createAgentRules(project);
      send({ type: 'workspaceChanged', projectId: id, changedPaths: [file.relativePath] });
      await openTextEditor(
        await safePath(project.path, file.relativePath),
        store.state.settings.editorPath || undefined,
      );
      return file;
    },
    changes: async (id, mode = 'all', context) => {
      text(id, 100);
      if (!['all', 'run'].includes(mode)) throw new Error('差异模式无效');
      return workspace.changes(store.project(id), mode, checkpointContext(id, context));
    },
    diff: async (id, relative, mode, context, requestId) => {
      text(id, 100);
      text(relative, 4096);
      if (requestId !== undefined) text(requestId, 100);
      if (!['all', 'run'].includes(mode)) throw new Error('差异模式无效');
      const project = store.project(id),
        checkpoint = checkpointContext(id, context);
      activeDiff?.controller.abort();
      const request = { id: requestId, controller: new AbortController() };
      activeDiff = request;
      try {
        return await workspace.diff(project, relative, mode, checkpoint, request.controller.signal);
      } catch (error) {
        if (!request.controller.signal.aborted) throw error;
        return { path: relative, patch: '', before: '', after: '', unavailable: '差异预览已取消' };
      } finally {
        if (activeDiff === request) activeDiff = undefined;
      }
    },
    cancelDiff: async (requestId) => {
      text(requestId, 100);
      if (activeDiff?.id === requestId) activeDiff.controller.abort();
    },
    openFile: async (id, relative) => {
      text(id, 100);
      text(relative, 4096);
      const file = await safePath(store.project(id).path, relative);
      const editor = store.state.settings.editorPath;
      if (editor) await openWithApp(editor, file);
      else shell.showItemInFolder(file);
    },
    referenceDropped: async (id, files) => {
      text(id, 100);
      strings(files);
      const project = store.project(id);
      const accepted: string[] = [],
        rejected: string[] = [];
      for (const file of files.slice(0, 20)) {
        const relative = path.isAbsolute(file) ? path.relative(project.path, file) : '';
        try {
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('不在项目内');
          const preview = await previewFile(project, relative, 256 * 1024 + 1);
          if (preview.binary || preview.size > 256 * 1024) throw new Error('不是 256 KiB 以内的文本文件');
          accepted.push(relative.replaceAll('\\', '/'));
        } catch {
          rejected.push(path.basename(file));
        }
      }
      return { accepted, rejected };
    },
  };
  return { handlers, cancelActiveDiff: () => activeDiff?.controller.abort() };
}
