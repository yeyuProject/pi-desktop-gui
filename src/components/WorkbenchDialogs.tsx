import { PiFeatures } from '../PiFeatures';
import { Modal } from './Modal';
import { QuickSwitch } from './QuickSwitch';
import { ExtensionPrompt } from './ExtensionPrompt';
import { ShortcutsHelp } from './ShortcutsHelp';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { AppState } from '../../shared/types';
import type { ReactNode } from 'react';
export function WorkbenchDialogs(
  props: Pick<
    Workbench,
    | 'state'
    | 'runtime'
    | 'environment'
    | 'storage'
    | 'featureTab'
    | 'setFeatureTab'
    | 'searchOpen'
    | 'setSearchOpen'
    | 'searchQuery'
    | 'setSearchQuery'
    | 'rename'
    | 'setRename'
    | 'shortcutsOpen'
    | 'setShortcutsOpen'
    | 'selected'
    | 'prompts'
    | 'attempt'
    | 'selectSession'
  > & { state: AppState; settings: ReactNode },
) {
  const {
    state,
    runtime,
    featureTab,
    setFeatureTab,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    rename,
    setRename,
    shortcutsOpen,
    setShortcutsOpen,
    selected,
    prompts,
    attempt,
    selectSession,
  } = props;

  return (
    <>
      {searchOpen && (
        <QuickSwitch
          state={state}
          query={searchQuery}
          setQuery={setSearchQuery}
          close={() => setSearchOpen(false)}
          select={(s) => void selectSession(s)}
          openFile={(file) =>
            void attempt(async () => {
              const s = await api.invoke('openPiSession', file);
              setSearchOpen(false);
              await selectSession(s);
            })
          }
        />
      )}
      {shortcutsOpen && <ShortcutsHelp close={() => setShortcutsOpen(false)} />}
      {rename && (
        <Modal
          title={rename.kind === 'project' ? '重命名项目' : '重命名会话'}
          close={() => setRename(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void attempt(async () => {
                await api.invoke(
                  rename.kind === 'project' ? 'renameProject' : 'renameSession',
                  rename.id,
                  rename.name,
                );
                setRename(undefined);
              });
            }}
          >
            <div className="modal-body">
              <input
                className="input"
                aria-label="新名称"
                maxLength={120}
                value={rename.name}
                onChange={(e) => setRename({ ...rename, name: e.target.value })}
              />
            </div>
            <footer>
              <button type="button" onClick={() => setRename(undefined)}>
                取消
              </button>
              <button className="primary" type="submit">
                保存
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {props.settings}
      {featureTab && selected && (
        <PiFeatures
          key={selected.id}
          session={selected}
          runtime={runtime}
          environment={props.environment}
          storage={props.storage}
          projectEnabled={
            !selected.projectId || Boolean(state.projects.find((p) => p.id === selected.projectId)?.trusted)
          }
          initialTab={featureTab}
          close={() => setFeatureTab('')}
        />
      )}
      {runtime.auth && (
        <div className="auth-banner" role="status">
          <strong>{runtime.auth.message}</strong>
          {runtime.auth.code && <code>{runtime.auth.code}</code>}
          {runtime.auth.url && (
            <button onClick={() => void attempt(() => api.invoke('openLink', runtime.auth!.url!))}>
              打开登录页面
            </button>
          )}
          <button onClick={() => selected && void attempt(() => api.invoke('cancelLogin', selected.id))}>
            取消登录
          </button>
        </div>
      )}
      {prompts[0] && (
        <ExtensionPrompt
          key={prompts[0].id}
          request={prompts[0]}
          runtime={runtime}
          remaining={prompts.length - 1}
          respond={async (v) => {
            if (selected) await api.invoke('respond', selected.id, prompts[0].id, v);
          }}
        />
      )}
    </>
  );
}
