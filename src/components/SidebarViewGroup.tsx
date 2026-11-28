import { ChevronDown, Layers, MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SidebarGroup, SidebarSectionGroup } from '../lib/sidebar-groups';
import { IconButton } from './IconButton';

export function SidebarViewGroup({
  group,
  expanded,
  onToggle,
  section,
  children,
}: {
  group: SidebarGroup;
  expanded: boolean;
  onToggle?: () => void;
  section?: { data: SidebarSectionGroup; menuOpen: boolean; toggleMenu: () => void; menu?: ReactNode };
  children: ReactNode;
}) {
  const pinnedCount = section?.data.pinnedCount ?? 0;
  return (
    <div
      className="sidebar-view-group project-group"
      data-sidebar-group={group.key}
      data-drop-target={section ? group.key : undefined}
    >
      {onToggle ? (
        <div className="project-header">
          <button className="project-row" aria-expanded={expanded} onClick={onToggle}>
            {section && <Layers size={16} />}
            <span title={group.label}>{group.label}</span>
            {section && (
              <>
                <small className="sidebar-section-count">{group.rows.length + pinnedCount}</small>
                <span className="session-drop-label">放进分区</span>
              </>
            )}
            <ChevronDown size={13} className="project-chevron" />
          </button>
          {section && (
            <div className="project-actions">
              <IconButton
                title={`${group.label} 分区操作`}
                expanded={section.menuOpen}
                onClick={section.toggleMenu}
              >
                <MoreHorizontal size={15} />
              </IconButton>
            </div>
          )}
          {section?.menu}
        </div>
      ) : (
        <div className="section-heading">{group.label}</div>
      )}
      {expanded && (
        <div className="session-list" aria-label={`${group.label} 的会话`}>
          {children}
          {section && (pinnedCount > 0 || !group.rows.length) && (
            <p className="sidebar-empty sidebar-section-note">
              {pinnedCount
                ? `另有 ${pinnedCount} 个置顶会话显示在置顶组`
                : '把会话拖到这里，或在会话菜单中选择“放入分区”'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
