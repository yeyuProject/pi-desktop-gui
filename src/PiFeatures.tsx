import type { Session, Runtime, Environment, StorageStatus } from '../shared/types';
import { Modal } from './components/Modal';
import { usePiFeatures } from './features/usePiFeatures';
import { SessionTab } from './features/SessionTab';
import { TreeTab } from './features/TreeTab';
import { ResourcesTab } from './features/ResourcesTab';
import { McpTab } from './features/McpTab';
import { ProvidersTab } from './features/ProvidersTab';
import { PreferencesTab } from './features/PreferencesTab';
import { ConfigurationTab } from './features/ConfigurationTab';
import { HelpTab } from './features/HelpTab';
import { useUnsavedChanges } from './hooks/useUnsavedChanges';
export function PiFeatures({
  session,
  runtime,
  initialTab,
  close,
  environment,
  storage,
  projectEnabled,
}: {
  session: Session;
  runtime: Runtime;
  initialTab: string;
  close: () => void;
  environment?: Environment;
  storage: StorageStatus;
  projectEnabled: boolean;
}) {
  const model = usePiFeatures({ session, runtime, initialTab, close, environment, storage, projectEnabled });
  const { tab, setTab, pending, error, notice, setLocal, setKind, setDocument, dirty } = model;
  const guard = useUnsavedChanges(dirty);
  const requestClose = () => {
    if (!pending) guard.confirmLeave(close);
  };
  return (
    <>
      <Modal wide title="Pi 功能" subtitle="会话、工具与个人配置" close={requestClose}>
        <div className="settings-layout feature-layout">
          <nav>
            {[
              ['session', '会话与上下文'],
              ['tree', '会话树与分支'],
              ['resources', 'Skills 与扩展'],
              ['mcp', 'MCP 服务器'],
              ['providers', '供应商与登录'],
              ['prefs', '常用设置'],
              ['settings', '完整 Pi 设置'],
              ['help', '命令与快捷键'],
            ].map(([id, title]) => (
              <button
                key={id}
                className={tab === id ? 'active' : ''}
                disabled={dirty || pending}
                title={dirty ? '请先保存或放弃当前修改' : pending ? '请等待当前操作完成' : ''}
                onClick={() => {
                  if (id === tab) return;
                  setLocal(false);
                  setDocument(undefined);
                  setKind(id === 'mcp' ? 'mcp' : id === 'providers' ? 'models' : 'settings');
                  setTab(id);
                }}
              >
                {title}
              </button>
            ))}
          </nav>
          <div className="settings-content feature-content">
            {model.runtime.configurationPending && (
              <p className="environment-note" role="status">
                配置已保存，本会话空闲后加载；当前任务继续使用已加载的资源。
              </p>
            )}
            {model.engineReason && (
              <p className="environment-note" role="status">
                {model.engineReason}
              </p>
            )}
            {model.prerequisiteReason &&
              !model.operationReason &&
              ['settings', 'prefs', 'providers', 'mcp'].includes(tab) && (
                <p className="settings-copy">本机配置仍可编辑和保存；运行环境就绪后重新连接即可应用。</p>
              )}
            {model.loading && (
              <p className="settings-copy" role="status">
                正在读取此页数据…
              </p>
            )}
            {error && (
              <div className="error-banner" role="alert">
                {error}
                {tab !== 'prefs' && !dirty && !pending && (
                  <button onClick={() => void model.refresh()}>重试读取</button>
                )}
              </div>
            )}
            {notice && (
              <p className="feature-notice" role="status">
                {notice}
              </p>
            )}
            {tab === 'session' && <SessionTab {...model} />}
            {tab === 'tree' && <TreeTab {...model} />}
            {tab === 'resources' && <ResourcesTab {...model} />}
            {tab === 'providers' && <ProvidersTab {...model} />}
            {tab === 'mcp' && <McpTab {...model} />}
            {tab === 'prefs' && <PreferencesTab {...model} />}
            {tab === 'settings' && <ConfigurationTab {...model} />}
            {tab === 'help' && <HelpTab {...model} />}
          </div>
        </div>
        <footer>
          <span className="settings-footer-note">
            {pending ? '正在处理…' : dirty ? '有尚未保存的配置' : '配置保存在本机'}
          </span>
          <button disabled={pending} onClick={requestClose}>
            关闭
          </button>
        </footer>
      </Modal>
      {guard.confirmation}
    </>
  );
}
