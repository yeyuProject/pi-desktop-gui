import {
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Command,
} from 'lucide-react';
import { shortcut } from '../lib/platform';
import { IconButton } from './IconButton';
import type { Workbench } from '../hooks/useWorkbench';

export function WorkspaceHeader(
  props: Pick<
    Workbench,
    | 'setFeatureTab'
    | 'sidebar'
    | 'setSidebar'
    | 'compact'
    | 'inspector'
    | 'setInspector'
    | 'changes'
    | 'selected'
    | 'project'
    | 'ownRuntime'
    | 'running'
    | 'activities'
    | 'state'
    | 'selectSession'
  >,
) {
  const { setFeatureTab, sidebar, setSidebar, compact, inspector, setInspector, changes, selected, project } =
    props;
  const waiting = props.state?.sessions.filter((session) => props.activities[session.id]?.pending > 0) ?? [];

  return (
    <header className="workspace-header" inert={inspector && compact}>
      <IconButton
        title={`${sidebar ? '收起' : '展开'}项目侧栏 ${shortcut('B')}`}
        onClick={() => setSidebar((v) => !v)}
        expanded={sidebar}
        controls="project-sidebar"
      >
        {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
      </IconButton>
      <div className="workspace-title">
        <h1 title={selected?.title}>{selected?.title || 'Pi Desktop'}</h1>
        <div className="breadcrumb" title={project?.path}>
          <span>{project?.name || '独立对话'}</span>
          {project && changes?.branch && (
            <span className="branch">
              <GitBranch size={12} />
              {changes.branch}
            </span>
          )}
        </div>
      </div>
      <div className="header-actions">
        <button disabled={!selected} onClick={() => window.dispatchEvent(new Event('pi:side'))}>
          侧边对话
        </button>
        {waiting.length > 0 && (
          <button
            className="attention-button"
            aria-live="polite"
            title={waiting.map((session) => session.title).join('、')}
            onClick={() => {
              const next = waiting.find((session) => session.id !== selected?.id) ?? waiting[0];
              void props.selectSession(next);
            }}
          >
            待回复 {waiting.reduce((sum, session) => sum + props.activities[session.id].pending, 0)}
          </button>
        )}
        <button aria-label="Pi 功能" disabled={!selected} onClick={() => setFeatureTab('session')}>
          <Command size={16} />
          <span>Pi 功能</span>
        </button>
        {selected && (
          <button
            className={'workspace-toggle ' + (inspector ? 'active' : '')}
            aria-label={inspector ? '收起工作区面板' : project ? '查看工作区变更' : '查看会话输出'}
            aria-expanded={inspector}
            aria-controls="workspace-inspector"
            onClick={() => setInspector((v) => !v)}
            title={project ? '变更、文件与输出' : '当前会话的工具输出'}
          >
            {inspector ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            <span>{project ? '工作区' : '输出'}</span>
            {project && !!changes?.files.length && <span className="count">{changes.files.length}</span>}
          </button>
        )}
      </div>
    </header>
  );
}
