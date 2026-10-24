export const workbenchShortcuts = [
  { action: 'new', key: 'n', mod: true, label: '新建独立对话' },
  { action: 'search', key: 'k', mod: true, label: '搜索会话与操作' },
  { action: 'find', key: 'f', mod: true, label: '查找当前会话' },
  { action: 'sidebar', key: 'b', mod: true, label: '收起或展开侧栏' },
  { action: 'inspector', key: 'j', mod: true, label: '收起或展开工作区面板' },
  { action: 'changes', key: '1', alt: true, label: '查看工作区变更' },
  { action: 'files', key: '2', alt: true, label: '查看项目文件' },
  { action: 'output', key: '3', alt: true, label: '查看命令输出' },
  { action: 'settings', key: ',', mod: true, label: '打开设置' },
  { action: 'editDraft', key: 'g', mod: true, label: '在外部编辑器中编辑草稿' },
  { action: 'shortcuts', key: '/', mod: true, label: '显示快捷键' },
] as const;
export type WorkbenchAction = (typeof workbenchShortcuts)[number]['action'];
