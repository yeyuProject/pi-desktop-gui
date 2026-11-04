# UI13 操作反馈实现记录

日期：2026-11-03，2026-11-04 移植到 v0.14.66（`2b93a4d`）。需求原编号 UI11，因 v0.14.66 已有另一份 UI11（减少动态效果、跟随滚动、列表悬停与通知计时），本需求改为 UI13，并以 v0.14.66 的 UI11 为准：动效变量、减少动态效果的处理、通知悬停暂停和带操作通知的时长都沿用 UI11，本次只补 UI11 没有的部分。

**2026-11-04 移植后已在 Windows 本机验证：** `npm run build`、`lint`、`format:check` 通过；`npm test` 845 项，835 通过、10 项平台跳过、0 失败；`test:feedback-motion-ui`（三套外观 × 明暗）、UI11 的 `test:motion-ui`、`test:optimizations-ui`、`test:connection-ui`、`test:pi-settings-ui`、`test-coding-ui` 通过。首次运行 `test:feedback-motion-ui` 发现并修正：保存按钮最小宽度被 `.modal footer button` 覆盖；测试脚本在第二套外观前没有恢复侧栏，以及几处与 UI11 计时（悬停暂停全部、重新完整计时）不符的等待。macOS、Linux 未在本机运行。

**2026-11-04 补充修正。** 推送后运行 `test:chat-ui` 发现：同一句提示连续出现两次（例如选区跨消息时的引用提示）会叠出两条相同的提示，旧的单条提示状态不会这样。现在同级别、同文字的提示再次出现时替换原来那条：生成新 id、重新播放进场并重新计时，不再叠加。`notice-store.test.ts` 和 `test:feedback-motion-ui` 已按此更新。

## 改动

- `src/lib/notice-store.ts` 持有提示和计时器，只有 `Toasts` 通过 `useSyncExternalStore` 订阅。`useWorkbench` 不再保存提示状态，运行时通知按会话和递增 ID 转入 store，切换会话时不重放旧通知。
- 沿用 UI11 的 `--motion-fast`（120 ms）、`--motion-base`（160 ms）和 `--ease-out`，只新增退场用的 `--ease-in`。提示入场沿用 UI11 的 `rise`；退场和错误条使用 `--motion-fast`。提示、错误条只对透明度和位移播放动画，不改变高度。
- 提示从对话区右上角进入，退场保留 120 ms 后由计时器移除。设置弹窗、图片查看器等模态界面打开时，改用窗口右上角；背景审批卡不参与弹窗的位置计算。
- 对话中限制提示的高度，避开输入区及可见审批卡。空间小到放不下一条时暂时隐藏并暂停剩余时间，空间恢复后再显示。提示过长时内部滚动，不向下覆盖输入框。
- 按 UI11：鼠标悬停或焦点在提示区时暂停全部提示的计时，离开后每条重新完整计时；提示区随最后一条提示卸载时解除暂停。操作进行中和空间不足仍按单条暂停。错误提示不自动消失；带操作提示至少 6 秒；警告 9 秒；后台信息至少 5 秒；其余至少 3.5 秒，长文字最多延长到 8 秒。
- 最多三个提示节点，正在退场的也占一个位置。待显示队列也最多三条；突发消息优先舍弃最旧的普通提示，保留错误。满屏都是错误时，普通新提示不挤掉错误；新的错误可替换最旧的错误。
- 设置保存仅在本次保存期间转圈，成功后按钮显示“已保存”1.5 秒；平时没有勾号，失败不显示成功。按钮有固定最小宽度，删除重复的页脚和全局成功提示。
- `CopyButton` 和 `useCopyFeedback` 提供消息、错误详情、问答、代码、技能、路径和侧边对话的就地反馈。重复复制重播勾号；复制失败不会显示成功。
- `ErrorFeedback` 在错误清空后保留内容至退场结束，不依赖 `animationend`。历史消息或整个弹窗被移除时仍跟随所属界面卸载，不为离开的界面额外保留浮层。
- 通知组件和图片查看器按现有弹窗方式拆为延迟加载模块；图片查看器仍可在空闲时预加载。主包构建输出为 **646.68 kB**（Vite 十进制），未超过现有 650 kB 门槛。此数字是文件大小，不是运行性能测量。

## 提示调用点逐项分类

PRD 的“35 处”为近似数。对 `f3b3c1c` 的 `setNotice(...)` / `notice(...)` 调用逐项检查，实际有 37 处非空反馈，另有两处清空状态。以下路径均相对仓库根目录，位置按函数和提示内容标识，避免改行后失效。

| # | 调用位置 / 反馈 | 本次处理和原因 |
|---|---|---|
| 1 | `Composer` 切换审批方式 | 改为输入区附近说明，控件仍在原处 |
| 2 | `Conversation` 引用原文不在当前分支 | 保留全局警告，跳转没有可落到的原文 |
| 3 | `Conversation` 找不到 Goal 结果 | 保留全局警告，同上 |
| 4 | `Conversation` 本会话放行 | 保留全局，审批卡消失；附至少 6 秒的撤销操作 |
| 5 | `Conversation` 撤销放行规则 | 保留全局，原审批卡已经消失 |
| 6 | `SettingsModal` 清理空会话 | 改为清理按钮旁结果；取消不显示结果 |
| 7 | `Sidebar` 导出 HTML | 保留全局，菜单关闭，文件在外部目录 |
| 8 | `Sidebar` 删除会话 | 保留全局，菜单和目标会话消失 |
| 9 | `ComposerStatus` 复制错误详情 | 改为错误卡复制按钮的勾号和标签 |
| 10 | `SelectionMenu` 快捷键跨消息引用 | 保留全局说明，解释为何只引用第一条 |
| 11 | `SelectionMenu` 点击跨消息引用 | 保留全局说明，引用后选区工具栏关闭 |
| 12 | `SelectionMenu` 复制选区 | 改为工具栏按钮勾号，复制后工具栏保留 |
| 13 | `TurnOutline` 本轮没有回复可复制 | 保留全局，键盘操作没有可展示的复制结果 |
| 14 | `features/McpTab` 重新加载 | 保留已有弹窗内反馈，不进入全局 store |
| 15 | `features/McpTab` MCP 操作完成 | 保留已有弹窗内反馈 |
| 16 | `features/ProvidersTab` 移除登录凭据 | 保留已有弹窗内反馈 |
| 17 | `features/ProvidersTab` 添加模型到配置 | 保留已有弹窗内反馈 |
| 18 | `features/SessionTab` 压缩完成和摘要 | 保留已有弹窗内反馈 |
| 19 | `features/SessionTab` 分享链接 | 保留已有弹窗内反馈 |
| 20 | `features/usePiFeatures` 导出 | 保留已有弹窗内反馈 |
| 21 | `features/usePiFeatures` 保存配置 | 保留已有弹窗内反馈，区分保存、应用和延后加载 |
| 22 | `useDraft` 已引用文件 | 删除重复提示，输入框文件项已经显示结果 |
| 23 | `useWorkbench` 用输入框回答 | 保留全局，回答后提问卡消失 |
| 24 | `useWorkbench` 草稿发生变化 | 保留全局警告，说明本次为何没有发送 |
| 25 | `useWorkbench` `/compact` | 保留全局，命令输入已经清空 |
| 26 | `useWorkbench` `/reload` | 保留全局，同上 |
| 27 | `useWorkbench` `/copy` | 保留全局，命令没有可持续显示的复制按钮 |
| 28 | `useWorkbench` `/share` | 保留全局，命令输入清空，链接在剪贴板 |
| 29 | `useWorkbench` 添加项目 | 保留全局，原生选择窗口关闭，结果在侧栏 |
| 30 | `useWorkbench` 保存设置 | 删除全局反馈，仅由设置按钮显示结果 |
| 31 | `useWorkbench` 登录供应商 | 保留全局，登录流程完成后原界面可能已关闭 |
| 32 | `useWorkbench.copy` 通用复制 | 删除通用全局反馈，调用处用 `CopyButton`；“复制完整内容”菜单点后关闭，由菜单单独发全局反馈 |
| 33 | `useWorkbench` 编辑旧消息 | 保留全局，已切换对话分支和草稿 |
| 34 | `useWorkbench` 从消息创建分支 | 保留全局，结果在新的会话 |
| 35 | `useWorkspace` 恢复文件 | 删除重复提示，恢复对话框已显示数量和后续操作 |
| 36 | `useWorkspace` 回到消息之前 | 保留全局，对话内容已切换 |
| 37 | `useWorkspace` 还原到恢复前 | 保留全局，备份还原后需要告知结果 |

原 `useWorkbench` 的 3.5 秒清空调用已删除，由 store 管计时。`features/usePiFeatures` 的清空仍只作用于它自己的弹窗。`SettingsForm` 经 `notify` 参数显示的配置保存结果也仍在该弹窗里。

## 已编写但未运行的验收

| 文件 | 检查内容 | 本次结果 |
|---|---|---|
| `tests/notice-store.test.ts` | 可注入时钟；长度和级别时长、递增 ID、重复文字、独立暂停和剩余时间、最多三条含退场、突发队列、错误优先、释放计时器 | 未运行 |
| `scripts/test-feedback-motion-ui.mjs` | 六种外观；普通/保存中/保存成功按钮等宽；失败不报成功；重复复制和提示；900/1600 宽度、侧栏开关和审批卡不重叠；悬停/焦点暂停；撤销操作；五条提示上限；减少动态效果；错误手动关闭 | 未运行 |
| 同上，CDP trace | 使用真实 CSS 的入场和退场；先完成节点插入布局，再录制动画区间，检查动画属性及 Layout；输出 trace 和截图供查看 | 未运行，尚无性能结论或截图 |
| `scripts/test-performance-ui.mjs` | 从真实轮次目录键盘操作发出提示，不注入 runtime/state 事件；统计 App、Conversation、Composer、Sidebar、Toasts 的实际提交次数 | 未运行，尚无“提交次数为 0”的实测证据 |
| `scripts/test-optimizations-ui.mjs` | 保存成功改查按钮，页脚和全局不重复显示 | 未运行 |
| `scripts/test-connection-ui.mjs` | 错误详情仍复制脱敏原文，按钮就地显示成功、没有全局提示 | 未运行 |

`npm run test:feedback-motion-ui` 和后续 CI 步骤已配置。本次未启动。

## 静态检查

- `npm run build`：通过，包含 TypeScript 检查、renderer 和主进程构建。
- `npm run lint`：通过。
- `npm run format:check`：通过。
- `git diff --check` 和三份修改过的 UI 脚本的 `node --check`：通过；`node --check` 只检查语法，没有运行脚本。
- 不把构建通过视为动画、矩形位置、可访问性、截图或性能验收通过。
