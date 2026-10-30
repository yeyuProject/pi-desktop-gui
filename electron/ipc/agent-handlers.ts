import { shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateGoalAction } from '../../shared/goal';
import { validateGoalStartInput } from '../../shared/goal-input';
import { validatePromptTemplate } from '../../shared/prompts';
import type { ResourceCatalog } from '../../shared/types';
import { Configuration } from '../configuration';
import { agentDirectory, requireSupportedPi, resolvePi } from '../environment';
import { validateImages } from '../images';
import { openTerminal, openWithApp, samePath } from '../platform';
import {
  deletePromptTemplate,
  describeResource,
  readPromptTemplate,
  savePromptTemplate,
  type PromptTemplateContext,
} from '../prompts';
import { toggleResourceSetting } from '../resources-config';
import type { HandlerContext, HandlerMap } from './handler-context';

interface AgentHandlerContext extends Pick<
  HandlerContext,
  'store' | 'service' | 'text' | 'strings' | 'showAppDialog' | 'developmentRoot'
> {
  inSessionWorkspace: <T>(id: string, action: () => Promise<T>) => Promise<T>;
  terminalLock: (id: string) => string;
}
export type AgentHandlerName =
  | 'setSessionModel'
  | 'setSessionThinking'
  | 'messageAction'
  | 'abortRetry'
  | 'setApprovalMode'
  | 'revokeApproval'
  | 'setEntryLabel'
  | 'readHistory'
  | 'connect'
  | 'readModels'
  | 'recover'
  | 'testConnection'
  | 'send'
  | 'openGoal'
  | 'goalAction'
  | 'sessionTree'
  | 'branchSession'
  | 'compact'
  | 'piOption'
  | 'reloadPi'
  | 'resources'
  | 'promptRead'
  | 'promptSave'
  | 'promptDelete'
  | 'toggleResource'
  | 'packageAction'
  | 'providers'
  | 'login'
  | 'logout'
  | 'cancelLogin'
  | 'configRead'
  | 'configSave'
  | 'revealSessionDirectory'
  | 'openPiTerminal'
  | 'stop'
  | 'stopAll'
  | 'clearQueue'
  | 'forceStop'
  | 'respond'
  | 'openResource';
export function createAgentHandlers(context: AgentHandlerContext) {
  const { store, service, showAppDialog, developmentRoot, inSessionWorkspace, terminalLock } = context;
  const text: HandlerContext['text'] = context.text;
  const strings: HandlerContext['strings'] = context.strings;
  const exec = promisify(execFile);
  const sessionResourcePaths = new Map<string, string[]>();
  async function promptContext(id: string): Promise<PromptTemplateContext> {
    const session = store.session(id);
    const catalog = (await service.get(id).admin(id, 'resources')) as ResourceCatalog;
    sessionResourcePaths.set(
      id,
      catalog.resources.map((item) => item.path),
    );
    return {
      agentDir: agentDirectory(store.state.settings),
      cwd: session.projectId ? store.project(session.projectId).path : undefined,
      resources: catalog.resources,
    };
  }

  const handlers: HandlerMap<AgentHandlerName> = {
    setSessionModel: async (id, provider, modelId) => {
      text(id, 100);
      text(provider, 200);
      text(modelId, 400);
      await service.get(id).setModel(id, provider, modelId);
    },
    setSessionThinking: async (id, level) => {
      text(id, 100);
      text(level, 40);
      await service.setThinking(id, level);
    },
    messageAction: async (id, action, role, timestamp) => {
      text(id, 100);
      if (!['edit', 'regenerate', 'fork'].includes(action)) throw new Error('消息操作无效');
      if (!['user', 'assistant'].includes(role) || !Number.isFinite(timestamp)) throw new Error('消息无效');
      await service.get(id).messageAction(id, action, role, timestamp);
    },
    abortRetry: (id) => {
      text(id, 100);
      return service.get(id).abortRetry();
    },
    setApprovalMode: async (id, mode) => {
      text(id, 100);
      if (mode !== 'auto' && mode !== 'confirm' && mode !== 'readonly') throw new Error('审批模式无效');
      await service.get(id).setApprovalMode(id, mode);
    },
    revokeApproval: async (id, grantId) => {
      text(id, 100);
      if (grantId !== undefined) text(grantId);
      await service.get(id).revokeApproval(id, grantId);
    },
    setEntryLabel: async (id, entryId, label) => {
      text(id, 100);
      text(entryId, 100);
      text(label, 200);
      await service.get(id).admin(id, 'set_label', { entryId, label });
    },
    readHistory: async (id) => {
      text(id, 100);
      return service.get(id).history(id);
    },
    connect: async (id) => {
      text(id, 100);
      await service.get(id).connect(id);
    },
    readModels: async (id) => {
      text(id, 100);
      await service.get(id).readModels(id, (read) => inSessionWorkspace(id, read));
    },
    recover: async (id, prompt) => {
      text(id, 100);
      if (prompt !== undefined) text(prompt);
      await service.get(id).recover(id, prompt);
    },
    testConnection: async (id) => {
      text(id, 100);
      return service.get(id).testConnection(id);
    },
    send: async (id, prompt, attachments, mode, images = [], goalStart) => {
      text(id, 100);
      text(prompt);
      strings(attachments);
      if (mode !== 'steer' && mode !== 'followUp') throw new Error('发送模式无效');
      validateImages(images);
      if (goalStart !== undefined) validateGoalStartInput(goalStart);
      await service.get(id).send(id, prompt, attachments, mode, images, goalStart);
    },
    openGoal: async (id) => {
      text(id, 100);
      await service.get(id).openGoal(id);
    },
    goalAction: async (id, action) => {
      text(id, 100);
      validateGoalAction(action);
      const agent = service.get(id);
      if (action.action === 'clear' && agent.runtime.goal?.status !== 'completed') {
        const result = await showAppDialog({
          type: 'question',
          message: '清除 Goal？',
          detail: '清除后不再自动继续，已完成的修改保留',
          buttons: ['取消', '清除'],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) return;
      }
      await agent.goalAction(id, action);
    },
    sessionTree: async (id) => {
      text(id, 100);
      return service.get(id).tree(id);
    },
    branchSession: async (id, kind, entryId, summarize, instructions) => {
      text(id, 100);
      if (!['fork', 'clone', 'navigate'].includes(kind)) throw new Error('会话操作无效');
      if (kind !== 'clone') text(entryId, 100);
      if (instructions !== undefined) text(instructions);
      await service.get(id).branch(id, kind, entryId, summarize === true, instructions);
    },
    compact: async (id, instructions) => {
      text(id, 100);
      text(instructions);
      return service.get(id).compact(id, instructions);
    },
    piOption: async (id, key, value) => {
      text(id, 100);
      text(key, 100);
      await service.get(id).option(id, key, value);
    },
    reloadPi: async (id) => {
      text(id, 100);
      await service.get(id).scheduleReload();
    },
    resources: async (id) => {
      text(id, 100);
      const catalog = (await service.get(id).admin(id, 'resources')) as ResourceCatalog;
      sessionResourcePaths.set(
        id,
        catalog.resources.map((item) => item.path),
      );
      const session = store.session(id);
      const context: PromptTemplateContext = {
        agentDir: agentDirectory(store.state.settings),
        cwd: session.projectId ? store.project(session.projectId).path : undefined,
        resources: catalog.resources,
      };
      return {
        ...catalog,
        resources: await Promise.all(
          catalog.resources.map((resource) => describeResource(context, resource)),
        ),
      };
    },
    promptRead: async (id, file) => {
      text(id, 100);
      text(file, 4096);
      return readPromptTemplate(await promptContext(id), file);
    },
    promptSave: async (id, input, original) => {
      text(id, 100);
      validatePromptTemplate(input);
      if (original !== undefined) {
        text(original?.path, 4096);
        text(original?.revision, 100);
      }
      const document = await savePromptTemplate(await promptContext(id), input, original);
      await service.reloadConfiguration(id, input.scope === 'project');
      return document;
    },
    promptDelete: async (id, file, revision) => {
      text(id, 100);
      text(file, 4096);
      text(revision, 100);
      await deletePromptTemplate(await promptContext(id), file, revision);
      const local = !samePath(path.dirname(file), path.join(agentDirectory(store.state.settings), 'prompts'));
      await service.reloadConfiguration(id, local);
    },
    toggleResource: async (id, resource, enabled) => {
      text(id, 100);
      if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
      const catalog = await service.get(id).admin(id, 'resources');
      const found = catalog.resources.find(
        (r: any) => r.path === resource?.path && r.kind === resource?.kind,
      );
      if (!found) throw new Error('资源已变化，请刷新列表');
      const local = found.metadata.scope === 'project';
      const config = new Configuration(store);
      const document = await config.read(id, 'settings', local);
      if (document.error) throw new Error(`配置格式有误，请在完整 Pi 配置中修复：${document.path}`);
      const values = toggleResourceSetting(JSON.parse(document.text), found, enabled);
      await config.save(id, 'settings', local, { ...document, text: JSON.stringify(values) });
      await service.reloadConfiguration(id, local);
    },
    packageAction: async (id, action, source, local) => {
      text(id, 100);
      text(source, 4096);
      if (typeof local !== 'boolean') throw new Error('请选择资源包的作用范围');
      source = source.trim();
      if (!['install', 'remove', 'update'].includes(action)) throw new Error('包操作无效');
      if (action !== 'update' && (!source.trim() || source.startsWith('-')))
        throw new Error('请输入有效包来源');
      if (source.startsWith('-')) throw new Error('包来源不能是命令参数');
      const s = store.session(id);
      if (local && (!s.projectId || !store.project(s.projectId).trusted)) throw new Error('请先启用项目');
      const cwd = await store.sessionDirectory(id);
      if (action === 'remove') {
        const result = await showAppDialog({
          type: 'warning',
          message: `移除资源包“${source}”？`,
          detail: '移除后，使用此范围配置的会话将无法继续使用其中的扩展、技能或模板。',
          buttons: ['取消', '移除'],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) return false;
      } else {
        // Pi updates configured packages in both scopes; --local applies only to install/remove.
        const scope =
          action === 'update'
            ? `个人配置，以及工作目录（${cwd}）中 Pi 已信任的项目配置`
            : local
              ? `当前项目：${store.project(s.projectId!).path}`
              : '个人配置（影响使用此配置的所有会话）';
        const result = await showAppDialog({
          type: 'warning',
          message: action === 'install' ? '安装资源包并允许执行其代码？' : '更新资源包并允许执行其代码？',
          detail: `来源：${source || '上述范围内所有已配置的资源包'}\n范围：${scope}\n\n安装和更新可能执行 npm 安装脚本，包内扩展也会以你的用户权限运行并访问文件和网络。请仅继续使用你信任的来源。`,
          buttons: ['取消', action === 'install' ? '安装并允许执行' : '更新并允许执行'],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) return false;
      }
      await requireSupportedPi(store.state.settings, developmentRoot);
      const pi = await resolvePi(store.state.settings, developmentRoot);
      const args = [
        ...pi.spec.args,
        action,
        ...(action === 'update' ? ['--extensions'] : []),
        ...(source ? [source] : []),
        ...(local && action !== 'update' ? ['--local'] : []),
      ];
      await service.updatePackages(id, action === 'update' ? false : local, async () =>
        exec(pi.spec.command, args, {
          cwd,
          windowsHide: true,
          timeout: 300000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDirectory(store.state.settings),
            PI_TELEMETRY: '0',
          },
        }),
      );
      await service.get(id).connect(id);
      return true;
    },
    providers: async (id) => {
      text(id, 100);
      return service.get(id).admin(id, 'providers');
    },
    login: async (id, provider, type) => {
      text(id, 100);
      text(provider, 200);
      if (!['oauth', 'api_key'].includes(type)) throw new Error('登录方式无效');
      await service.get(id).admin(id, 'login', { provider, type });
    },
    logout: async (id, provider) => {
      text(id, 100);
      text(provider, 200);
      const result = await showAppDialog({
        type: 'warning',
        message: `退出供应商“${provider}”的登录？`,
        detail: '将移除本机保存的登录凭据。之后使用此供应商时需要重新登录或配置密钥。',
        buttons: ['取消', '退出登录'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
      await service.get(id).admin(id, 'logout', { provider });
      return true;
    },
    cancelLogin: (id) => {
      text(id, 100);
      return service.get(id).cancelLogin();
    },
    configRead: async (id, kind, local) => {
      text(id, 100);
      return new Configuration(store).read(id, kind, local);
    },
    configSave: async (id, kind, local, document) => {
      text(id, 100);
      text(document?.text);
      text(document?.revision, 100);
      return new Configuration(store).saveAndApply(id, kind, local, document, () =>
        service.reloadConfiguration(id, local),
      );
    },
    revealSessionDirectory: async (id) => {
      text(id, 100);
      const directory = await store.sessionDirectory(id);
      if (!(await fs.stat(directory)).isDirectory())
        throw new Error('工作目录已变成文件，请在项目设置中选择有效目录');
      const error = await shell.openPath(directory);
      if (error) throw new Error(`无法打开工作目录：${error}`);
    },
    openPiTerminal: async (id) => {
      text(id, 100);
      await requireSupportedPi(store.state.settings, developmentRoot);
      const agent = service.get(id);
      await agent.connect(id);
      const spec = (await resolvePi(store.state.settings, developmentRoot)).spec;
      const s = store.session(id);
      const args = s.file ? ['--session', s.file] : ['--session-id', s.id];
      await service.handoffToTerminal(id, async () =>
        openTerminal(
          [spec.command, ...spec.args, ...args],
          await store.sessionDirectory(id),
          { PI_CODING_AGENT_DIR: agentDirectory(store.state.settings) },
          terminalLock(id),
        ),
      );
    },
    stop: (id) => {
      text(id, 100);
      return service.get(id).stop();
    },
    stopAll: async () => {
      const result = await showAppDialog({
        type: 'warning',
        message: '停止所有会话的任务？',
        detail:
          '所有正在运行的会话都将停止，未发送的队列内容会恢复到各自草稿。通过 nohup、后台运行等方式脱离 Pi 的服务可能继续运行，请到终端停止这些服务并释放端口。',
        buttons: ['取消', '停止所有会话'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response === 1) await service.stop();
    },
    clearQueue: (id) => {
      text(id, 100);
      return service.get(id).clearQueue();
    },
    forceStop: async (id) => {
      text(id, 100);
      const result = await showAppDialog({
        type: 'warning',
        message: '强制结束当前 Pi 会话进程？',
        detail:
          '会尝试终止 Pi 及其子进程，已写入的项目文件将保留。已脱离进程树的后台服务可能继续占用端口，请到终端停止。',
        buttons: ['继续等待', '强制结束'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
      await service.get(id).forceStop();
      return true;
    },
    respond: async (sessionId, id, values) => {
      text(sessionId, 100);
      text(id, 200);
      if (!values || typeof values !== 'object') throw new Error('回复格式无效');
      if (values.value !== undefined) text(values.value);
      return service.get(sessionId).respond(id, {
        value: values.value,
        confirmed: values.confirmed === true,
        cancelled: values.cancelled === true,
      });
    },
    openResource: async (id, target) => {
      text(id, 100);
      text(target, 4096);
      store.session(id);
      let known = sessionResourcePaths.get(id) ?? [];
      if (!known.some((item) => samePath(item, target))) {
        const catalog = (await service.get(id).admin(id, 'resources')) as ResourceCatalog;
        known = catalog.resources.map((item) => item.path);
        sessionResourcePaths.set(id, known);
      }
      const matched = known.find((item) => samePath(item, target));
      if (!matched) throw new Error('找不到该资源文件，请刷新资源列表后重试');
      const editor = store.state.settings.editorPath;
      if (editor) await openWithApp(editor, matched);
      else shell.showItemInFolder(matched);
    },
  };
  return handlers;
}
