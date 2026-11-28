import { ArrowDownUp, Check } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_SIDEBAR_VIEW } from '../../shared/sidebar-view';
import type { SidebarView } from '../../shared/types';
import { useLayer } from '../hooks/useLayer';
import { fitMenuToWindow, focusMenuItem, handleMenuKeyDown, Submenu, useSubmenus } from './Submenu';

const groupLabels = { project: '项目', time: '时间', status: '状态', none: '不分组' };
const sortLabels = { updated: '最近更新', created: '创建时间', title: '名称' };
const groups = ['project', 'time', 'status', 'none'] as const;
const sorts = ['updated', 'created', 'title'] as const;
const displayOptions = [
  ['pinnedGroup', '置顶单独一组'],
  ['foldOlder', '收起 7 天前的会话'],
  ['teamMembers', '团队成员'],
] as const;

/**
 * 1. 用默认值判断提示圆点和「恢复默认」是否可用。
 * 2. 打开时定位主菜单并聚焦菜单项，Esc 优先关闭子菜单。
 * 3. 单选和主菜单操作执行后关闭，多选留在子菜单继续操作。
 */
export function SidebarViewMenu({
  view = DEFAULT_SIDEBAR_VIEW,
  onViewChange,
  onNewSection,
  canToggleAll,
  allExpanded,
  onToggleAll,
}: {
  view?: SidebarView;
  onViewChange: (change: Partial<SidebarView>) => void;
  onNewSection: () => void;
  canToggleAll: boolean;
  allExpanded: boolean;
  onToggleAll: (expanded: boolean) => void;
}) {
  // 1. 分区是独立保存的，只有显示设置的变化才点亮圆点。
  const modified =
    view.groupBy !== DEFAULT_SIDEBAR_VIEW.groupBy ||
    view.sortBy !== DEFAULT_SIDEBAR_VIEW.sortBy ||
    displayOptions.some(([key]) => view[key] !== DEFAULT_SIDEBAR_VIEW[key]);
  const title = modified ? '侧栏显示方式（已调整）' : '侧栏显示方式';
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialItem = useRef<'first' | 'last'>('first');
  const submenus = useSubmenus();

  function close(restoreFocus: boolean) {
    if (restoreFocus) triggerRef.current!.focus({ preventScroll: true });
    submenus.reset();
    setOpen(false);
  }

  // 2. 只注册父菜单这一层，第一次 Esc 只把焦点还给子菜单入口。
  useLayer(
    menuRef,
    open,
    () => {
      if (!submenus.dismiss()) close(true);
    },
    { kind: 'menu' },
  );
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current!;
    const menu = menuRef.current!;
    function position() {
      const anchor = trigger.getBoundingClientRect();
      const below = anchor.bottom + 4;
      const top =
        below + menu.offsetHeight <= document.documentElement.clientHeight - 8
          ? below
          : anchor.top - menu.offsetHeight - 4;
      fitMenuToWindow(menu, anchor.right - menu.offsetWidth, top);
    }
    position();
    focusMenuItem(menu, initialItem.current);
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        submenus.contains(target)
      )
        return;
      submenus.reset();
      setOpen(false);
    }
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, submenus]);

  // 3. 先把焦点还给来源按钮，再应用设置，避免列表重排后焦点丢失。
  function choose(change: Partial<SidebarView>) {
    close(true);
    onViewChange(change);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button sidebar-view-trigger"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) return close(true);
          initialItem.current = 'first';
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (open || event.nativeEvent.isComposing || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp'))
            return;
          event.preventDefault();
          initialItem.current = event.key === 'ArrowDown' ? 'first' : 'last';
          setOpen(true);
        }}
      >
        <ArrowDownUp size={17} aria-hidden="true" />
        {modified && <span className="sidebar-view-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-label="侧栏显示方式"
          className="context-menu sidebar-view-menu"
          onKeyDown={(event) => {
            if (event.key === 'Tab') return close(true);
            if (handleMenuKeyDown(event)) submenus.reset();
          }}
        >
          <Submenu submenus={submenus} label="分组" value={groupLabels[view.groupBy]}>
            {groups.map((groupBy) => (
              <button
                key={groupBy}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={view.groupBy === groupBy}
                onClick={() => choose({ groupBy })}
              >
                {groupLabels[groupBy]}
                {view.groupBy === groupBy && (
                  <Check className="sidebar-menu-check" size={14} aria-hidden="true" />
                )}
              </button>
            ))}
          </Submenu>
          <Submenu submenus={submenus} label="排序" value={sortLabels[view.sortBy]}>
            {sorts.map((sortBy) => (
              <button
                key={sortBy}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={view.sortBy === sortBy}
                onClick={() => choose({ sortBy })}
              >
                {sortLabels[sortBy]}
                {view.sortBy === sortBy && (
                  <Check className="sidebar-menu-check" size={14} aria-hidden="true" />
                )}
              </button>
            ))}
          </Submenu>
          <Submenu submenus={submenus} label="显示">
            {displayOptions.map(([key, label]) => {
              const disabled = key === 'foldOlder' && view.groupBy === 'time';
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitemcheckbox"
                  tabIndex={-1}
                  aria-checked={view[key]}
                  aria-disabled={disabled || undefined}
                  title={disabled ? '按时间分组时已按日期划分' : undefined}
                  onClick={disabled ? undefined : () => onViewChange({ [key]: !view[key] })}
                >
                  {label}
                  {view[key] && <Check className="sidebar-menu-check" size={14} aria-hidden="true" />}
                </button>
              );
            })}
          </Submenu>
          <div className="sidebar-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(true);
              onNewSection();
            }}
          >
            新建分区…
          </button>
          <div className="sidebar-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!modified}
            onClick={() => choose(DEFAULT_SIDEBAR_VIEW)}
          >
            恢复默认
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!canToggleAll}
            onClick={() => {
              close(true);
              onToggleAll(!allExpanded);
            }}
          >
            {allExpanded ? '全部收起' : '全部展开'}
          </button>
        </div>
      )}
    </>
  );
}
