import { BrowserWindow, dialog, nativeTheme } from 'electron';
import { nativeThemeSource, STYLE_META, styleTheme, THEMES, UI_STYLES } from '../../shared/window-theme';
import { updateFeed, updateProxy } from '../update-network';
import { UpdateService } from '../updater';
import type { HandlerContext, HandlerMap } from './handler-context';

interface SettingsHandlerContext extends Pick<HandlerContext, 'store' | 'service' | 'text' | 'save'> {
  window: BrowserWindow | undefined;
  updates: UpdateService;
  refreshEnvironment: () => Promise<import('../../shared/types').Environment>;
  updateWindowTheme: () => void;
  chooseFile: (title: string, filters?: Electron.FileFilter[]) => Promise<string | null>;
}
export type SettingsHandlerName = 'saveSettings' | 'choosePath' | 'detect';
export function createSettingsHandlers(context: SettingsHandlerContext) {
  const { store, service, save, refreshEnvironment, updateWindowTheme, chooseFile } = context;
  const text: HandlerContext['text'] = context.text;

  const handlers: HandlerMap<SettingsHandlerName> = {
    saveSettings: async (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
      const next = { ...store.state.settings };
      for (const key of [
        'piPath',
        'nodePath',
        'agentDir',
        'editorPath',
        'provider',
        'modelId',
        'thinking',
        'updateProxy',
        'updateMirror',
      ] as const)
        if (key in value) {
          text(value[key], 4096);
          next[key] = value[key];
        }
      if (value.theme !== undefined) {
        if (!(THEMES as readonly unknown[]).includes(value.theme)) throw new Error('主题无效');
        next.theme = value.theme;
      }
      if (value.uiStyle !== undefined) {
        if (!(UI_STYLES as readonly unknown[]).includes(value.uiStyle)) {
          const labels = UI_STYLES.map((style) => STYLE_META[style].label);
          throw new Error(`请选择 ${labels.slice(0, -1).join('、')} 或 ${labels.at(-1)} 界面风格。`);
        }
        next.uiStyle = value.uiStyle;
      }
      next.theme = styleTheme(next.theme, next.uiStyle);
      for (const [key, min, max] of [
        ['fontScale', 1, 2],
        ['sidebarWidth', 180, 360],
        ['inspectorWidth', 300, 720],
        ['sideChatWidth', 300, 560],
        ['inspectorSplit', 15, 70],
      ] as const)
        if (value[key] !== undefined) {
          if (!Number.isFinite(value[key])) throw new Error('尺寸无效');
          next[key] = Math.max(min, Math.min(max, value[key]));
        }
      if (typeof value.onboardingDone === 'boolean') next.onboardingDone = value.onboardingDone;
      if (typeof value.expandThinking === 'boolean') next.expandThinking = value.expandThinking;
      if (typeof value.notifyOnFinish === 'boolean') next.notifyOnFinish = value.notifyOnFinish;
      if (typeof value.notifyOnApproval === 'boolean') next.notifyOnApproval = value.notifyOnApproval;
      if (typeof value.notifyOnError === 'boolean') next.notifyOnError = value.notifyOnError;
      updateFeed(next.updateMirror);
      updateProxy(next.updateProxy, {});
      if (value.autoDownloadUpdates !== undefined) {
        if (typeof value.autoDownloadUpdates !== 'boolean') throw new Error('自动下载更新设置无效');
        next.autoDownloadUpdates = value.autoDownloadUpdates;
      }
      const modelsChanged = (
        ['piPath', 'nodePath', 'agentDir', 'provider', 'modelId', 'thinking'] as const
      ).some((key) => next[key] !== store.state.settings[key]);
      store.state.settings = next;
      await save();
      if (modelsChanged) service.invalidateModels();
      nativeTheme.themeSource = nativeThemeSource(next.theme);
      updateWindowTheme();
      context.updates.configure(next.autoDownloadUpdates);
    },
    choosePath: async (kind) => {
      if (kind === 'agent') {
        const p = await dialog.showOpenDialog(context.window!, {
          title: '选择 Pi 配置目录',
          properties: ['openDirectory'],
        });
        return p.canceled ? null : p.filePaths[0];
      }
      if (!['pi', 'node', 'editor'].includes(kind)) throw new Error('无效路径类型');
      return chooseFile(
        kind === 'pi'
          ? '选择 Pi 入口 cli.js 或可执行文件'
          : kind === 'node'
            ? '选择 node.exe'
            : '选择代码编辑器可执行文件',
      );
    },
    detect: refreshEnvironment,
  };
  return handlers;
}
