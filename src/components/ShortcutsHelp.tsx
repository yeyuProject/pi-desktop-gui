import { modKey, shortcut } from '../lib/platform';
import { Modal } from './Modal';
import { workbenchShortcuts } from '../../shared/workbench-actions';

export const shortcutGroups: [string, [string[], string][]][] = [
  [
    '输入',
    [
      [['Enter'], '发送'],
      [['Shift', 'Enter'], '换行'],
      [['↑', '↓'], '输入框为空时翻看本会话发送过的提问'],
      [['/'], '命令菜单；Tab 补全'],
      [['@'], '引用项目文件；也可把文件拖进输入框'],
      [[modKey, 'V'], '粘贴图片'],
    ],
  ],
  [
    '运行',
    [
      [['Esc', 'Esc'], '执行中连按两次，停止当前会话并把队列恢复到草稿'],
      [[modKey, 'Shift', 'A'], '定位当前审批的允许按钮；审核后再按一次允许'],
      [[modKey, 'Shift', 'D'], '填写当前审批的拒绝原因'],
      [['Alt', 'PageUp / PageDown'], '在变更面板中查看上一个或下一个文件'],
      [['Alt', '[ / ]'], '在差异视图中查看上一个或下一个改动段'],
      [['!命令'], '执行终端命令，输出加入上下文'],
      [['!!命令'], '执行终端命令，输出不进入上下文'],
    ],
  ],
  [
    '导航',
    [
      ...workbenchShortcuts.map((binding): [string[], string] => [
        ['mod' in binding ? modKey : 'Alt', binding.key.toUpperCase()],
        binding.label,
      ]),
      [['Esc'], '关闭弹窗或工作区面板'],
    ],
  ],
];
export function ShortcutsHelp({ close }: { close: () => void }) {
  return (
    <Modal title="键盘快捷键" subtitle={`${shortcut('/')} 随时打开`} close={close}>
      <div className="modal-body shortcut-help">
        {shortcutGroups.map(([group, rows]) => (
          <section key={group}>
            <h3>{group}</h3>
            {rows.map(([keys, label]) => (
              <div key={label}>
                <span>
                  {keys.map((k, i) => (
                    <kbd key={i}>{k}</kbd>
                  ))}
                </span>
                <p>{label}</p>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
