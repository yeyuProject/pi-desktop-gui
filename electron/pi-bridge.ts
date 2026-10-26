// Loaded by Pi's extension loader, never by Electron. Responses use RPC UI notifications.
import {
  ModelRuntime,
  SettingsManager,
  DefaultPackageManager,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai/compat';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import fs from 'node:fs/promises';
import {
  DESKTOP_BRIDGE_COMMAND,
  DESKTOP_BRIDGE_PROTOCOL,
  DESKTOP_WORKSPACE_PREFIX,
} from '../shared/pi-bridge';
import { classifyReadTarget, classifyWriteTarget } from './approval-paths';
import {
  APPROVAL_ALLOW,
  APPROVAL_ALWAYS,
  APPROVAL_DENY,
  APPROVAL_PREFIX,
  grantForRequest,
  matchesGrant,
  decide,
  describe,
  type ApprovalMode,
  type ApprovalGrant,
} from '../shared/approval';

export default function desktopBridge(pi: ExtensionAPI) {
  let authAbort: AbortController | undefined;
  let approvalMode: ApprovalMode =
    (['auto', 'confirm', 'readonly'] as const).find((m) => m === process.env.PI_DESKTOP_APPROVAL) ?? 'auto';
  let approvalGrants: ApprovalGrant[] = [];
  const checkpointEnabled = process.env.PI_DESKTOP_CHECKPOINTS === '1';
  async function workspaceRequest(ctx: ExtensionContext, request: object) {
    if (!checkpointEnabled) return;
    const reply = await ctx.ui.input(DESKTOP_WORKSPACE_PREFIX + JSON.stringify(request), '', {
      timeout: 120000,
    });
    if (reply === undefined) throw new Error('检查点操作已取消，工具未继续执行');
    const result: unknown = JSON.parse(reply);
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true)
      throw new Error(
        result && typeof result === 'object' && 'error' in result
          ? String(result.error)
          : '无法保存检查点，工具未继续执行',
      );
  }
  pi.on('message_start', async (event, ctx) => {
    if (event.message.role !== 'user') return;
    try {
      await workspaceRequest(ctx, { phase: 'turn', timestamp: event.message.timestamp });
    } catch (error) {
      ctx.abort();
      throw error;
    }
  });
  const publishGrants = (ctx: ExtensionContext) =>
    ctx.ui.notify(
      '__PI_DESKTOP__' + JSON.stringify({ type: 'desktop_approval_grants', grants: approvalGrants }),
    );
  pi.on('session_start', (_event, ctx) => {
    approvalGrants = [];
    // Loaded explicitly before project/global extensions; marks the owner of subsequent UI events.
    ctx.ui.notify('__PI_DESKTOP__' + JSON.stringify({ type: 'desktop_session_start' }));
    publishGrants(ctx);
  });
  async function approve(toolName: string, input: unknown, ctx: ExtensionContext) {
    if (approvalMode === 'auto') return;
    const request = describe(toolName, input);
    if (request.kind === 'read') request.readTarget = await classifyReadTarget(ctx.cwd, request.path ?? '');
    const verdict = decide(approvalMode, toolName, request.readTarget);
    if (verdict === 'allow') return;
    if (verdict === 'deny')
      return {
        block: true as const,
        reason: `当前为只读模式，桌面端拒绝了 ${toolName}。只允许读取和搜索当前项目内可确认的路径，不允许修改文件或执行命令。`,
      };
    if (request.kind === 'write')
      request.writeTarget = await classifyWriteTarget(ctx.cwd, request.path ?? '');
    request.grant = grantForRequest(request);
    if (approvalGrants.some((grant) => matchesGrant(grant, request))) return;
    const choice = await ctx.ui.select(APPROVAL_PREFIX + JSON.stringify(request), [
      APPROVAL_ALLOW,
      ...(request.grant ? [APPROVAL_ALWAYS] : []),
      APPROVAL_DENY,
    ]);
    if (choice === APPROVAL_ALLOW) return;
    if (choice === APPROVAL_ALWAYS && request.grant) {
      if (!approvalGrants.some((grant) => grant.id === request.grant!.id)) approvalGrants.push(request.grant);
      publishGrants(ctx);
      return;
    }
    const reason = choice?.startsWith(APPROVAL_DENY + '：')
      ? choice.slice(APPROVAL_DENY.length + 1).trim()
      : '';
    return {
      block: true as const,
      reason: `用户拒绝了这次 ${toolName} 调用${reason ? '，原因：' + reason : ''}。请按用户意见调整，不要重复同样的操作。`,
    };
  }
  pi.on('tool_call', async (event, ctx) => {
    const blocked = await approve(event.toolName, event.input, ctx);
    if (blocked) return blocked;
    if (!['edit', 'write', 'bash', 'powershell'].includes(event.toolName)) return;
    try {
      await workspaceRequest(ctx, {
        phase: 'tool-start',
        toolId: event.toolCallId,
        toolName: event.toolName,
        args: {
          path: 'path' in event.input ? event.input.path : undefined,
          command: 'command' in event.input ? event.input.command : undefined,
        },
      });
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (!['edit', 'write', 'bash', 'powershell'].includes(event.toolName)) return;
    try {
      await workspaceRequest(ctx, { phase: 'tool-end', toolId: event.toolCallId });
    } catch (error) {
      ctx.abort();
      throw error;
    }
  });
  pi.on('user_bash', async (event, ctx) => {
    const blocked = await approve('bash', { command: event.command }, ctx);
    if (blocked)
      return { result: { output: blocked.reason, exitCode: 1, cancelled: false, truncated: false } };
    try {
      await workspaceRequest(ctx, {
        phase: 'tool-start',
        toolId: 'desktop-bash',
        toolName: 'bash',
        args: { command: event.command },
      });
    } catch (error) {
      return {
        result: {
          output: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });
  async function models(ctx: ExtensionCommandContext) {
    const m = await ModelRuntime.create();
    for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
      const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
      if (native) m.registerNativeProvider(native);
      else if (config) m.registerProvider(id, config);
    }
    return m;
  }
  pi.registerCommand(DESKTOP_BRIDGE_COMMAND, {
    description: 'Pi Desktop internal bridge',
    handler: async (encoded, ctx) => {
      const emit = (value: object) => ctx.ui.notify('__PI_DESKTOP__' + JSON.stringify(value));
      let id = '';
      let replied = false;
      try {
        const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        id = request.id;
        const p = request.params ?? {};
        let data: unknown;
        switch (request.method) {
          case 'task_options': {
            const model = ctx.modelRegistry.find(p.provider, p.modelId);
            if (!model) throw new Error('该模型当前不可用，请刷新模型列表');
            data = {
              thinkingLevels: getSupportedThinkingLevels(model),
              thinking: clampThinkingLevel(model, p.thinking),
            };
            break;
          }
          case 'fork_copy': {
            // Use a separate native manager. Replacing the live manager would abort its task.
            const file = ctx.sessionManager.getSessionFile();
            if (!file) throw new Error('这个会话还没有可分支的历史');
            const manager = SessionManager.open(file);
            const target = p.entryId ? manager.getEntry(p.entryId) : manager.getLeafEntry();
            if (!target) throw new Error('找不到要分支的历史消息，请刷新会话树');
            const leaf = p.kind === 'fork' ? target.parentId : target.id;
            const output = leaf ? manager.createBranchedSession(leaf) : undefined;
            const persisted =
              output &&
              (await fs.stat(output).then(
                () => true,
                (error) => {
                  if (error.code === 'ENOENT') return false;
                  throw error;
                },
              ));
            data = {
              file: persisted ? output : undefined,
              message: p.kind === 'fork' ? (target as any).message : undefined,
            };
            break;
          }
          case 'options':
            data = {
              protocolVersion: DESKTOP_BRIDGE_PROTOCOL,
              autoRetry: pi.getSettings().retry?.enabled !== false,
              approvalMode,
              approvalGrants,
            };
            break;
          case 'approval_mode':
            if (!['auto', 'confirm', 'readonly'].includes(p.mode)) throw new Error('审批模式无效');
            approvalMode = p.mode;
            if (p.mode !== 'confirm') approvalGrants = [];
            publishGrants(ctx);
            data = { approvalMode, approvalGrants };
            break;
          case 'revoke_approval':
            if (p.id !== undefined && typeof p.id !== 'string') throw new Error('要撤回的授权无效');
            approvalGrants = p.id === undefined ? [] : approvalGrants.filter((grant) => grant.id !== p.id);
            publishGrants(ctx);
            data = { approvalGrants };
            break;
          case 'tree': {
            const active = new Set(ctx.sessionManager.getBranch().map((e) => e.id));
            const rows: unknown[] = [];
            const stack = ctx.sessionManager
              .getTree()
              .reverse()
              .map((node) => ({ node, depth: 0 }));
            while (stack.length) {
              const { node, depth } = stack.pop()!;
              const e: any = node.entry;
              const content = e.message?.content;
              const text =
                typeof content === 'string'
                  ? content
                  : (content ?? [])
                      .filter((b: any) => b.type === 'text')
                      .map((b: any) => b.text)
                      .join('\n');
              rows.push({
                id: e.id,
                parentId: e.parentId,
                type: e.type,
                role: e.message?.role,
                text: (text || e.summary || e.name || e.type).slice(0, 600),
                label: node.label,
                depth,
                active: active.has(e.id),
              });
              stack.push(...[...node.children].reverse().map((node) => ({ node, depth: depth + 1 })));
            }
            data = rows;
            break;
          }
          case 'navigate':
            data = await ctx.navigateTree(p.entryId, {
              summarize: p.summarize,
              customInstructions: p.instructions,
            });
            if (!(data as { cancelled: boolean }).cancelled)
              pi.appendEntry('desktop-navigation', { targetId: p.entryId });
            break;
          case 'set_label': {
            if (typeof p.entryId !== 'string') throw new Error('消息无效');
            const label = typeof p.label === 'string' ? p.label.trim().slice(0, 60) : '';
            pi.setLabel(p.entryId, label || undefined);
            data = { label };
            break;
          }
          case 'reload':
            emit({ type: 'desktop_result', id, data: { reloading: true } });
            replied = true;
            await ctx.reload();
            break;
          case 'refresh_models': {
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(new Error('刷新模型超过 15 秒，已取消。请检查供应商网络后重试。')),
              15_000,
            );
            let result;
            try {
              result = await ctx.modelRegistry.refresh({ signal: controller.signal });
              if (controller.signal.aborted) throw controller.signal.reason;
            } catch (error) {
              if (controller.signal.aborted) throw controller.signal.reason;
              throw error;
            } finally {
              clearTimeout(timeout);
            }
            if (result.aborted) throw new Error('刷新模型已取消，请重试');
            const error = ctx.modelRegistry.getError();
            if (error) throw new Error(`刷新模型失败，请检查模型配置：${error}`);
            if (result.errors.size)
              throw new Error(
                `部分供应商的模型刷新失败，请检查连接后重试：${[...result.errors]
                  .map(([provider, error]) => `${provider}: ${error.message}`)
                  .join('；')}`,
              );
            data = {};
            break;
          }
          case 'providers': {
            const m = await models(ctx);
            data = m.getProviders().map((v) => {
              const auth = m.getProviderAuthStatus(v.id);
              return {
                id: v.id,
                name: v.name,
                configured: auth.configured,
                authSource: auth.source,
                oauth: !!v.auth.oauth,
                apiKey: !!v.auth.apiKey?.login,
              };
            });
            break;
          }
          case 'login': {
            if (authAbort) throw new Error('已有登录正在进行');
            authAbort = new AbortController();
            try {
              const m = await models(ctx);
              await m.login(p.provider, p.type, {
                signal: authAbort.signal,
                notify: (e) =>
                  emit({
                    type: 'desktop_auth',
                    ...('url' in e ? { url: e.url } : {}),
                    ...('verificationUri' in e ? { url: e.verificationUri, code: e.userCode } : {}),
                    message:
                      'message' in e
                        ? e.message
                        : 'instructions' in e
                          ? e.instructions
                          : '请在浏览器完成登录',
                  }),
                prompt: async (q) => {
                  const options = { signal: q.signal ?? authAbort?.signal };
                  const value =
                    q.type === 'select'
                      ? await ctx.ui.select(
                          q.message,
                          q.options.map((o) => o.id),
                          options,
                        )
                      : await ctx.ui.input(
                          (q.type === 'secret' ? '[密钥] ' : '') + q.message,
                          q.placeholder,
                          options,
                        );
                  if (value === undefined) {
                    // Providers also close manual input when the browser callback succeeds.
                    if (!q.signal?.aborted) authAbort?.abort();
                    throw new Error('登录已取消');
                  }
                  return value;
                },
              });
              await ctx.modelRegistry.refresh();
            } finally {
              authAbort = undefined;
              emit({ type: 'desktop_auth', clear: true });
            }
            break;
          }
          case 'cancel_auth':
            authAbort?.abort();
            break;
          case 'logout':
            await (await models(ctx)).logout(p.provider);
            await ctx.modelRegistry.refresh();
            break;
          case 'resources': {
            const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
              projectTrusted: ctx.isProjectTrusted(),
            });
            const pm = new DefaultPackageManager({
              cwd: ctx.cwd,
              agentDir: getAgentDir(),
              settingsManager: settings,
              builtinExtensions: ['llama.cpp', 'codemode', 'tool-search', 'mcp'],
            });
            const resolved = await pm.resolve(async () => 'skip');
            data = {
              resources: Object.entries(resolved).flatMap(([kind, items]) =>
                items.map((r: any) => ({ ...r, kind })),
              ),
              packages: pm.listConfiguredPackages(),
              tools: pi.getAllTools().map((t) => ({ name: t.name, description: t.description })),
              activeTools: pi.getActiveTools(),
            };
            break;
          }
          default:
            throw new Error('未知桌面操作');
        }
        if (!replied) emit({ type: 'desktop_result', id, data });
      } catch (error) {
        if (replied) throw error;
        emit({ type: 'desktop_result', id, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
