# UI11 动画与交互细节验证

2026-11-04，macOS 27.2，Node 26.8.1，Electron 44.7.0。需求见 PRD「动画与交互细节」UI11，基线为 v0.14.65（`d177412`），修改位于 `ui/motion-interaction`。

## 实现

- 减少动态效果：保留全局关闭动画和过渡的规则，只对 `.spin` 例外（原地旋转）。脚本平滑滚动经 `src/lib/motion.ts` 的 `smoothBehavior()`，在减少动态效果时改为 `instant`。
- 动效变量：`:root` 新增 `--motion-fast`（120 ms）、`--motion-base`（160 ms）、`--ease-out`，替换原有的 80–160 ms 写法。弹窗遮罩加 `fade-in`；查找栏、「回到最新」加 `rise`，后者改用 `translate: -50% 0` 居中。拖拽条的 150 ms 延迟只在进入悬停时生效。会话行的更多按钮淡入。
- 列表悬停：模型选择、快速切换、`/` 命令从 `onMouseEnter` 改为 `onMouseMove`。
- 通知：悬停或聚焦通知区时暂停计时，离开后重新计时，通知区卸载时解除暂停；带操作的提示从 3.5 秒延长到 6 秒。
- 跟随滚动：`src/lib/follow-scroll.ts` 根据滚轮和按键方向，在 24 px 和 2 px 两种阈值之间切换。对话区和思考块共用。
- 「回到最新」位置：Composer 写入 `--composer-offset`，替换提问面板的 `--ask-composer-height`。
- 阅读位置：对话区记录最近滚动位置，切换会话时在布局阶段清理中调用 `saveView`；原有的鼠标离开保存保留。

## 已验证

- `npx tsc --noEmit`、`npm run lint`、`npm run format:check`、`npm run build` 通过。
- `npm test`：837 项，835 通过、2 跳过、0 失败。其中新增 `tests/follow-scroll.test.ts` 3 项。
- `npm run test:motion-ui`（新增 `scripts/test-motion-interaction-ui.mjs`）：真实 Electron 渲染器，本地运行时事件，不请求模型。7 项全部通过。
- 用同一测试在基线代码上运行（每节失败不中断），确认能发现原问题：

  | 检查 | 基线 | 本次 |
  | --- | --- | --- |
  | 减少动态效果下 `.spin` 仍旋转 | 失败（`none`） | 通过 |
  | 上滚 12 px 停止跟随 | 失败（不出现「回到最新」） | 通过 |
  | 输入框增高后按钮在输入框上方 | 失败（被遮住 81.4 px） | 通过 |
  | 滚回底部恢复跟随 | 通过（原有行为） | 通过 |
  | 列表滚动时选中项不被静止的鼠标抢走 | 失败 | 通过 |
  | 悬停通知 6 秒不关闭 | 失败（悬停时已关闭） | 通过 |
  | 键盘新建会话时保存上一会话位置 | 失败（0 次 `saveView`） | 通过 |

- 原有界面测试通过：`npm run test:chat-ui`（35 项）、`npm run test:user-bubble-ui`、`npm run test:style-ui`，以及 `scripts/test-scroll-ui.mjs`、`scripts/test-interaction-performance-ui.mjs`、`scripts/test-ask-ui.mjs`、`scripts/test-conversation-v014-ui.mjs`、`scripts/test-polish-ui.mjs`、`scripts/test-model-switch-ui.mjs`、`scripts/test-image-input-ui.mjs`、`scripts/test-transcript-ui.mjs`、`scripts/test-placeholder-lifecycle-ui.mjs`。

## 修正的原有 macOS 测试问题

以下三个脚本在基线代码上同样失败，原因都在测试本身，产品代码未改：

- `scripts/test-optimizations-ui.mjs:104`：用 `bootstrap` 读取环境。`bootstrap` 会在后台重新检测环境但不等结果（`electron/main.ts:798`），检测结果晚到，覆盖了随后注入的 Node 错误，弹窗不再给「Node.js 入口」加 `data-autofocus`。本机检测较慢，总是输掉这个竞态。改用 `detect`，它在广播结果后才返回。修正后 11 组检查全部通过，包括放行后的「撤销」通知。
- `scripts/test-experience-ui.mjs:195`：macOS 上关闭窗口只隐藏窗口（`electron/main.ts:1010-1012`），测试却等待应用退出。macOS 上改用 `app.quit()`，它经过同一个关闭处理。修正后 6 项通过，包括关闭时保存窗口尺寸、重启后恢复。
- `scripts/test-ui.mjs:35,85`：写死了「收起项目侧栏 Ctrl+B」和 `Control+b`，macOS 上为 `⌘B` 和 `Meta+b`。改为按平台取值。修正后通过。

## 未完成与已知问题

- **主 JS 包超出 PF3 上限 0.50 kB。** 基线为 648.95 kB，本次为 650.50 kB（gzip 208.20 kB），PF3 验收第 4 条要求不大于 650 KB。新增的两个辅助模块压缩后约 630 字节，其余来自组件改动。2026-11-04 用户确认接受这 0.50 kB，不为此调整代码。
- 退出动画、面板展开收起动画、`<details>` 展开动画按 PRD 不在本次范围内。
- 只在 macOS 上运行过。CI 会在 Ubuntu 上运行新测试；Windows 未验证。

截图位于忽略目录 `output/playwright/motion-darwin/`。界面测试使用隔离的数据目录和示例数据，未修改用户会话。
