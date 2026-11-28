import { PiFeatures, QuickSwitch } from '../lib/lazy-dialogs';
import { Modal } from './Modal';
import { ExtensionPrompt } from './ExtensionPrompt';
import { ShortcutsHelp } from './ShortcutsHelp';
import { readableError } from '../lib/format';
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
    | 'onAuthenticated'
    | 'attempt'
    | 'setNotice'
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
          title={
            {
              project: '重命名项目',
              session: '重命名会话',
              section: '重命名分区',
              'new-section': '新建分区',
            }[rename.kind]
          }
          close={() => {
            if (!rename.saving) setRename(undefined);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (rename.saving) return;
              if (rename.kind === 'new-section' || rename.kind === 'section') {
                setRename({ ...rename, saving: true, error: undefined });
                try {
                  if (rename.kind === 'section') await api.invoke('renameSection', rename.id, rename.name);
                  if (rename.kind === 'new-section') {
                    const section = await api.invoke('createSection', rename.name, rename.sessionId);
                    if (
                      state.settings.sidebarView?.pinnedGroup &&
                      state.sessions.find((session) => session.id === rename.sessionId)?.pinned
                    )
                      props.setNotice(`已放进分区“${section.name}”，置顶期间显示在置顶组`);
                  }
                  setRename(undefined);
                } catch (error) {
                  setRename({ ...rename, saving: false, error: readableError(error) });
                }
                return;
              }
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
                maxLength={rename.kind === 'section' || rename.kind === 'new-section' ? undefined : 120}
                value={rename.name}
                disabled={rename.saving}
                onChange={(e) => setRename({ ...rename, name: e.target.value, error: undefined })}
              />
              {rename.error && <p role="alert">{rename.error}</p>}
            </div>
            <footer>
              <button type="button" disabled={rename.saving} onClick={() => setRename(undefined)}>
                取消
              </button>
              <button className="primary" type="submit" disabled={rename.saving}>
                {rename.kind === 'new-section' ? '创建' : '保存'}
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
          onAuthenticated={props.onAuthenticated}
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
