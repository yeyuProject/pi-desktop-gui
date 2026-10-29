# Pi 桌面 GUI 产品需求文档

首版功能 页面与交互设计

## 代码腐化治理（待实现）

### H1 文档、测试入口与代码现状重新对齐

2026-10-29 基于 `main@f1eb0cd`（v0.14.56）排查。排查方法：`tsc --noUnusedLocals --noUnusedParameters`、只在声明文件中出现的导出、文档引用的路径是否存在、`scripts/test-*` 是否接入 `package.json` 和 CI、文件行数与 v0.8.0 R2 的对比，以及版本号和发布说明的核对。`npm run lint` 和 `npm run format:check` 均通过。代码本身没有大面积腐化，问题集中在三类：本文档的数字与基线落后于代码；有测试未接入任何入口；两个主进程文件重新膨胀。

**背景与问题。**

1. **本文档写的 Pi 回归基线还是 1.1.0。** v0.14.47（`2656235`）已把 `shared/pi-version.ts:2` 的 `VERIFIED` 和开发依赖改为 1.4.0，双语 README 和 `docs/goal.md:69` 同步改了，本文档没改。仍写 1.1.0 的位置：“12 官方资料与版本依据”开头两段、F01 环境检查、v0.7.0 小节开头的审批验收说明、S1 的“跨目录验证结论”。S1–S11 引用的 `blob/v1.1.0` 文档链接也没有按 1.4.0 重新核对。“版本升级必须重新运行协议和生命周期验收”这条约定，目前没有记录可以证明已经执行过。
2. **R2 的数字已经过时，拆分成果在退化。** R2 写的是“`App.tsx` 为 73 行，`src/` 最大文件为 676 行”。v0.8.0 定的上限是 `App.tsx` ≤ 400 行、单个文件 ≤ 800 行。现在 `src/App.tsx` 483 行；`src/` 下超过 800 行的有 `components/Conversation.tsx`、`components/Composer.tsx`（均 873 行）、`hooks/useWorkbench.ts`（841 行）、`styles/conversation-v014.css`（815 行）。主进程两个文件在 v0.8.0 时约 1200 行，现在 `electron/agent.ts` 2527 行、`electron/main.ts` 2346 行。v0.8 验收记录（`docs/v0.8-validation.md:40`）当时就点名这两处，建议继续拆分。之后 Goal 和侧边对话又直接加进 `AgentService`（`agent.ts:1462` `goalAction`、`agent.ts:2344` `sideChat`），`main.ts:571` 的 `handlers` 也还有 90 个左右的方法。目前只有工作区相关的 IPC 拆到了 `electron/ipc/workspace-handlers.ts`。
3. **执行约定被绕开。** “执行约定”要求平台差异统一放在 `electron/platform.ts`。下列位置仍直接判断 `process.platform`，且 `platform.ts` 已导出 `isWindows`：`electron/snapshot.ts:43`、`electron/environment.ts:48`（同一函数下一行就用了 `isWindows`）、`electron/main.ts:246`、`main.ts:1663`、`main.ts:1729`。`main.ts:541`、`main.ts:1922`、`main.ts:1946` 是把平台值传给诊断和更新模块，属于数据传递，不在本条范围内。
4. **有测试没有接入入口。**
   - `scripts/test-workspace-v014-performance.ts` 不在 `package.json` 的任何命令中，CI 也不运行。`docs/v0.14-validation.md:53` 把它列为 v0.14 的性能证据。脚本目前仍能运行（本机 1 万文件中位 153 ms），但只打印结果、没有断言，回归时不会失败。
   - 另有 7 个 `test:*` 命令没有出现在 CI 中，但都不算问题：`test:scroll-ui`、`test:transcript-ui`、`test:images-ui` 已包含在 `test:ui` 里，`test:v014-ui`、`test:retry-ui` 包含在 `test:features-ui` 里，`test:retry` 包含在 `test:features` 里，`test:concurrency` 的两个脚本 CI 已分别运行。它们只是本地快捷方式。
5. **本文档引用的测试文件不存在。** W3 和 E1 的“测试”段写的 `tests/workspace.test.ts` 从未存在。实际覆盖分别在 `tests/workspace-watch.test.ts` 和 `tests/workspace-v014.test.ts`。
6. **未使用的符号。** lint 规则用 `args: 'none'` 关闭了未使用参数检查，`varsIgnorePattern: '^_'` 放过了下划线变量，所以下列问题 lint 发现不了，`tsc --noUnusedLocals --noUnusedParameters` 能报出来：
   - `electron/main.ts:254` `_lastToast` 只写不读。注释说明是为了保留通知对象，避免点击回调被回收，属于有意为之，但没有测试保护。
   - `src/features/HelpTab.tsx:4` 的 `source`、`src/features/ProvidersTab.tsx:15,36` 的 `filter`、`disabled`、`src/hooks/useLayer.ts:8` 的 `action`：组件和函数签名声明了但没有使用。
   - 只在声明文件中出现、项目内无调用的导出：`electron/updater.ts:69` `fetchReleaseNotes`、`electron/platform.ts:339` `trashName`。
   - `electron/updater.ts` 的 `installOnQuit` 字段始终为 `false`，`prepareForQuit(_allowInstall)` 忽略参数。`main.ts` 的三处调用（1762、1842、1992 行）都不会产生实际效果。
7. **`any` 集中在 Pi 事件入口。** `src`、`electron`、`shared` 共 42 处 `any`，15 处在 `electron/agent.ts`，包括事件入口 `onEvent(record: any)`（460 行）和扩展入口 `extension(record: any)`（738 行）。lint 以“Pi 载荷是动态的”为由关闭了 `no-explicit-any`。RPC 响应已经由 `electron/pi/protocol.ts` 的 `validateRpcResult` 校验，但事件流（`text_delta`、`toolcall_end`、`message_end`、`agent_settled`、`extension_ui_request` 等）仍然直接按字段读取。这和 R3“不猜测字段”的约定不一致：Pi 改了事件字段时，只会表现为界面静默缺内容，不会报协议错误。
8. **以版本号命名的文件。** `src/styles/conversation-v014.css`、`src/styles/workspace-v014.css`、5 个 `tests/*-v014.test.ts` 和 4 个 `scripts/test-*-v014*` 都按 v0.14.0 的交付批次命名。`conversation-v014.css` 之后又经过 v0.14.20、v0.14.39、v0.14.48、v0.14.50、v0.14.53、v0.14.56 的修改，已经不是“v0.14 的样式”。从文件名看不出职责，新功能的样式只能凭记忆找位置。
9. **本文档节标题缺版本号，发布说明有重复。** 从 v0.14.41 到 v0.14.53，以下实际发布的功能在本文档中没有对应小节：v0.14.41 的变更哈希与模型列表缓存、v0.14.42 与 v0.14.45 的回复 TPS、v0.14.43 的“默认展开思考过程”、v0.14.47 的 Pi 1.4.0 基线与内置工具设置重连、v0.14.52 的超出发送上限时保留草稿。“Goal 状态卡与已实现功能修正”“对话内容引用与侧边对话”“长提问折叠与按轮次复制结果”三节没有标注版本号（实际为 v0.14.53、v0.14.50/51、v0.14.50/51）。`docs/releases/v0.14.48.md` 和 `v0.14.49.md`、`v0.14.50.md` 和 `v0.14.51.md` 正文相同，仅后者补充了“前一版未公开发布”的说明。
10. **执行约定第 7 条没有落实。** 约定要求未做完的部分直接删除、不保留待办，但 v0.7.0 的“长会话性能（原 C4）”还留着“`App.tsx` 的拆分见下一版 R2”。R2 早已交付，这句话已经过时。

**目标。** 本文档中的数字、基线和文件路径与代码一致；每个测试脚本要么有断言并接入 CI，要么写明是手动度量工具；主进程两个文件不再承载新的功能模块；执行约定可以通过自动检查保证，而不是靠记忆。

**不做。**

- 不为了降低行数增加纯转发的模块层。拆分以职责为准，与 `docs/v0.8-validation.md:40` 的建议一致。
- 不把 `any` 全部换成精确类型。只要求进入 `AgentService` 的事件先经过协议层校验。
- 不重写发布说明的历史文件，只在本文档补齐缺失的小节。
- 不清理 `work/`、`test-results/`、`release/` 等本地目录。它们已被 `.gitignore` 排除，不影响仓库。

**修正项。**

| 编号 | 修正 | 位置 |
| --- | --- | --- |
| H1-1 | 按 Pi 1.4.0 重新核对 S1–S11 链接与第 12 节说明；F01、v0.7.0、S1 中的“1.1.0”改为引用当前基线，跨目录结论注明验证时使用的版本。基线升级流程写入执行约定：改 `VERIFIED` 时同步检查本文档 | `docs/PRD.md` S1、v0.7.0、F01、第 12 节 |
| H1-2 | R2 数字改为当前值，并注明“v0.8.0 时为 73 / 676 行”；文件行数上限加入 `npm run lint`（`App.tsx` ≤ 500 行、`src/` 与 `electron/` 单个文件 ≤ 900 行，`agent.ts`、`main.ts` 暂按现状设上限，只允许减少） | `docs/PRD.md` R2、`tools/lint/config.mjs` |
| H1-3 | 侧边对话和 Goal 从 `AgentService` 拆出独立服务，`AgentService` 只保留 Pi 进程生命周期与事件分发；`main.ts` 的侧边对话、Goal、Pi 配置类 handler 仿照 `ipc/workspace-handlers.ts` 迁出 | `electron/agent.ts:1462,2344`、`electron/main.ts:571` |
| H1-4 | 5 处 `process.platform` 判断改用 `platform.ts` 导出的常量或函数；lint 增加 `no-restricted-properties` 规则，禁止 `platform.ts`、`preload.ts` 之外直接读取 `process.platform` | `electron/snapshot.ts:43`、`environment.ts:48`、`main.ts:246,1663,1729` |
| H1-5 | `test-workspace-v014-performance.ts` 增加耗时与增量比例断言（阈值取当前实测值的 2 倍），加入 `test:performance-core` 并进入 CI；或在脚本顶部和 `v0.14-validation.md` 注明为手动度量工具 | `scripts/test-workspace-v014-performance.ts` |
| H1-6 | W3、E1 测试说明改为实际文件 | `docs/PRD.md` W3、E1 |
| H1-7 | 删除未使用的参数和导出（`source`、`filter`、`disabled`、`action`、`fetchReleaseNotes`、`trashName`）；删除 `installOnQuit` 与 `prepareForQuit` 及其调用；`_lastToast` 改名为 `retainedToast` 并补充说明，不再依赖下划线豁免 | 见背景第 6 条 |
| H1-8 | Pi 事件进入 `AgentService` 前先由 `electron/pi/protocol.ts` 校验类型与必需字段。字段不符时触发 `protocolError`，诊断中记录事件类型，不再静默丢失内容。`onEvent`、`extension` 的参数改为校验后的联合类型 | `electron/agent.ts:460,738`、`electron/pi/protocol.ts` |
| H1-9 | 按职责重命名 `-v014` 文件，例如 `conversation-v014.css` 按内容拆为 `turn-outline.css` 和 `code-block.css`，测试文件名对应被测模块。一次重命名一组，`git mv` 保留历史 | 背景第 8 条所列文件 |
| H1-10 | 补齐背景第 9 条所列版本的小节，给三个无版本号小节加上版本号 | `docs/PRD.md` |
| H1-11 | 删除 v0.7.0 小节中过时的“下一版 R2”说明 | `docs/PRD.md` v0.7.0“长会话性能（原 C4）” |

**验收。**

1. 本文档中除 S1–S11 历史链接外，不再出现与 `shared/pi-version.ts` 不一致的回归基线版本。
2. 本文档中以反引号引用的 `electron/`、`src/`、`shared/`、`scripts/`、`tests/` 路径全部存在，示例路径（如验收用例中的 `src/a.ts`）除外。可以写成单元测试自动检查。
3. `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` 无输出。
4. `scripts/test-*` 下的每个文件都被 `package.json` 或 CI 引用，或在文件顶部注明是手动工具。
5. `electron/agent.ts`、`electron/main.ts` 的行数低于本次排查时的 2527、2346 行；新增功能不再直接加入这两个文件。
6. 在 `platform.ts`、`preload.ts` 之外新增 `process.platform` 判断时，`npm run lint` 失败。
7. 构造一个缺少必需字段的 `message_end` 事件，桌面端显示协议错误而不是空消息。

**测试。** 新增 `tests/docs-consistency.test.ts`，覆盖验收 1、2、4；lint 规则覆盖验收 6；`tests/` 中现有的协议测试补充事件校验用例（验收 7）；H1-3 拆分前后，`npm run test:features` 与 `npm run test:features-ui` 全部通过。

**注意。** 截至排查时，本地分支 `codex/slim-update-flow` 有未提交的修改，已经删除了 H1-7 中的 `source`、`filter`、`disabled`、`action`、`fetchReleaseNotes`、`prepareForQuit` 和 `installOnQuit`。该分支基于 v0.14.46，落后 `main` 24 个提交，合并时 `main.ts` 会有冲突。H1-7 应在该分支合并后，再确认剩余项。

## Claude 界面风格（待实现）

### UI9 Claude 风格：浅色 / 深色

在 UI8 的风格机制上新增第三套界面风格，参照 Claude 桌面版，分浅色和深色。和 UI8 不同，Anthropic 官方公开了一套完整的宿主令牌：MCP Apps 设计规范的“Style variables”一节，列出了背景、文字、边框、状态色、圆角和阴影在浅色、深色下的取值。本节的颜色优先采用这套官方值。官方没有覆盖的部分（侧栏、悬停、选中、品牌色用法）参考社区取色，“依据”列逐项注明。核对日期 2026-10-29，来源：claude.com/docs/connectors/building/mcp-apps/design-guidelines（Style variables）、同站 transparent-theming 页、Ynd-i/swan PR #20（深色取色）、dcelasun/claude-desktop-bin `themes/README.md`（`window-shared.css` 中的 `#faf9f5`）。

**背景与问题。**

1. **风格枚举有 7 处写死 `'codex'`。** 位置：`shared/window-theme.ts:14,33`；`src/components/SettingsModal.tsx:393,410,421,423`；`electron/main.ts:1188` 的错误文案“请选择 Pi 经典或 Codex 界面风格。”。照这个写法加第三种风格，每处都要再加一个分支。`styleTheme` 的语义其实是“该风格是否只支持浅/深/跟随系统”，应改为按风格查表。
2. **Claude 的强调色有两种用途。** Claude 用珊瑚色（`#d97757`）作为品牌色，用蓝色（官方 `color-text-info` `#3266AD`）表示链接和信息。UI8 拆出的 `--primary` / `--accent` 正好能分别承载这两种颜色，不需要新增语义令牌。
3. **官方值有 3 处对比度不足。** 浅色次要文字 `#73726C` 在选中行（`#e8e6dc`）上只有 3.86:1；深色次要文字 `#9C9A92` 在强调底色上只有 4.03:1；白字放在品牌珊瑚色 `#d97757` 上只有 3.12:1。三处都低于本项目 4.5:1 的要求（UI6 验收 7），需要调整。
4. **Claude 的回复正文用衬线字体。** 用户消息用无衬线字体，助手回复用衬线字体，这是 Claude 最容易辨认的特征之一。官方字体 Anthropic Sans / Serif 不能随应用分发，需要使用系统衬线字体回退。中文没有通用的系统衬线字体，回复正文的中文部分仍然使用无衬线字体。

**目标。** 设置中可以选择 Claude 风格，提供浅色、深色、跟随系统三种模式，标题栏和原生窗口背景一并切换。经典和 Codex 风格的观感不变。功能、DOM 结构、可访问名称和快捷键均不变。

**不做。**

- Claude 桌面版的高对比度模式、自定义强调色和字体选择。
- 照搬 Claude 的布局和信息架构。侧栏结构、检查器、标题栏、模型与审批菜单的位置不变，只改视觉。
- 使用 Anthropic 或 Claude 的标志、Anthropic Sans / Serif 字体文件或其他品牌资产；不从 `assets.claude.ai` 加载字体。“π”品牌标保留，只换底色。
- Claude 风格下的护眼米黄、豆沙绿、深蓝背景。
- 启动首帧问题，同 UI8 的“不做”。

**交互。**

- 设置 → 外观与编辑器 → 界面风格：`Pi 经典` / `Codex` / `Claude`。
- 选 `Claude` 后，主题选项只显示 `浅色`、`深色`、`跟随系统`（不改名，Claude 自己的叫法就是 Light / Dark）。从背景主题切换过来时的就近规则与 UI8 相同。
- 在 Codex 和 Claude 之间切换时，保留当前的浅色/深色/跟随系统。
- 预览、取消还原、保存、重启保持均沿用 UI8 机制。

**技术方案。**

- **风格表代替字面量**
  - `shared/window-theme.ts`：`UI_STYLES` 改为 `['classic', 'codex', 'claude']`。新增 `STYLE_META: Record<UiStyle, { label: string; basicThemesOnly: boolean; themeLabels?: Partial<Record<Theme, string>> }>`：经典为 `{ label: 'Pi 经典', basicThemesOnly: false }`，Codex 为 `{ label: 'Codex', basicThemesOnly: true, themeLabels: { light: '白天', dark: '夜晚' } }`，Claude 为 `{ label: 'Claude', basicThemesOnly: true }`。
  - `styleTheme` 改为按 `STYLE_META[style].basicThemesOnly` 判断。`windowTheme` 的色板改为 `stylePalettes: Partial<Record<UiStyle, { light; dark }>>` 查表，Claude 浅色为 `{ background: '#faf9f5', color: '#f5f4ed', symbolColor: '#141413' }`，深色为 `{ background: '#262624', color: '#1f1e1d', symbolColor: '#faf9f5' }`。
  - `SettingsModal.tsx` 的风格按钮文案、主题过滤和主题标签都从 `STYLE_META` 读取，不再出现风格字面量。
  - `electron/main.ts:1188` 的错误文案改为由 `STYLE_META` 生成：“请选择 Pi 经典、Codex 或 Claude 界面风格。”
  - `store-state.ts`、`saveSettings` 的校验已经按 `UI_STYLES` 枚举，不需要改动；新增值的就近修正由 `styleTheme` 统一处理。
- **Claude 样式**：新建 `src/styles/claude.css`，在 `src/styles.css` 中排在 `codex.css` 之后。令牌与组件覆盖的写法同 UI8：`:root[data-style='claude'][data-theme='light'|'dark']`，跟随系统写在 `@media (prefers-color-scheme: dark)` 中。不修改任何 TSX 结构。
- **衬线字体**：新增 `--font-reply` 令牌。经典和 Codex 不定义，使用回退值 `inherit`；Claude 定义为 `ui-serif, Georgia, 'Times New Roman', 'PingFang SC', 'Microsoft YaHei', serif`，只作用于助手消息的 `.message-content`。代码、表格数字、工具卡片、思考过程仍使用界面字体或等宽字体。

**Claude 令牌。** 下表所有文字色在 `--bg`、`--surface`、`--rail`、`--hover`、`--selected`、`--bubble`、`--code`、`--accent-soft` 上的对比度均不低于 4.5:1（括号内为最低值）。“官方”指 MCP Apps Style variables。

| 令牌 | 用途 | 浅色 | 深色 | 依据 |
| --- | --- | --- | --- | --- |
| `--bg` | 对话区画布 | `#faf9f5` | `#262624` | 官方 background-tertiary / secondary |
| `--surface` | 输入框、卡片、菜单 | `#ffffff` | `#30302e` | 官方 background-primary |
| `--rail` | 侧栏、标题栏 | `#f5f4ed` | `#1f1e1d` | 浅色为官方 background-secondary；深色比画布暗一级，参照 swan 取色（侧栏比对话区暗） |
| `--hover` | 悬停 | `#f0eee6` | `#353532` | 介于 rail 与 selected 之间 |
| `--selected` | 选中行 | `#e8e6dc` | `#3a3936` | 浅色接近官方 border `#DEDCD1` 的浅色混合 |
| `--bubble` | 用户消息气泡 | `#f0eee6` | `#141413` | 深色为官方 background-tertiary，气泡比画布暗 |
| `--code` | 代码块 | `#f5f4ed` | `#1f1e1d` | 同 rail |
| `--line` / `--line-strong` | 细线 | `#e4e3df` / `#cecdca` | `#383835` / `#4b4a47` | 官方 border `#1F1E1D` / `#DEDCD1` 按 10% / 20% 混合到画布上的不透明值 |
| `--ink` | 正文 | `#141413`（14.73） | `#faf9f5`（10.77） | 官方 text-primary |
| `--muted` | 次要文字 | `#66655f`（4.67） | `#a6a49b`（4.54） | 由官方 text-tertiary `#73726C` / `#9C9A92` 调整，见背景第 3 条 |
| `--accent` | 链接、焦点、选中强调 | `#3266ad`（4.61） | `#80aadd`（4.71） | 官方 text-info |
| `--accent-soft` | 强调底色 | `#e6eaee` | `#343b42` | 强调色按 10% / 16% 混合到画布 |
| `--on-accent` | 强调色上的文字 | `#ffffff`（5.77） | `#141413`（7.65） | |
| `--primary` / `--on-primary` | 发送、主要按钮、品牌标 | `#b95737` / `#ffffff`（4.69） | `#d97757` / `#141413`（5.90） | 深色为社区通用的 Claude 珊瑚色；浅色在同色相上加深，因为白字放在 `#d97757` 上只有 3.12 |
| `--success` | 新增、完成、已连接 | `#265b19`（6.47） | `#7ab948`（4.79） | 官方 text-success |
| `--red` | 错误、删除 | `#a73d39`（4.98） | `#ee8884`（4.59） | 浅色为官方 border-danger（官方 text-danger `#7F2C28` 与正文过近）；深色为官方 text-danger |
| `--warning` | 警告文字 | `#5a4815`（7.07） | `#d1a041`（4.76） | 官方 text-warning |
| `--signal` / `--signal-soft` | 运行中 | 同经典浅色 | 同经典深色 | |
| `--shadow-soft` | 页内表面 | `0 1px 2px #0000000d` | `none` | 官方 shadow-hairline；深色靠表面明度区分 |
| `--shadow` | 浮层、菜单、对话框 | `0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a` | `0 10px 30px #00000066, 0 1px 3px #00000040` | 浅色为官方 shadow-lg；深色同 Codex |
| `--radius-panel` | 面板 | `12px` | `12px` | 官方 border-radius-xl |
| `--radius-control` | 按钮、输入 | `8px` | `8px` | 官方 border-radius-md |
| `--content-width` | 阅读列 | `768px` | `768px` | 同 Codex |
| 语法色 | 代码块 | 经典浅色值，数字改为 `#9a5a22`（4.93），注释改为 `#5e5d57`（5.99） | Codex 夜晚值，函数改为 `#7ab4f9`（7.71），注释改为 `#9c9a92`（5.91） | 在 `--code` 上测算；注释改为暖灰，与画布色调一致 |
| ANSI 色 | 终端输出 | 同经典浅色 | 同经典深色 | |

字体：界面字体同 Codex（系统界面字体优先，保留中文回退）；回复正文使用 `--font-reply`；等宽字体同 Codex。

**组件覆盖（仅 Claude）。**

- **会话行**：选中时用 `--selected` 底色、`--ink` 文字，去掉左侧色条，与 Codex 相同。
- **输入框**：圆角 20px，`--surface` 底，`--line` 边框。浅色保留 `--shadow-soft`，因为 Claude 浅色下的输入框是浮在暖色画布上的白色卡片。聚焦时边框变为 `--line-strong`，没有强调色光晕。运行中的琥珀色边框保留，`:focus-visible` 轮廓用 `--accent`。
- **发送按钮**：`--primary` 填充，圆角 8px（Claude 为圆角方形，不是圆形）。禁用态沿用现有透明度。
- **用户消息**：`--bubble` 底，圆角 12px，`width: fit-content; max-width: min(80%, 620px); margin-left: auto`，标题行右对齐。溢出要求同 UI8 验收 7。
- **助手消息**：隐藏 `.avatar`；名字只做视觉隐藏，写法与 Codex 相同。`.message.assistant .message-content` 使用 `--font-reply`，字号 `calc(15px * var(--font-scale))`，行高 1.7。`.message.assistant .message-content` 内的 `code`、`pre`、`table`、`.code-block`、`.thinking` 恢复界面字体或等宽字体。
- **代码块**：圆角 12px。
- **遮罩**：`.modal-backdrop` 浅色为 `#1f1e1d40`，深色为 `#00000066`。
- **品牌标**：`--primary` 底，`--on-primary` 字，“π”不变。
- 其余组件（Goal 状态卡、审批卡、检查器、差异视图、侧边对话、模型选择器、命令面板）只随令牌变化，按截图清单检查后再做局部覆盖。

**实现顺序。** 先完成“风格表代替字面量”的重构，并单独提交：只有经典和 Codex 两种风格，所有现有测试必须通过，`tests/fixtures/classic-style.json` 不变。之后再加入 Claude。

**实现注意。** 以下来自对 UI8 实现（`a5b666a`）的核对，规格正文没有展开，但容易出错：

1. **`--primary` 不能当文字色检查。** `scripts/test-codex-style-ui.mjs:88` 把 `primary` 作为前景色，在全部 8 种背景上断言 ≥ 4.5:1。Codex 的墨色主色可以通过，Claude 的珊瑚色不能：浅色 `#b95737` 最低 3.75:1（`--selected`），深色 `#d97757` 最低 3.64:1（`--accent-soft`）。现有样式只把 `--primary` 用作填充色（`.primary`、`.send-button`、`.brand-mark` 的背景，`workbench.css:27` 的悬停边框），不用作文字色，所以应把 `primary` 从文字色循环中移除，只保留 `on-primary`/`primary` 这一对，再加一条非文字对比度断言：`--primary` 与 `--bg`、`--surface` ≥ 3:1。实现时不得把 `--primary` 用作文字色。
2. **经典基线不需要重新录制。** `test-codex-style-ui.mjs` 的 `--record-classic` 只应在“未修改的渲染器”上运行。重构和加入 Claude 后，都只做比对，不要重录 `tests/fixtures/classic-style.json`。
3. **Codex 没有计算样式基线。** 验收 5 对 Codex 的要求，做法是在重构开始前用当前代码录一份 `tests/fixtures/codex-style.json`（选择器与经典基线相同，`theme` 取 `light`、`dark`，`uiStyle: 'codex'`），之后只做比对。不要用截图像素差，截图受字体渲染影响，跨平台不稳定。
4. **需要同步修改的硬编码位置**（除背景第 1 条外）：`scripts/test-theme-ui.mjs:43-44,218,246,276,281-282,489-517,838-845` 的 Codex 色板、强调色、按钮名和主题标签；`scripts/readme-screenshots.mjs:20-21,46` 与 `tests/readme-mock-state.test.mjs:32-33` 的截图清单；`tests/store.test.ts:84-87` 的修正用例；`tests/app-dialogs.test.ts:124-142`；`tests/desktop-chrome.test.ts:265-267`；`src/main.tsx:9` 的首帧 `data-style` 保持 `classic`。
5. **测试脚本中的强调色断言**（`test-theme-ui.mjs:246`）应从 CSS 令牌或一张共享色板读取，不要再加一层三元表达式。
6. **字号比例。** 助手正文的 15px 必须写成 `calc(15px * var(--font-scale))`，`test-theme-ui.mjs` 中已有的字号比例检查要覆盖 Claude。
7. **发版材料。** 按 UI8 的惯例：新增 `docs/releases/v<版本>.md`（中英双语）、`docs/assets/README.md` 截图表补两行、双语 README 外观小节补两张截图；`package.json` 与 `package-lock.json` 同步版本号。

**验收标准。**

1. 外观设置中可以选择 `Pi 经典` / `Codex` / `Claude`。选 Claude 后主题只显示浅色、深色、跟随系统；米黄、豆沙绿切到浅色，深蓝切到深色；在 Codex 与 Claude 之间切换时保留当前主题。预览即时生效，取消还原，保存后重启仍保持。
2. Claude 浅色/深色下，`--bg`、`--rail`、`--ink` 与 `windowTheme` 返回的原生背景色及 Windows/Linux 标题栏覆盖色相同；“跟随系统”跟随原生外观。
3. 在 Electron 中实测：上表所有文字色在列出的各背景上 ≥ 4.5:1；`--on-accent` 与 `--accent`、`--on-primary` 与 `--primary` 之间 ≥ 4.5:1；`--primary` 作为填充色与 `--bg`、`--surface` 之间 ≥ 3:1；语法色在 `--code` 上 ≥ 4.5:1；焦点轮廓与 `--bg` 之间 ≥ 3:1。
4. Claude 下：发送按钮和品牌标为珊瑚色，链接为蓝色；选中会话没有彩色竖条；差异新增、完成状态为绿色；用户消息右对齐；助手回复正文的计算字体以衬线字体开头，回复内的代码块和行内代码为等宽字体；读屏仍能读到“你”/“Pi”。
5. 经典和 Codex 风格不变：`tests/fixtures/classic-style.json` 与新录的 `tests/fixtures/codex-style.json`（见“实现注意”第 3 条）在本节前后完全一致。
6. 源码中除 `shared/window-theme.ts` 的 `UI_STYLES`、`STYLE_META` 和 CSS 选择器外，不再出现 `'codex'`、`'claude'` 字面量的分支判断。
7. 溢出要求同 UI8 验收 7。

**测试。**

- `tests/app-dialogs.test.ts`：把 Codex 色板一致性测试改为遍历 `stylePalettes`，自动覆盖 Claude；跟随系统令牌重复检查的文件列表加入 `claude`。
- `tests/desktop-chrome.test.ts`、`tests/store.test.ts`：风格用例改为遍历 `UI_STYLES`，覆盖 Claude 搭配背景主题的就近修正。
- 新增 `STYLE_META` 单元测试：每种风格都有标签，`basicThemesOnly` 与 `stylePalettes` 一致（只支持基础主题的风格必须有专属色板）。
- `scripts/test-theme-ui.mjs`、`scripts/test-review-ui.mjs`、`tests/support/turn-outline-ui.mjs` 的风格循环加入 Claude。
- `scripts/test-codex-style-ui.mjs` 改名为 `scripts/test-style-ui.mjs`，按风格参数化（`--style codex|claude`）；`package.json` 的 `test:codex-style-ui` 改为 `test:style-ui` 并同时运行两种风格，CI 同步。截图存放在 `test-results/{codex,claude}-{light,dark}-*.png`，截图清单同 UI8。
- 同步双语 README 的外观说明，新增 `docs/assets/screenshots/workspace-claude-{light,dark}.png`。

## v0.14.56：Codex 界面风格（已实现）

### UI8 Codex 风格：白天 / 夜晚

新增一套参照 OpenAI Codex 桌面版的界面风格，分白天和夜晚两种。Codex 官方只公开了默认的背景、前景和强调色，其余数值来自社区对安装包的提取和对窗口的取色，下文“依据”列逐项注明。核对日期 2026-10-29，来源：Codex 设置文档（learn.chatgpt.com/docs/reference/settings）、Suk1u/codex-clone 的 `app/css/tokens.css`、openchamber PR #4670、Hermes `codex-theme` 插件。

**背景与问题。**

1. **主题只能换颜色。** `src/styles/themes.css:1` 写明背景主题“只改表面和文字”。圆角、阴影、消息排版都写死在各组件的 CSS 里，再加一个色板也做不出 Codex 的样子。Codex 的特征在形态上：表面扁平无阴影，用细线分隔；蓝色只用于交互；用户消息是右对齐的灰色气泡，助手回复直接排在画布上；输入框是大圆角。
2. **`--accent` 同时表示“交互”和“成功/新增”。** 差异新增行、已完成状态、工具完成、Goal 完成、已连接、轮次新增行数都直接用 `--accent`。位置：`base.css:508-510`、`conversation-v014.css:483`、`diff-view.css:2,23-24`、`goal.css:30-31,127`、`inspector.css:265-267`、`models.css:365-368`、`workbench.css:350-352`。强调色一旦换成蓝色，新增行也会变蓝。
3. **主要操作都用强调色填充。** 涉及主要按钮 `.primary`（`base.css:457-465`）、发送按钮（`conversation.css:489-502`）、品牌标（`shell.css:25-29`）和会话选中态（`shell.css:127-129`，以及 `workbench.css:100-109` 的左侧色条）。Codex 的这些位置都是中性色：发送按钮用墨色填充，选中行用灰底。
4. **现有缺陷：跟随系统时深色语法色不生效。** `conversation-v014.css:14` 的深色语法色和 ANSI 色只匹配 `dark` 与 `navy`，没有 `prefers-color-scheme: dark` 下的 `system`（`--warning` 在 `themes.css` 中有这一分支）。所以“跟随系统”遇到系统深色时，代码块仍用浅色语法色，关键字对比度仅 2.70:1。Codex 的“跟随系统”沿用同一机制，必须一并修复。
5. **官方浅色强调色对比度不足。** `#0285FF` 作为文字放在白底上只有 3.62:1，低于本项目 4.5:1 的要求（UI6 验收 7）。

**目标。** 设置中可以选择 Codex 风格，提供白天、夜晚、跟随系统三种模式，标题栏和原生窗口背景一并切换。经典风格的观感不变。功能、DOM 结构、可访问名称和快捷键均不变。

**不做。**

- Codex 设置里的自定义强调色/背景/前景、对比度滑块、半透明侧栏、主题导入导出和字体选择。
- 照搬 Codex 的布局和信息架构。侧栏结构、检查器、标题栏、模型与审批菜单的位置都不变，只改视觉。
- Codex 风格下的护眼米黄、豆沙绿、深蓝背景。
- 使用 OpenAI 的标志或其他品牌资产，“π”品牌标保留。
- 启动首帧（加载页）先按“跟随系统”绘制再切换。现有背景主题也有这个问题，本节不处理。
- 经典浅色代码注释色 `#7c848b` 对比度偏低（约 3.5:1）。这是经典风格的已有问题，另行处理。
- 资源页里的 Pi 主题（`ResourcesTab` 的 `themes`）。它是 Pi 终端主题，与本节无关。

**交互。**

- 设置 → 外观与编辑器，在“主题”之前新增“界面风格”：`Pi 经典` / `Codex`。
- 选 `Codex` 后，主题选项只显示 `白天`、`夜晚`、`跟随系统`。从米黄或豆沙绿切换过来时选中白天，从深蓝切换过来时选中夜晚。切回经典时保留当前的浅色/深色/跟随系统，不恢复之前的背景主题。
- 预览沿用现有机制，设置窗口打开期间即时生效（`useWorkbench.ts:242`），取消后还原，保存后持久化，重启后保持。

**技术方案。**

- **设置与原生窗口**
  - `shared/window-theme.ts`：新增 `UI_STYLES = ['classic', 'codex']` 和 Codex 白天/夜晚色板，`windowTheme(dark, theme, style)` 按风格返回色板。Codex 白天为 `{ background: '#ffffff', color: '#f9f9f9', symbolColor: '#0d0d0d' }`，夜晚为 `{ background: '#181818', color: '#131313', symbolColor: '#dddddd' }`。`nativeThemeSource` 不变，因为 Codex 只用 light、dark、system 三种取值。
  - `shared/types.ts:74`：`Settings` 增加 `uiStyle: UiStyle`；`electron/store-state.ts` 的默认值为 `'classic'`。旧状态文件没有这个字段时取默认值。
  - `electron/store-state.ts:170` 按枚举校验 `uiStyle`。如果读到 `codex` 搭配背景主题（例如手改了文件），就近改为 light 或 dark，并计入 `repairedSettings`。
  - `electron/main.ts:1181`（`saveSettings`）校验 `uiStyle`，并对 Codex 搭配背景主题做同样的就近修正。`main.ts:212` 和 `main.ts:1663` 两处 `windowTheme` 调用传入风格。
  - `src/hooks/useWorkbench.ts:244` 设置 `document.documentElement.dataset.style`；`src/main.tsx:8` 先设为 `classic`。
  - `src/components/SettingsModal.tsx:375` 的外观页增加风格选择，主题选项按风格过滤，Codex 下的标签为白天/夜晚/跟随系统。
- **语义令牌（经典风格的取值不变）**
  - `base.css` 的 `:root` 新增 `--success: var(--accent)`、`--primary: var(--accent)`、`--on-primary: var(--on-accent)`。经典风格解析后的颜色与现在相同。
  - 背景第 2 条列出的“成功/新增”位置改用 `--success`；`.primary`、`.send-button`、`.brand-mark` 改用 `--primary` / `--on-primary`。轮次目录“含修改”的刻度（`conversation-v014.css:506`）和未读点（`shell.css:159`）表示提示信息，继续用 `--accent`。
- **修复跟随系统时的深色语法色**：在 `conversation-v014.css:14` 后增加 `@media (prefers-color-scheme: dark) { :root[data-theme='system'] { … } }`，取值与 `dark` 相同。
- **Codex 样式**：新建 `src/styles/codex.css`，在 `src/styles.css` 中最后引入。令牌写在 `:root[data-style='codex'][data-theme='light'|'dark']` 下，跟随系统写在 `@media (prefers-color-scheme: dark)` 里的 `:root[data-style='codex'][data-theme='system']` 下，做法与 `base.css:312` 相同。组件覆盖统一以 `[data-style='codex']` 为前缀，选择器权重高于原规则，不依赖引入顺序。不修改任何 TSX 结构。

**Codex 令牌。** 下表所有文字色在 `--bg`、`--surface`、`--rail`、`--hover`、`--selected`、`--bubble`、`--code`、`--accent-soft` 上的对比度均不低于 4.5:1（括号内为最低值）。

| 令牌 | 用途 | 白天 | 夜晚 | 依据 |
| --- | --- | --- | --- | --- |
| `--bg` | 对话区画布 | `#ffffff` | `#181818` | 官方默认背景 |
| `--surface` | 输入框、卡片、菜单 | `#ffffff` | `#212121` | Hermes card |
| `--rail` | 侧栏、标题栏 | `#f9f9f9` | `#131313` | Hermes / codex-clone sidebar |
| `--hover` | 悬停 | `#f0f0f0` | `#262626` | |
| `--selected`（仅 Codex） | 选中行 | `#e8e8e8` | `#2d2d2d` | 接近 OpenChamber 取色 `#303133` |
| `--bubble`（仅 Codex） | 用户消息气泡 | `#f3f3f3` | `#2a2a2a` | Hermes；夜晚略提亮以与画布区分 |
| `--code` | 代码块 | `#f6f6f6` | `#1f1f1f` | codex-clone code-bg |
| `--line` / `--line-strong` | 细线 | `#e7e7e7` / `#d4d4d4` | `#2a2a2a` / `#3a3a3a` | Hermes border |
| `--ink` | 正文 | `#0d0d0d`（15.86） | `#dddddd`（10.14） | 白天为官方前景；夜晚为 OpenChamber 取色，官方 `#FFFFFF` 太刺眼 |
| `--muted` | 次要文字 | `#5d5d5d`（5.37） | `#9a9a9a`（4.89） | 夜晚取色 `#8f8f8f` 在选中行上只有 4.26，已提亮 |
| `--accent` | 链接、焦点、选中强调 | `#005fcc`（4.88） | `#339cff`（4.81） | 夜晚为官方值；白天由官方 `#0285FF` 加深 |
| `--accent-soft` | 强调底色 | `#e6effa` | `#1c2d3d` | 强调色按 10% / 16% 混合 |
| `--on-accent` | 强调色上的文字 | `#ffffff`（5.98） | `#0d0d0d`（6.79） | 白字在 `#339cff` 上只有 2.86 |
| `--primary` / `--on-primary` | 发送、主要按钮、品牌标 | `#0d0d0d` / `#ffffff` | `#f2f2f2` / `#0d0d0d` | codex-clone send-bg |
| `--success` | 新增、完成、已连接 | `#16702f`（5.05） | `#57ab5a`（4.84） | 白天由 codex-clone `#1a7f37` 加深 |
| `--red` | 错误、删除 | `#b42318`（5.37） | `#f2777a`（5.05） | 夜晚为 codex-clone |
| `--signal` / `--signal-soft` / `--warning` | 运行中、警告 | 同经典浅色 | 同经典深色 | |
| `--shadow-soft` | 页内表面 | `none` | `none` | 扁平无阴影 |
| `--shadow` | 浮层、菜单、对话框 | `0 10px 30px #00000014, 0 1px 3px #0000000f` | `0 10px 30px #00000066, 0 1px 3px #00000040` | 浮层与画布同色，需要阴影区分 |
| `--radius-panel` | 面板 | `12px` | `12px` | Hermes |
| `--content-width` | 阅读列 | `768px` | `768px` | codex-clone |
| 语法色 | 代码块 | 经典浅色值，注释改为 `#5f6872`（5.24），数字改为 `#a26228`（4.50） | 关键字 `#f8a6c8`、字符串 `#83d197`、数字 `#f1a275`、函数 `#63a8f8`、注释 `#a0a0a0` | OpenChamber 取色（注释压暗）；2026-10-29 确认仅加深 Codex 白天数字色，原值 `#a36228` 实测为 4.48 |
| ANSI 色 | 终端输出 | 同经典浅色 | 同经典深色 | |

字体：界面用 `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`，等宽字体用 `ui-monospace, 'SFMono-Regular', 'Cascadia Mono', Menlo, Consolas, 'Microsoft YaHei', monospace`。拉丁字符优先使用系统界面字体，与 Codex 一致；保留中文回退字体。

**组件覆盖（仅 Codex）。**

- **会话行**：选中时用 `--selected` 底色、`--ink` 文字，去掉左侧色条（`workbench.css:100`），保留现有的 500 字重。
- **输入框**：圆角 20px，`--surface` 底，`--line` 边框，无阴影。聚焦时边框变为 `--line-strong`，不显示强调色光晕（覆盖 `models.css:6-11`）。运行中的琥珀色边框（`models.css:12-19`）保留。键盘焦点的 `:focus-visible` 轮廓仍用 `--accent`。
- **用户消息**：`.message.user .message-content` 用 `--bubble` 底，圆角 12px，`width: fit-content; max-width: min(80%, 620px); margin-left: auto`。标题行右对齐。长提问折叠、附件、技能块、引用和图片都在气泡内显示，不得横向溢出。
- **助手消息**：隐藏 `.avatar`。“你”/“Pi”的名字只做视觉隐藏（裁剪方式，不用 `display: none`），读屏仍能区分角色。时间、回复统计和操作按钮保持现状。G3 的 `◎ Goal` 标记仍在用户消息上方显示。
- **正文**：`.message-content` 行高 1.7。Codex 原值 22/14≈1.57，中文需要更大的行距。
- **代码块**：圆角 12px（`conversation.css:202`）。
- **遮罩**：`.modal-backdrop`（`dialogs.css:9`、`models.css:377`）改为中性的 `#00000040`，去掉偏绿的色调。
- 其余组件（Goal 状态卡、审批卡、检查器、差异视图、侧边对话、模型选择器、命令面板）只随令牌变化，不单独改样式。实现时按下文“截图清单”逐一检查，出现问题再做局部覆盖。

**验收标准。**

1. 外观设置中可以选 `Pi 经典` / `Codex`。选 Codex 后主题只显示白天、夜晚、跟随系统。米黄、豆沙绿会切到白天，深蓝会切到夜晚。预览即时生效，取消还原，保存后重启仍保持。
2. Codex 白天/夜晚下，`--bg`、`--rail`、`--ink` 与 `windowTheme` 返回的原生背景色及 Windows/Linux 标题栏覆盖色相同。“跟随系统”跟随原生外观。
3. 在 Electron 中实测：上表所有文字色在列出的各背景上 ≥ 4.5:1；`--on-accent` 与 `--accent`、`--on-primary` 与 `--primary` 之间 ≥ 4.5:1；语法色在 `--code` 上 ≥ 4.5:1；焦点轮廓与 `--bg` 之间 ≥ 3:1。
4. Codex 下：选中会话没有彩色竖条，底色为中性灰；发送按钮和主要按钮为墨色填充；差异新增、完成状态、工具完成显示为绿色，不是蓝色；输入框圆角 20px、无阴影，聚焦时没有蓝色光晕；用户消息右对齐，宽度随内容、不超过 80%；助手消息没有头像；读屏仍能读到“你”/“Pi”。
5. 经典风格不变。实现前后各采集一次浅色、深色下关键元素的计算样式（`color`、`background-color`、`border-color`、`box-shadow`、`border-radius`），覆盖会话行、发送按钮、主要按钮、差异行、状态点、工具卡、Goal 卡和用户消息，两次结果完全一致。
6. 系统为深色、主题为“跟随系统”时，经典和 Codex 的代码块都使用深色语法色，关键字在 `--code` 上 ≥ 4.5:1。
7. Codex 白天/夜晚下：长提问折叠与展开、带附件和引用的提问、超宽代码块、轮次目录、Goal 状态卡、审批卡、差异视图都不会让 `.message-list` 出现横向滚动，用户气泡的 `scrollWidth` 不超过 `clientWidth`。

**测试。**

- `tests/app-dialogs.test.ts:84`：色板与 CSS 令牌一致性检查加入 Codex 白天/夜晚两个段落。
- `tests/desktop-chrome.test.ts:229`：`updateWindowTheme` 覆盖 Codex 风格。
- store 状态测试覆盖：缺少 `uiStyle` 时取默认值；无效值被修复；Codex 搭配背景主题时就近修正并计入修复数。`saveSettings` 同样覆盖这三种情况。
- CSS 结构单元测试：`[data-theme='dark']` 下定义的每个令牌，在 `prefers-color-scheme: dark` 的 `system` 分支中都有同名定义，经典和 Codex 都要检查，防止背景第 4 条再次出现。
- `scripts/test-theme-ui.mjs`：通过设置界面切换 Codex 白天/夜晚/跟随系统，断言 `data-style`、令牌、标题栏颜色、取消还原和重启保持。
- `scripts/test-review-ui.mjs:58` 和 `tests/support/turn-outline-ui.mjs:270` 的主题循环加入 Codex 白天/夜晚。
- 新增 `scripts/test-codex-style-ui.mjs`：完成验收 3、4、5、7 的实测，并截图。截图清单为工作区、设置、命令面板、审批卡、Goal 状态卡、差异视图、侧边对话、模型选择器，白天和夜晚各一张，存放在 `test-results/codex-{day,night}-*.png`。
- 同步双语 README 的外观说明，新增 `docs/assets/screenshots/workspace-codex-{light,dark}.png`。

**实现与验收（2026-10-29）。**

- 已实现风格选择、主题转换、预览与放弃修改、保存及重启保持，以及原生窗口色板。经典与 Codex 的“跟随系统”都补齐了深色语法色和 ANSI 色。工具卡的新增行数也使用 `--success`。
- Windows Electron 已通过原生主题测试和 `npm run test:codex-style-ui`；16 张截图在 `test-results/codex-{day,night}-*.png`，对比度与宽度记录在 `test-results/codex-style-ui.json`。白天、夜晚各测 63 组对比度，最低分别为 4.50:1、4.81:1。
- 经典浅色、深色的九组计算样式与实现前的 `ff15ae8` 构建完全一致，记录保存在 `tests/fixtures/classic-style.json`。对话引用、侧边对话、轮次目录、长提问、附件、图片、技能和代码块的回归已通过。
- 全量测试 740 项通过、8 项按当前平台跳过；构建、lint、格式检查通过。新增的 Codex 界面验收已加入 Linux CI；本机未执行 Linux/macOS 界面测试。

## v0.14.55：Goal 输入框交互（已实现）

### G3 在输入框中新建与修改 Goal

实现与本地验证见 [G3 验证记录](testing/goal-composer.md)。

基线为已发布的 v0.14.54。G2 的续跑、审计、预算统计、状态和停止规则沿用；本节取代新建、编辑和调整上限的 Goal 专用弹窗。原需求新增在 G2 中的交互拆到本节，避免把已发布内容标为未实现。

**输入框与入口。**

- 没有 Goal 或上个 Goal 已完成时，点击 Goal 按钮进入 Goal 模式，再点一次退出。普通草稿正文、文件、粘贴片段、对话引用和图片保留。
- 未完成的 Goal：主按钮展开状态卡；详情提供“替换目标”进入 Goal 模式，发送时确认替换。已完成的 Goal：主按钮新建，另有“查看上个 Goal 结果”入口。完成后 8 秒收起的规则不变。
- 模式条为 `◎ Goal · 持续执行直到完成 · 上限：不限 ▾ · ×`，使用主题色；占位提示描述结果与验证方式；发送按钮为“开始 Goal”。只有目标正文计入 4000 字，文件内容、片段、引用和图片不计入。空目标或超长目标禁用开始，显示原因。
- 上限浮层提供不限、500k、2m、5m、自定义及按 G2 口径计算的请求数估算；同一组件用于“调整上限并继续”。上限只对本次创建生效，退出 Goal 模式恢复不限。
- 进入模式、选择上限、写草稿、切换会话与恢复草稿均为本地操作，不连接 Pi。发送时才执行普通消息的环境、信任、存储、连接、模型和图片能力检查。

**命令与键盘。**

- 裸 `/goal` 发送、命令选择器选中 `/goal`，与主按钮遵循同样的已有 Goal 状态规则。
- `/goal <目标>` 与 `/goal --tokens N <目标>` 显示创建预览；`status`、`pause`、`resume`、`clear`、`edit` 保持子命令语义。命令必须在展开粘贴片段与对话引用之前解析。
- 手写 `--tokens` 优先；通过芯片修改上限会同步重写命令参数，界面与实际发送使用同一上限。没有手写预算时使用本次模式预算。
- `Esc` 先关闭文件/命令建议和上限浮层，再退出 Goal 模式。退出创建预览会去掉 `/goal` 与前置 `--tokens N`，保留实际目标及全部附件，避免再次发送误建 Goal。普通运行中的停止快捷键仍遵循原有优先级。
- 控制子命令不能携带文件、图片、片段或引用；如有这些未发送材料则提示先保留/移除，草稿不清空，不把材料误当新目标。普通补充消息照常支持这些材料。

**单次发送与持久化。**

- 桌面端从原始正文提取 objective，从普通草稿构造首条消息。Goal 状态保存正文及独立的文件路径 `references`，不保存展开后的文件内容。续跑上下文同时包含原目标及路径；初始材料留在对话历史中。
- `send` 接受可选的 Goal 创建描述并复用普通发送的附件解析、大小限制、检查点和落盘屏障；验证成功后只调用一次原生 `goal_action start`，内部携带已校验的首条消息和图片，不再另发一次 prompt。
- 原生端确认替换、保存 Goal、发送一条用户原文；去掉“请完成 Goal：”前缀。隐藏的持久化开始标记用于在该用户消息上方显示 `◎ Goal`，不会改变复制的文字或注入模型上下文。重新读取历史仍有标记。
- 无效附件、图片能力不足、存储失败或取消确认时，保留原 Goal 和待发草稿，不开始新请求。并发修改草稿后，成功发送只消费与发送快照完全相同的正文、附件和模式，绝不清空较新的草稿。
- `Session.draftGoal` 保存创建模式及预算，或编辑模式的 `{ goalId, revision, objective, restore? }`；普通草稿字段始终保留原文和全部材料。会话切换和应用重启后恢复。损坏的模式数据不会导致普通草稿丢失。

**独立编辑缓冲区。**

- 状态卡“编辑目标”及 `/goal edit` 进入输入框内的编辑模式，发送按钮为“保存修改”。`/goal edit <新目标>` 仍支持直接修改。
- 编辑是文字操作：单独保存正在编辑的 objective，不覆盖 Session 的普通草稿正文、文件、图片、片段或引用。普通材料暂时隐藏；需要添加材料时先完成/取消编辑，再普通补充发送或替换 Goal。
- 保存/取消后恢复普通草稿及进入编辑前的创建模式和预算。编辑期间切换会话、刷新或重启同样保留两份草稿。
- 保存必须校验 session、goalId、revision；过期编辑显示错误并保留文字，不能覆盖已被修改或替换的 Goal。保存成功 revision 加一，用量用时保留、计划与无进展计数重置，更新提示保存在历史中，下一次模型请求投影最新目标与版本；记录提示本身不排队触发额外轮次，避免完成后残留编辑消息继续请求。
- 删除 Goal 专用模态框及按标题识别的 ExtensionPrompt 分支。普通权限审批、危险操作确认及替换未完成 Goal 的确认仍保留。

**验收。**

1. 无 Pi 连接也能进入创建/编辑模式与上限浮层；切换会话、重新加载后模式、预算及普通/编辑草稿正确恢复。
2. 带文件、长片段、引用、图片的目标只产生一次模型请求和一条用户消息；目标状态仅保存正文与引用路径；无固定前缀，历史重读后显示 Goal 标记。
3. 4000 字限制只作用于正文；空目标不启动，附带大段材料不误触目标长度限制。
4. 手写预算、芯片修改、Esc 退出、裸命令及控制子命令符合上述规则；浮层优先消费 Esc。
5. 编辑保存/取消均完整恢复普通草稿；并发修改、过期 revision、会话切换和失败不丢失输入。
6. 完成主按钮新建，单独入口查看上一结果；未完成主按钮查看状态，替换可取消且保留旧 Goal。
7. 普通消息、Goal 控制命令、预算收尾、停止与恢复、旧状态读取保持 G2 行为。以纯函数、真实 Pi 模型桩和 Electron UI 测试验证；同步 Goal 文档、双语 README、截图和发布说明。

## v0.14.54：Goal 持续执行、完成审计与停止状态（已实现）

### G2 Goal 运行机制重做

实现与验收结果见 [Goal G2 验证记录](testing/goal-redesign.md)。本地在 macOS 使用模型桩验证，发布时另执行三平台 CI 与安装包校验。

G1 只改了 Goal 的显示方式，没有动续跑、判定和用量规则。本节参照 OpenAI Codex 的 `/goal`，调整这三项及其交互。依据是 Codex 官方文档和开源代码，核对日期为 2026-10-29，代码版本为 openai/codex `main` 22aec5f，主要文件为 `codex-rs/ext/goal/`。下文提到 Codex 时均以此为准。

**背景与问题。**

1. **硬上限 25 次续跑。** `electron/goal-state.ts:5` 规定续跑 25 次后暂停，长任务只能有人守着点“继续”。状态条最显眼的位置是“第 N / 25 次续跑”（`src/components/conversation/GoalCard.tsx:127`），可这个次数对用户没有意义。Codex 不设轮次和时间上限，靠完成审计、无进展检测和可选的 Token 预算来收住。
2. **续跑提示太弱。** `goalContext`（`electron/pi-goal.ts:40`）只说了“继续完成这个目标”。它没有要求以当前工作区为准核对、不能缩小目标范围，也没有要求完成前逐项审计。目标原文直接拼进指令，没有作为数据隔离。结果是模型容易敷衍交差，或者第一次失败就报阻碍。
3. **完成证据流于形式。** `evidence` 是必填项，但程序无法校验其真伪，`docs/goal.md` 也承认这一点。模型写一段套话就能完成 Goal。Codex 把核验放在续跑提示的完成审计里，证据就是对话中实际执行的工具调用。
4. **停止原因都叫“已暂停”。** 达到预算、服务商额度用尽、模型报错、连续不调用工具、续跑满 25 次，都记为 `paused`，区别只在原因文本。界面要比较数字才能推断出“已达到预算”（`GoalCard.tsx` 中的 `exhausted`）。
5. **达到预算立即中止。** `pi-goal.ts:199` 会调用 `ctx.abort()`，可能在编辑或命令执行中途打断，留下半成品，也没有收尾说明。
6. **用量数字虚高。** 当前累加的是 `usage.totalTokens`，Pi 中它等于 `input + output + cacheRead + cacheWrite`。长任务每次请求都会命中缓存、重读上下文，所以数字比实际新增用量大一个数量级（G1 截图中上下文 91k，Goal 已计 649k）。G1 只是把说明写得更长了。Codex 只统计 `input − cached_input + output`。
7. **用时不准。** 用时取 `updatedAt − createdAt`（`GoalCard.tsx:97`），把暂停、阻碍和关机的时间也算进去了。
8. **不能修改目标。** 想改目标只能清除后重建，已用量随之清零。已有未完成的 Goal 时新建会直接报错（`pi-goal.ts:334`），需要先手动清除。
9. **看不到进度。** 没有计划和步骤，用户只能翻对话流猜做到了哪一步。
10. **入口重复。** 不带参数的 `/goal` 和 Goal 按钮会弹出“查看 / 暂停 / 恢复 / 清除”选择菜单（`pi-goal.ts:387`），功能与状态条按钮重复。
11. **会话标题相同。** 从新会话开始 Goal 时，标题固定为“Goal”（`electron/agent.ts:1579`），侧栏里会出现多个同名会话。
12. **目标过长。** 目标上限 100000 字（`shared/goal.ts:38`），每次续跑都整段注入。

**与 Codex 对照。**

| 方面 | 现状（v0.14.53） | Codex | 本版 |
| --- | --- | --- | --- |
| 自动续跑上限 | 25 次后暂停 | 不设轮次和时间上限 | 取消上限 |
| 完成判定 | 两个专用工具，必须填写 `evidence` | 按续跑提示逐项完成审计，再调用 `update_goal(complete)` | 一个状态工具，审计写在续跑提示中 |
| 阻碍 | 模型认为无法继续即可报告 | 同一阻碍连续出现 3 个 Goal 轮次后才报告 | 同 Codex |
| 无进展 | 连续 3 次不调用工具时暂停 | 连续 3 次自动续跑无活动，或命令失败且没有成功的工具 → `blocked` | 同 Codex，显示“遇到阻碍” |
| 停止状态 | 统一 `paused`，用原因文本区分 | `paused`、`blocked`、`budget_limited`、`usage_limited`、`complete` | 同 Codex |
| 达到预算 | 立即中止当前运行 | 注入收尾提示，不再开始新工作 | 同 Codex |
| 用量口径 | `totalTokens`（含缓存命中） | `input − cached_input + output` | 不计缓存命中 |
| 用时 | 从创建到最后一次更新 | 累计执行时长 | 累计执行时长 |
| 修改目标 | 只能清除后重建 | `/goal edit`，保留用量 | 支持编辑，保留用量 |
| 进度显示 | 第 N / 25 次续跑 | `update_plan` 计划，加用时或预算 | 计划步骤，加用时或预算 |
| 不带参数的 `/goal` | 弹出选择菜单 | 显示摘要和可用命令 | 展开状态卡 |
| 目标长度 | 100000 字 | 4000 字 | 4000 字 |
| 重启后 | 原执行中的目标暂停，需点“继续” | 执行中的目标自动恢复续跑 | 保持现状（有意不同，见“不做”） |

**目标。** Goal 能够无人值守地持续执行，直到通过完成审计、确认受阻或达到用户设定的上限。每种停止原因都有独立状态和对应操作。用量与用时反映真实投入。用户可以随时修改目标，并通过计划步骤了解进度。

**不做。**

- **重启后自动续跑。** Codex 会恢复执行中的目标，桌面端仍要求点“继续”，避免崩溃或重启后在无人看管时产生费用。
- **模型自行创建 Goal。** Codex 提供 `create_goal`，桌面端只保留 Goal 按钮和 `/goal` 两个入口。
- **独立验收模型，或自动把需求转换为测试。**
- **时间上限。** Codex 统计用时但不限制用时，本版相同。
- **多个 Goal 并存、项目级 Goal。**
- **修改底部累计用量和 E3 费用统计的口径。**

**本节修改 G1 的约定。** G1 规定“不改变 Goal 的完成判定、自动续跑与审批规则”“不改用量统计口径”。本节修改前两项和 Goal 自身的用量口径；审批规则、`/goal` 现有语法、状态条单行布局、完成后 8 秒收起，均沿用 G1。

**交互与技术方案。**

- **状态模型**（`electron/goal-state.ts`、`shared/goal.ts`）
  - 状态升级为 `version: 2`：`{ id, revision, objective, status, tokenBudget?, tokensUsed, timeUsedMs, plan?, reason?, summary?, continuations, noProgressRuns, failedRuns, createdAt, updatedAt }`。
  - `status` 取值：`active`、`paused`、`blocked`、`budget_limited`、`usage_limited`、`completed`。只有 `active` 会自动续跑。
  - `revision` 在修改目标时加 1。模型工具必须同时提交 `goal_id` 和 `revision`，过期调用会被拒绝。
  - `GoalSnapshot` 去掉 `maxContinuations`，增加 `timeUsedMs`、`plan` 和 `revision`。
  - 读取 v1 状态时，`active` 按现有规则转为 `paused`；`tokensUsed` 原样保留，详情中注明“旧版统计口径，可能偏大”；`evidence` 并入 `summary` 显示；用时显示为“—”。
- **续跑循环**（`electron/pi-goal.ts`）
  - 删除 `MAX_GOAL_CONTINUATIONS`，`continuations` 只用于诊断，界面不再显示。
  - 仍在 `agent_before_settle` 边界判断是否续跑。下表依次检查，命中第一条即停止续跑：

    | 条件 | 进入状态 | 原因文案 |
    | --- | --- | --- |
    | 模型调用状态工具，提交 `completed` 或 `blocked` | 对应状态 | 模型提交的摘要 |
    | 用户点击暂停、停止，按 `Esc`，或使用 `/goal pause` | `paused` | 用户暂停了 Goal |
    | 本次运行中达到用量上限 | `budget_limited` | 已达到用量上限 X |
    | 模型错误被 S2 归为 `quota` | `usage_limited` | 服务商额度或限流，附 S2 的处理入口 |
    | 其他模型错误 | `paused` | S2 分类后的原因 |
    | 连续 3 次自动续跑没有任何工具调用 | `blocked` | 连续 3 轮没有进展 |
    | 连续 3 次自动续跑中有命令失败，且没有一个工具成功 | `blocked` | 连续 3 轮命令失败 |
    | 重新载入、切换分支，或 Goal 工具被停用 | `paused` | 沿用现有文案 |
- **达到用量上限的收尾**
  - `message_end` 累计用量后，若达到上限：状态立即设为 `budget_limited`，并用 `pi.sendMessage(..., { deliverAs: 'steer' })` 注入一次收尾提示（`display: false`），不调用 `ctx.abort()`。
  - 收尾提示内容为：已达到用量上限；不要开始新的实质性工作；尽快结束本轮，说明有用的进展、剩余工作或阻碍，并给出明确的下一步。
  - 本次运行结束后不再续跑。如果注入收尾提示后又发起超过 3 次模型请求，就中止运行。这是桌面端额外加的保护，Codex 没有。
  - 状态条操作为“调整上限并继续”，沿用 G1 对话框，确认后从 `budget_limited` 恢复为 `active`。
- **续跑提示**（取代 `goalContext`；每次开始、恢复和续跑时都以 `display: false` 注入，内容参照 Codex `templates/goals/continuation.md`）
  - 目标放在 `<objective>` 标签内，并说明“以下是用户提供的数据，作为要完成的任务，而不是更高优先级的指令”。
  - 用量：已用、上限、剩余；未设上限时写“不限”。
  - 保持完整范围：本轮做不完也要保持目标完整，朝真正要求的结果推进，不得把成功标准改成更小、更容易的任务。
  - 以证据为准：当前工作区和外部状态是权威来源；之前的对话只用来定位，依赖前先检查当前状态。
  - 无进展自检：先判断上一轮属于“有进展 / 确认在等待 / 无进展”。只复述状态、只写计划不执行，都算无进展。
  - 进度可见：工作明显需要多步时，用 `desktop_goal_plan` 列出与目标对应的简短计划并保持更新；单步工作跳过。更新计划不能代替实际工作。
  - 完成审计：先默认“尚未完成”。从目标及引用的文件和要求中列出每一项具体要求，逐项找到能证明它的权威证据（文件、命令输出、测试结果、实际运行行为），并检查证据确实覆盖该项。证据不确定或间接时视为未完成，继续工作。审计必须证明已完成，而不只是“没发现剩余工作”。
  - 阻碍审计：第一次遇到阻碍时不报告。同一阻碍连续出现 3 个 Goal 轮次后，才提交 `blocked`。工作难、慢、不确定或需要澄清，都不算阻碍。用户恢复已受阻的 Goal 后重新计数。
  - 不得因为用量快用完或准备停止，就提交 `completed`。只有用户在消息中明确要求时，才提交 `paused`，不得自行暂停。
- **模型工具**
  - 移除 `desktop_goal_complete` 和 `desktop_goal_blocked`，新增三个工具：
    - `desktop_goal_get()`：只读，返回目标、状态、用量、上限、剩余量和计划，供上下文压缩后核对。
    - `desktop_goal_update({ goal_id, revision, status, summary })`：`status` 只能是 `completed`、`blocked` 或 `paused`；`summary` 必填，不超过 2000 字，说明完成了什么或卡在哪里。不再有 `evidence` 字段。`completed` 和 `blocked` 沿用“必须是本次回复唯一的直接工具调用”的规则。
    - `desktop_goal_plan({ goal_id, revision, steps })`：`steps` 最多 12 项，格式为 `{ text, status: pending | in_progress | completed }`，同一时间最多一项 `in_progress`。计划随 Goal 状态保存在会话条目中，切换分支时随分支恢复。
  - 三个工具都只记录会话状态，在只读模式下同样可用。
  - 历史会话中的旧工具卡照常显示，“跳到结果”能同时定位新旧两种工具名。
- **用量与用时**
  - 每次请求计入 Goal 的用量为 `input + output + cacheWrite`，不计 `cacheRead`。在 Pi 的 OpenAI 兼容实现中，`input` 已扣除缓存读写，因此结果与 Codex 的 `input − cached_input + output` 一致。
  - 详情写作“Goal 用量 15k tokens（不含缓存命中）”。悬停显示按供应商计费口径的累计值（含缓存）和估算费用。底部累计和 E3 统计保持不变。
  - 新建对话框的“约可执行 N 次请求”改用同一口径估算。预设值不变，但同样的上限按新口径能执行的次数会明显增多。
  - 用时 `timeUsedMs` 只累计 `active` 状态下的时长；暂停、阻碍、达到上限和关闭应用期间不计时。
- **状态条与详情**（`GoalCard`，沿用 G1 的单行布局和 36 px 高度上限）
  - 执行中：有计划时显示“步骤 2 / 5 · 当前步骤文本”，没有计划时显示“用时 12m”。设置了上限时追加进度条与“15k / 500k”。操作为 `暂停`、展开、`×`。
  - 已暂停：显示原因摘要，操作为 `继续`。
  - 遇到阻碍：显示模型摘要或“连续 3 轮没有进展”，操作为 `继续`、`编辑目标`。
  - 达到上限：显示“未完成 · 已达到用量上限 500k”，操作为 `调整上限并继续`。
  - 额度不足：显示“服务商额度不足”，操作为 `打开服务商设置`、`继续`。
  - 已完成：保持 G1 的显示和 8 秒收起，用时改为累计执行时长。
  - 达到上限和额度不足两种状态使用 `--warning` 图标，不只用颜色区分。
  - 详情区依次为：目标全文、计划清单、结果摘要、用量与用时、`编辑目标`、`跳到结果`。
- **修改与替换目标**
  - 状态条和详情提供“编辑目标”，打开 G1 对话框，目标已预填，按钮文案为“保存修改”。另新增 `/goal edit`（打开对话框）和 `/goal edit <新目标>`（直接修改）。
  - 修改后 `revision` 加 1，保留用量和用时，清零 `noProgressRuns` 和 `failedRuns`。
  - 修改后向模型注入一条 `display: false` 的消息，说明新目标取代之前的目标；新目标同样作为数据放在标签内。对话区显示一行灰色分隔：“目标已修改”。
  - 正在运行时，这条消息以 `steer` 方式送达；空闲且状态为 `active` 时，下一次续跑生效。
  - 已有未完成的 Goal 时再新建，不再报错，而是确认：“替换当前 Goal？当前 Goal 的进度记录会清除，已完成的修改保留。”取消则保留原目标。已完成的 Goal 直接替换，不弹确认。
- **入口与命令**
  - 已有 Goal 时，不带参数的 `/goal` 和 Goal 按钮都展开状态卡和详情，删除 `Goal 管理` 选择菜单；没有 Goal 时打开新建对话框。
  - 命令表在现有基础上增加 `/goal edit [新目标]`；`status`、`pause`、`resume`、`clear` 与 `--tokens N` 不变。
  - 目标上限改为 4000 字。超出时提示把要求写进项目文件，并在目标里引用该文件路径。
- **其他**
  - 从新会话开始 Goal 时，会话标题取目标首行的前 28 字，不再固定为“Goal”。
  - Goal 进入 `completed`、`blocked`、`budget_limited` 或 `usage_limited` 时，系统通知（沿用 `notifyOnFinish`）的标题写明对应状态，例如“Goal 已完成”“Goal 遇到阻碍”。

**验收标准。**

1. 未设上限时，本地模型桩连续 30 次调用工具后再提交 `completed`，Goal 一直执行到完成，中途不暂停。状态条始终不出现“续跑”字样。
2. 本地模型桩每次请求上报 `input 1000`、`cacheRead 90000`、`output 500`、`cacheWrite 0`，执行 10 次后，Goal 用量显示 15k，悬停显示的计费累计为 915k。
3. 设置 `20k` 上限后达到上限：当前工具正常执行完，不调用 `abort`；模型收到一次收尾提示；运行结束后状态为 `budget_limited`，状态条显示“调整上限并继续”，调高上限后恢复执行。
4. 连续 3 次自动续跑都没有工具调用，状态变为 `blocked`，原因为“连续 3 轮没有进展”；点击“继续”后计数清零。
5. 模型请求返回额度错误，状态变为 `usage_limited`，状态条提供“打开服务商设置”。
6. 暂停 60 秒再继续，用时不增加 60 秒。
7. 执行中修改目标：用量和用时保留；模型收到更新消息；对话区出现“目标已修改”；用旧 `revision` 调用工具被拒绝。
8. 已有执行中的 Goal 时新建，弹出替换确认；取消后原 Goal 不变，也不发起模型请求。
9. 已有 Goal 时输入 `/goal`，展开状态卡，不出现选择菜单。
10. 模型调用 `desktop_goal_plan` 后，状态条显示“步骤 i / n”，详情显示计划清单；切换分支后计划随分支恢复。
11. 打开含 v1 Goal 的历史会话：状态正确保留，旧证据显示在摘要区，“跳到结果”能定位 `desktop_goal_complete` 工具卡。
12. 目标超过 4000 字时无法提交，并显示引用项目文件的提示。
13. 重启后，原执行中的 Goal 显示为暂停，不自动发起模型请求（与现状一致）。

**测试。**

- `tests/goal.test.ts` 覆盖以下内容：
  - v2 状态校验与 v1 迁移；
  - 停止条件表中的每一行；
  - 新的用量公式；
  - 用时只在 `active` 时累计；
  - `revision` 校验；
  - 计划步骤约束；
  - 续跑提示包含完成审计、阻碍审计与“目标作为数据”这三段。
- `tests/support/goal-provider.ts` 增加上报缓存用量、额度错误和计划调用的脚本。
- `scripts/test-goal.ts` 用真实 Pi 验证三点：30 次续跑不中断、达到上限后收尾而不中止、修改目标后的上下文。
- `scripts/test-goal-ui.mjs` 覆盖以下交互：
  - 各状态的状态条与操作；
  - 编辑和替换确认；
  - 不带参数的 `/goal` 展开状态卡；
  - 计划步骤显示；
  - 会话标题。
- 实现后同步更新 `docs/goal.md`、双语 README 中的 Goal 说明和发布说明。

**参考。**

- [Codex 命令说明](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals)
- [长时间任务](https://learn.chatgpt.com/docs/long-running-work)
- Codex 源码 `codex-rs/ext/goal/src/`（[spec.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/spec.rs) 等）
- Codex 提示模板 `codex-rs/ext/goal/templates/goals/`（`continuation.md`、`budget_limit.md`、`objective_updated.md`）

## Goal 状态卡与已实现功能修正（已实现）

### G1 Goal 状态卡重做

**背景与问题。**

1. 完成后不消失：Goal 通过 `ctx.ui.setWidget` 输出纯文本行（`electron/pi-goal.ts` 的 `details`），桌面端 `ComposerStatus`（`src/components/conversation/ComposerStatus.tsx` 的 `.extension-widget`）原样 `pre-wrap` 输出，没有高度上限。状态为“已完成”后仍常驻输入框上方，只有在 Goal 菜单选“清除目标”或输入 `/goal clear` 才会移除。
2. 内容重复：完成摘要与证据已出现在对话区（模型回复与 `desktop_goal_complete` 工具卡），挂件再完整显示一遍，底部 `setStatus` 又显示“Goal：已完成”，同一信息出现三次，长证据会把输入框顶到屏幕下半部分。
3. 不能收起、不知道在哪关：挂件没有任何按钮，关闭入口只在 Goal 按钮菜单里，且菜单项名为“清除目标”，用户不会联想到“关闭这张卡”。
4. Token 含义不清：显示的是每次模型请求 `usage.totalTokens`（输入 + 输出 + 缓存读写）的累加，长任务中每次请求都会重发上下文，因此数字远大于上下文用量（截图中上下文 91k，Goal 已计 649k）。界面只写“Token：649319（未设预算）”，用户既看不懂这个数，也不知道预算该填多少；新建时直接弹出“Token 预算（可选）”输入框，加重了“必须设置 token”的误解。

**目标。** Goal 在输入框上方只占一行，运行中可看进度，结束后自动收拢并可一键关闭；详情按需展开；预算是可选的高级项，并用用户能理解的单位说明。

**不做。** 不改变 Goal 的完成判定、自动续跑与审批规则；不改变 `/goal` 命令语法；不改用量统计口径（仍为供应商计费用量）。

**交互与技术方案。**

- **结构化状态，不再用文本挂件**
  - `pi-goal.ts` 的 `render` 改为通过桥接事件发送结构化状态 `desktop_goal`（`{ id, status, objective, tokensUsed, tokenBudget?, continuations, maxContinuations, reason?, summary?, evidence?, updatedAt }`，无 Goal 时为 `null`），不再调用 `setWidget` 与 `setStatus`。桌面端新增 `GoalCard` 组件渲染，`runtime` 增加 `goal` 字段；`/goal status` 的文字通知保留。
- **一行状态条**（输入框上方，替代原挂件）
  - 内容：状态图标（执行中琥珀色旋转、已暂停灰色、遇到阻碍红色、已完成墨绿对勾）· `Goal` · 目标首行（单行省略）· 右侧进度与操作。
  - 执行中：右侧显示 `第 N / 25 次续跑`；设置了预算时追加细进度条与 `X / Y`，未设预算时不显示任何 Token 数字。操作：`暂停`、展开箭头。
  - 已暂停 / 遇到阻碍：右侧显示原因摘要（单行省略，例如“已达到预算”），操作：`继续`（预算已用尽时改为“调整预算并继续”）、展开箭头、`×`。
  - 已完成：显示“Goal 已完成 · 用时 m:ss · 查看结果”，操作：`查看结果`（展开）、`×`。完成后 8 秒内若用户未展开或悬停，状态条自动淡出为输入框工具栏中 Goal 按钮上的墨绿圆点；点击 Goal 按钮可再次查看。
  - `×` 等同于清除目标（已完成时无需确认；执行中或暂停时确认“清除后不再自动继续，已完成的修改保留”）。
- **展开详情**（点击展开箭头或“查看结果”）
  - 在状态条下方展开，最大高度 40vh，内部滚动：目标全文、结果摘要、证据（Markdown 渲染，证据默认只显示前 6 行并可“展开全部”）、用量。
  - “跳到结果”按钮滚动到对话中 `desktop_goal_complete` 工具卡并闪烁定位，避免重复阅读。
  - 展开状态按会话保存在视图状态中；`Esc` 收起。
- **用量与预算说明**
  - 详情中用量写作“已用 649k tokens（含每次请求重复发送的上下文与缓存，与底部累计口径一致）”，数字统一用 `k`/`m` 缩写，悬停显示精确值与估算费用（沿用 E3 费用计算）。
  - 新建 Goal 改为单个对话框：目标输入框 + 折叠的“高级：用量上限（可选）”。上限提供预设 `不限`（默认）/`500k`/`2m`/`5m`/自定义，并在下方提示“按当前会话平均每次请求约 X tokens 估算，约可执行 N 次请求”；没有历史数据时只提示“上限按供应商计费用量计算，包含重复发送的上下文”。
  - 达到上限暂停后，状态条操作为“调整上限并继续”，打开同一对话框的上限部分，确认后自动恢复。
- **底部状态行**：不再显示“Goal：已完成”，状态只在状态条与 Goal 按钮上显示。

**验收标准。**

1. Goal 执行中，输入框上方只有一行状态条（高度不超过 36 px），显示续跑次数；未设上限时不出现 Token 数字。
2. Goal 完成后，状态条显示“Goal 已完成”；8 秒内无操作时收起为 Goal 按钮上的圆点；点击 `×` 立即移除，无需打开菜单。
3. 展开详情时证据默认最多显示 6 行，详情区域最高 40vh 并可滚动，输入框位置不被推出视口。
4. 新建 Goal 不填写任何上限即可开始；设置 `500k` 上限达到后暂停，状态条显示“调整上限并继续”。
5. 底部状态行不再出现“Goal：已完成”；对话区之外，同一结果文本不重复出现。
6. 重启或切换会话后，已完成且未关闭的 Goal 以收起的圆点状态恢复，不自动展开。

**测试。** `tests/goal.test.ts` 覆盖结构化状态事件（各状态、预算与续跑字段、清除为 `null`）与预设上限解析；`scripts/test-goal-ui.mjs` 覆盖状态条各状态、完成后自动收起、`×` 关闭、详情限高与跳到结果、新建对话框的高级上限与“调整上限并继续”。

### F1 已实现功能的审查修正

以下来自对 UI6、UI7、C1、C2 实现与本文档的逐条核对。前两项为本文档规格本身的缺陷，其余为实现偏差或风险。

| 编号 | 问题 | 修正 | 位置 |
| --- | --- | --- | --- |
| F1-1 | 侧边对话用 `字符数 / 3` 估算 token，中文约 1 字 1 token，实际可达估算的 3 倍，“不超过上下文 50%”的裁剪失效；且未计入侧边历史与新问题，长中文会话选“整个会话”容易超出上下文 | 改用与上下文水位相同的估算（中日韩字符按 1 token、其余按 4 字符 1 token），并把侧边历史与新问题计入同一预算；模型无上下文窗口信息时按 128k 处理而不是报错 | `shared/side-chat.ts:90-97`、`electron/main.ts:584-588` |
| F1-2 | 侧边对话回答中删除该会话时，删除操作静默等待回答结束（最长 10 分钟） | 删除前先中止侧边请求，再弹出删除确认 | `electron/main.ts:862` |
| F1-3 | 仅侧边对话在回答时也被视为“任务执行中”，阻止资源包安装、更新与空闲释放，退出提示“Pi 仍在执行任务” | 侧边请求单独处理：退出与更新时提示“侧边对话正在回答，将被停止”，确认后中止；不阻止资源包操作以外的空闲释放 | `electron/agent.ts:162` |
| F1-4 | 桥接 10 分钟超时后桌面放弃等待，但 Pi 侧仍持有侧边对话锁，后续提问报“侧边对话正在回答” | 超时时同时发送 `side_chat_abort` | `electron/rpc.ts:199`、`electron/agent.ts` |
| F1-5 | “已省略前 N 轮”只在发送后显示，重新载入后丢失 | 选择范围时即预估并显示；随侧边历史保存 | `electron/side-chats.ts:34` |
| F1-6 | “作为新会话继续”创建的会话没有项目，草稿里是原始引用 Markdown | 继承原会话项目；引用恢复为 C1 引用芯片 | `electron/main.ts:649-663` |
| F1-7 | UI6 规格把 `#序号` 定为 `3ch` 宽并裁切，第 100 轮起显示为 `#12` | 宽度改为按最大轮次位数计算（`(位数 + 1)ch`），不裁切 | `src/styles/conversation-v014.css:444-449` |
| F1-8 | 查找命中自动展开技能正文或长提问后，展开状态被保存，关闭查找后仍保持展开（附件只在命中期间展开） | 查找引起的展开不写入 `saveView`，与附件一致 | `src/components/conversation/Markdown.tsx:186-191` |
| F1-9 | 轮次目录行在本轮没有回复时按 `C` 无任何反馈 | 显示“本轮没有可复制的回复”提示 | `src/components/conversation/TurnOutline.tsx:146-147` |
| F1-10 | 引用卡片只按换行数判断“超过 4 行”，长段落自动换行后不折叠 | 按渲染高度判断（超过 4 行行高即折叠） | `src/components/conversation/Markdown.tsx:277` |
| F1-11 | 运行中的工具卡片与 `!命令` 输出不在 `[data-message-index]` 内，选中后不出现引用菜单 | 为这两类容器补充来源标记，出处标为“工具输出” | `src/components/Conversation.tsx:773`、`SelectionMenu.tsx:40-43` |
| F1-12 | 选区靠近对话区顶部时浮动菜单被限制在顶部 40 px 处，遮住选区 | 上方空间不足时改为显示在选区下方 | `src/components/conversation/SelectionMenu.tsx:112` |
| F1-13 | 轮次目录运行态刻度在组件内把 `--warning` 重定义为 `--signal`，与主题的 `--warning` 不一致，测试比较的是同一覆盖值，无法发现偏差 | 移除局部覆盖，测试改为读取主题根变量 | `src/styles/conversation-v014.css:338` |

引用芯片文案（`第 N 轮 Pi 回复`）与独立一行显示，属于可接受的实现差异，按现状更新本文档 C1 描述，不再修改代码。

**测试补充。** 侧边对话中文上下文裁剪与历史计入；删除会话时中止侧边请求；仅侧边请求时的退出提示；第 100 轮以上的序号显示；查找关闭后展开状态恢复；`C` 键无回复提示；长段落引用折叠；运行中工具卡片与 `!命令` 输出的引用；“到此条回复”请求内容包含该轮正文（C2 验收 2 目前未断言）。

**实现记录（2026-10-28，v0.14.53）。**

- G1 使用 `desktop_goal` 结构化事件与 `GoalCard`；保留原状态的 `createdAt` 计算用时。状态条、40vh 详情、Markdown 证据、8 秒收起、清除确认、单个新建对话框和调整上限后继续均已实现。读取普通与大文件历史时从当前分支恢复 Goal，不连接 Pi、不发起模型请求；已完成状态在切换和重启后恢复为圆点。
- F1-1 至 F1-13 已完成。侧边文件保存消息和省略轮次，并读取 v0.14.52 的旧数组格式。运行中工具的引用保存 `toolCallId` 作为出处，结果消息生成后即使时间戳改变也能返回同一工具卡。
- `tests/goal.test.ts`、`tests/side-chat.test.ts`、`tests/session-agents.test.ts`、`tests/session-io-boundaries.test.mjs` 与 `tests/placeholder-lifecycle.test.ts` 覆盖状态、预算、裁剪、保存、中止和更新准备；`scripts/test-goal-ui.mjs` 与对话窗口测试补充了本节的交互检查，也已断言实际侧边请求包含所选回复正文。

## 对话内容引用与侧边对话（已实现）

C1 引用对话片段进入输入框；C2 在不影响主会话上下文的前提下另开一个临时问答面板。两项共用同一选区浮动菜单。保持现有主会话的运行规则：侧边对话不调用工具、不修改文件，使用一次独立的模型请求。

### C1 对话内容引用

**背景与问题。** 想针对 Pi 回复中的某一句或某段代码追问时，只能手动复制粘贴到输入框，再写“你上面说的……”。粘贴后的文字与正文混在一起，看不出出处，长段落还会被折叠成粘贴片段芯片，失去上下文。现有 T2 引用只覆盖项目文件和差异块，不覆盖对话内容。

**目标。** 在对话区选中任意文字即可一键引用，引用在输入框中以可识别的引用块显示，发送后在消息中保留出处并可点击回到原文。

**不做。** 不支持跨多条消息的单次选区（跨消息时只取起点所在消息内的部分，并提示）；不引用工具卡片的原始 JSON 参数；不引用图片。

**交互与技术方案。**

- **选区浮动菜单**
  - 在用户消息、Pi 回复、思考过程、代码块和工具输出（`ToolCard` 展开后的输出区）中选中文字，松开鼠标后在选区上方 6 px 显示浮动菜单：`引用`、`侧边提问`、`复制`。选区为空、只含空白或位于输入框内时不显示。
  - 键盘：对话区有选区时 `Ctrl+'`（macOS `⌘'`）引用，`Ctrl+L`（`⌘L`）侧边提问，写入 `shared/workbench-actions.ts` 与快捷键速查（避开 macOS 系统占用的 `⌘⇧Q` 注销与 `⇧⌘L` 服务菜单，且现有快捷键处理忽略带 `Shift` 的组合）。`Esc` 或点击其他位置关闭菜单。
  - 菜单跟随滚动；选区滚出视口时隐藏。
- **引用块**
  - 点击“引用”后，输入框上方出现独立一行引用芯片：`❝ 第 N 轮 Pi 回复 · 前 40 字…`，悬停显示全文（上限 2000 字），点击芯片在对话区定位并闪烁原文。可同时存在多个引用，按添加顺序排列；同一选区重复引用时只保留一份。
  - 草稿持久化：`Session` 新增 `draftQuotes?: DraftQuote[]`（`{ id, text, role, turn, messageTimestamp, section }`），随草稿保存、切换会话与重启保留；编辑重发与排队恢复时与 `draftSnippets` 同样处理。
  - 发送格式：引用按 Markdown 引用块放在正文前，每段之前一行出处标注，例如 `> [引用 第 3 轮 Pi 回复]` 后接逐行 `> 原文`，与正文之间空一行。单个引用上限 8000 字，超出时截断并在芯片上标注“已截断”。合计计入 UI5 的容量预估。
  - 出处标题使用 `pi-quote:` 链接保存编码后的来源信息（含消息时间戳），正文仍为普通 Markdown 引用。重启、编辑重发及分页跳转均从这份信息还原出处。
- **消息中的引用显示**
  - `UserMessage` 识别正文开头连续的引用块（由 `shared/message-content.ts` 的同一解析函数产生与识别），渲染为左侧墨绿竖线的引用卡片，标题为出处，内容超过 4 行时折叠。点击出处跳转到原消息并闪烁；原消息不在当前会话分支或已被删除时，出处显示为灰色且不可点击。
  - 轮次目录标题与 UI7 的“复制消息”“编辑后重新发送”跳过引用块，只取用户正文；编辑重发时引用恢复为芯片。
- **出处定位**：按 `messageTimestamp` 查找消息，再在消息文本中定位原文首次出现的位置并高亮；找不到原文时只定位到消息。

**验收标准。**

1. 在 Pi 回复中选中一段文字，浮动菜单在 100 毫秒内出现；点击“引用”后输入框上方的独立引用行出现芯片，焦点进入输入框，已有草稿不丢失。
2. 引用两段内容并输入“这两处冲突吗”发送，模型收到的文本依次为两个带出处的引用块和正文；对话区用户消息显示两张引用卡片与正文。
3. 点击引用卡片的出处，对话区滚动到原消息并高亮所引原文；跨分页的原消息自动加载。
4. 带引用芯片的草稿在切换会话、重启应用后保留；“编辑后重新发送”恢复为芯片而非纯文本。
5. 从工具输出、代码块中选中文字同样可以引用，出处分别标为“工具输出”“代码”。

**测试。** `tests/conversation-v014.test.ts` 覆盖引用块生成、解析往返、截断与出处标注；`tests/transcript-sync.test.ts` 或草稿相关测试覆盖 `draftQuotes` 的持久化、编辑恢复与排队恢复；`scripts/test-chat-ui.mjs` 覆盖选区菜单、多引用、发送渲染与出处跳转。

### C2 侧边对话

**背景与问题。** 主任务进行中或刚完成时，用户常有与主线无关的小问题（“这个报错是什么意思”“这段正则怎么读”）。现在只能：

1. 在主会话里问：问题与回答进入主会话上下文，干扰后续任务，增加 token 成本；运行中只能排队，要等主任务结束。
2. 新建独立对话：需要离开当前对话视图，并重新复制粘贴背景；新对话不自动获得原会话的上下文。
3. 使用“从这里分支”：会创建完整的新会话并切换过去，过程较重。

**目标。** 在对话区右侧打开一个临时问答面板，可以带着当前会话的上下文或选中的片段提问，不写入主会话、不打断正在运行的主任务；有价值的回答可以一键带回主会话。

**不做。** 侧边对话不提供工具调用（不读写文件、不执行命令）、不支持 `/skill:` 与提示词模板展开、不支持图片输入；不提供多个并行侧边对话；不同步到 Pi 的会话文件。

**交互与技术方案。**

- **入口**
  - 选区浮动菜单“侧边提问”：打开面板，并把选区作为引用放入侧边输入框。
  - 每条 Pi 回复的消息操作栏新增“侧边提问”图标；对话区顶栏新增“侧边对话”按钮；快捷键 `Ctrl+L`（`⌘L`；无选区时直接打开或关闭面板）。
- **面板布局**
  - 在对话区与右侧工作区面板之间滑出，默认宽 360 px（`300–560 px`，沿用 UI1 分隔条拖拽与 `Settings` 持久化）；窄窗口（`< 900 px`）以覆盖抽屉显示。不会挤占右侧工作区面板的宽度设置。
  - 顶部：标题“侧边对话”、上下文范围选择、模型名（只读，跟随主会话当前模型）、清空、关闭。中部为问答消息流（复用 `RichText` 与代码块），底部为精简输入框（`Enter` 发送、`Shift+Enter` 换行，支持 C1 引用芯片，不支持 `@` 文件与图片）。
  - `Esc`（焦点在面板内且无弹层时）关闭面板；关闭不清空内容，重新打开时恢复。
- **上下文范围**（单选，默认“仅引用内容”；从某条回复的操作栏打开时默认“到此条回复”）
  - 仅引用内容：只发送用户在侧边输入的问题与引用。
  - 到此条回复：附带主会话从开头到该条回复的用户提问与 Pi 回复正文（不含思考过程，工具结果只保留工具名与目标路径）。
  - 整个会话：同上，截至当前最新一条已完成回复。
  - 附带上下文超过当前模型上下文窗口的 50% 时，从最早的轮次开始丢弃并在范围选择旁提示“已省略前 N 轮”。
- **执行方式**（`electron/pi-bridge.ts`、`electron/agent.ts`）
  - 新增桥接方法 `side_chat`：扩展内用 `ctx.modelRegistry.stream(ctx.model, { systemPrompt, messages }, { signal })` 发起独立模型请求，不调用 `pi.sendMessage`，不写入会话条目，不触发工具，因此不影响主会话上下文和 `session_start`/`agent_end` 等事件。Pi 文档说明扩展命令在主会话流式输出时也会立即执行，因此主任务运行中可以并行提问。
  - 流式输出：扩展通过现有 `__PI_DESKTOP__` 通知通道发送 `desktop_side_chat_delta`（`{ id, text }`）与最终 `desktop_result`；主进程转发给渲染进程。停止按钮通过新增的 `side_chat_abort` 桥接方法中止请求。
  - 系统提示：说明这是与主任务并行的旁路提问，回答应简洁，不得声称已修改文件或执行命令。
  - 认证与错误沿用 S2 的模型错误分类；未连接 Pi 或当前无模型时，面板显示原因与“打开模型设置”入口。
- **存储与成本**
  - 侧边对话内容按会话保存在桌面数据目录 `side-chats/${sessionId}.json`（最多保留最近 50 条问答），不写入 Pi 会话文件；“清空”删除该文件。会话删除时一并删除。
  - 侧边对话的 usage 计入 E3 本地费用统计，单独标注“侧边对话”，不计入主会话上下文水位。
- **带回主会话**
  - 每条侧边回答底部提供：`复制`、`引用到主输入框`（作为 C1 引用芯片，出处标注“侧边对话”）、`作为新会话继续`（以该问答为首条消息创建独立对话，不自动发送）。
  - 不提供“直接发送到主会话”，避免在主任务运行中意外插入消息。

**验收标准。**

1. 主会话正在执行工具时打开侧边对话并提问，3 秒内开始流式输出；主会话的执行、审批弹窗和消息流不受影响，结束后主会话消息数量不变。
2. 选择“到此条回复”提问“上面第二步为什么这么做”，回答能正确引用主会话该轮内容；Pi 会话文件中不出现这次问答。
3. 侧边对话停止按钮能在 1 秒内中止输出；切换会话后侧边面板显示对应会话的历史问答，重启应用后保留。
4. 侧边回答点击“引用到主输入框”后，主输入框附件栏出现出处为“侧边对话”的引用芯片。
5. 未连接 Pi 时打开面板，输入框禁用并显示原因；断开重连后无需重开面板即可提问。
6. 设置中的费用统计显示“侧边对话”分项。

**测试。** `tests/` 新增侧边对话单元测试：上下文范围裁剪（含思考过程剔除、工具结果精简、超限丢弃）、存储上限与删除联动、桥接参数校验；使用 `tests/support/goal-provider.ts` 同类的本地模型桩验证流式增量、中止与“不写入会话条目”；`scripts/test-chat-ui.mjs` 覆盖面板开合、运行中提问、引用带回与窄窗口抽屉模式。

## 长提问折叠与按轮次复制结果（已实现）

只改变渲染与复制方式，不改变 `messages` 存储、Pi 的 `/skill:` 展开格式与轮次划分。

### UI7 技能块与长提问折叠、跳转落点与本轮结果复制

**背景与问题。**

1. 技能正文占满屏幕：Pi 把 `/skill:name 参数` 展开为 `<skill name="…" location="…">技能正文</skill>\n\n参数` 存入用户消息。轮次目录已用 `turnTitle`（`src/lib/conversation-layout.ts:142`）提取标题，但对话区的 `UserMessage`（`src/components/conversation/Markdown.tsx:162`）仍把整段技能正文按 Markdown 渲染，用户真正输入的参数排在最后。Pi 终端界面使用 `SkillInvocationMessageComponent` 默认折叠技能正文，桌面版没有对应处理。长粘贴片段在发送时由 `composeDraftText` 展开为正文，也有同样问题。
2. 跳转落点不对：点击轮次目录后，`jump` 把目标消息滚到视口顶部（`src/components/Conversation.tsx` 的 `scrollIntoView({ block: 'start' })`）。用户要找的通常是本轮 Pi 的回复，要越过整段提问才能看到。
3. 复制结果难：复制按钮只在悬停时出现在每条消息的标题行。一轮中 Pi 的结论常在多次工具调用之后的最后一条助手消息里，要向下翻找并对准它悬停。
4. 编辑重发：`messageAction('edit')` 把还原后的全文（含技能正文）放回草稿（`electron/agent.ts:1750`），用户还要手动删除技能正文。

**目标。** 对话区里的用户消息只突出用户输入的内容，技能正文和长提问可展开但默认不占空间；从轮次目录跳转后直接看到用户的问题和 Pi 的回复开头；一轮的结论能一键复制。

**不做。** 不修改发给模型的内容；不改写已存会话；不做逐段选择复制、导出整个会话为 Markdown（已有会话导出功能）。

**交互与技术方案。**

- **技能块折叠**（`UserMessage`，与 `turnTitle` 共用同一解析函数，放入 `shared/message-content.ts`）
  - 识别到技能块时，消息正文只渲染附带的用户消息；正文上方显示一行技能芯片：`技能 · {name} · {N} 行`，样式与 `project_file` 附件行（`.message-attachment`）一致，默认收起，点击展开为限高 50vh 的滚动区域（Markdown 渲染，带“复制技能正文”按钮）。
  - 没有附带用户消息时，正文位置显示“使用技能 {name}”。
  - 展开状态与工具卡片一样记入会话视图（`saveView` 的 `expanded`，键为 `skill:{消息时间戳}`）。
  - 会话内查找：技能正文作为独立分区（`section: 'skill'`）参与搜索，命中时自动展开并定位，与附件分区行为一致。
- **长提问折叠**
  - 去掉技能块和附件后，用户正文超过 12 行或 1200 字时，气泡限高 12 行，底部渐隐并显示“展开全文（共 N 行）”；展开后在气泡底部显示“收起”。展开状态同样记入会话视图。
  - 会话内查找命中被折叠的部分时自动展开。
- **跳转落点**
  - 从轮次目录、`Alt+↑/↓` 跳转时，落点改为“用户消息的最后 3 行”：用户消息高度不超过视口 40% 时滚动到消息顶部（保持现状）；超过时滚动到让消息底部位于视口 40% 高度处，使下方回复开头可见。技能块和长提问折叠后，大多数情况下用户消息本身已足够短。
  - 落点闪烁高亮保持不变。
- **本轮结果复制**
  - 每轮最后一条有正文的助手消息底部（`ReplySpeed` 一行）常驻显示“复制回复”文字按钮，不需要悬停；该轮仍在运行时不显示。
  - 轮次目录展开后，每行悬停时右侧出现复制图标，点击复制该轮最后一条助手消息的正文（不含思考过程和工具输出），无需先跳转。键盘焦点在目录行上时按 `C` 同效（`Ctrl+C` 保留为系统复制）。
  - 复制成功后沿用“消息已复制”提示；该轮没有助手正文时图标禁用，提示“本轮没有可复制的回复”。
- **复制与编辑的原文**
  - 用户消息的“复制消息”复制可还原的输入：技能调用复制为 `/skill:{name} {附带消息}`，不包含技能正文；附件仍按现状剥离。消息菜单另提供“复制完整内容”，复制发给模型的原文。
  - “编辑后重新发送”同样还原为 `/skill:{name} {附带消息}`，重新发送时由 Pi 重新展开最新的技能正文。

**验收标准。**

1. 使用 300 行技能正文发送 `/skill:x 帮我看看`，对话区用户气泡只显示技能芯片和“帮我看看”，高度不超过 3 行；点击芯片展开技能正文，刷新或切换会话后展开状态保持。
2. 会话内查找技能正文中的词语，命中后技能区域自动展开并高亮命中位置。
3. 粘贴 200 行文本发送后，气泡默认显示 12 行和“展开全文（共 200 行）”。
4. 在 20 轮会话中从目录跳到第 5 轮，跳转结束时第 5 轮用户提问末尾和 Pi 回复开头同时可见。
5. 不展开、不滚动对话区，在轮次目录第 5 行点击复制图标，剪贴板内容等于第 5 轮最后一条助手消息正文。
6. 技能调用消息的“复制消息”得到 `/skill:x 帮我看看`；“编辑后重新发送”后输入框内容为 `/skill:x 帮我看看`。
7. 5000 条消息的性能用例保持通过，目录渲染按钮数仍不超过 60（每行复制图标只在悬停或聚焦时渲染）。

**测试。** `tests/conversation-v014.test.ts` 覆盖技能块解析共用函数、`/skill:` 还原、本轮最后一条助手正文的选取（含工具穿插、仅思考、运行中）；`tests/session-search.test.ts` 覆盖 `skill` 分区；`scripts/test-chat-ui.mjs` 覆盖技能芯片折叠与持久化、长提问折叠、跳转后回复开头可见、目录行复制与回复底部复制按钮。

## v0.14.49：对话轮次目录视觉与交互优化（已实现）

在 v0.13.0 UI3 轮次目录基础上调整视觉与交互，不改变 `messages` 存储、轮次划分（`conversationTurns`）与跳转定位（`jump`、`messageWindow`）。

### UI6 轮次目录（Turn Outline）重做

**背景与问题。** 优化前的实现（`src/components/conversation/TurnOutline.tsx`、`src/styles/conversation-v014.css`）在长会话中有以下问题：

1. 刻度不对齐：行按钮继承全局 `button { justify-content: center }`（`src/styles/base.css`），展开后每行内容居中，刻度横向位置随标题长短漂移。
2. 悬停时刻度跳位与闪烁：收起时刻度贴右边缘，展开后刻度变成每行最左侧元素，浮层向左撑开，鼠标下的刻度被推走约 300 px；边框仅在悬停时出现，造成 1 px 抖动；没有悬停延迟，指针划过右边缘即闪开闪关。
3. 统计噪声：每行固定显示 `+0 / −0`，无修改的轮次占多数时成为主要视觉噪声，增删也不区分颜色。
4. 标题未清洗：标题取用户原文前 36 字，只剥离了 `project_file` 块；技能调用显示为 `<skill name="reverse-skill-router" l…`，多行提问和仅图片的提问也未处理。标题先截 36 字再被 CSS 省略，出现两次截断。
5. 状态弱：当前轮次只有刻度加长，展开后的行本身没有高亮；正在运行的轮次没有状态。

**目标。** 收起时是一条安静、对齐的刻度轨，展开时是可读、可扫视的目录；悬停展开不移动任何已有元素；标题显示用户真正输入的内容。

**不做。** 不在目录中显示助手回复摘要；不做轮次重命名、编辑或拖拽；不改变“3 轮及以上才显示”的规则。

**交互与技术方案。**

- **布局**
  - 每行固定为：`#序号`（按最大轮次位数加 1 计算宽度、不裁切、`tabular-nums`、`--muted`）· 标题（单行省略，占满剩余宽度）· 增删统计（右对齐）· 刻度列（行最右侧 16 px，刻度右对齐）。行按钮显式设置 `justify-content: flex-start`，覆盖全局按钮样式。
  - 收起与展开使用同一行高（26 px）和同一刻度位置，浮层只向左展开，刻度不移位。
  - 浮层宽度 `clamp(240px, 32vw, 360px)`，且不超过对话区宽度减 48 px；最大高度为对话区高度的 60%。
  - 边框、背景与阴影在收起时透明而非移除，避免尺寸抖动。颜色只用主题变量（`--surface`、`--line`、`--shadow`、`--hover`、`--accent`、`--accent-soft`、`--red`、`--warning`、`--muted`），浅色、深色、护眼米黄、豆沙绿与深蓝主题通用。
- **刻度**
  - 2 px 高、圆头。普通轮次 8 px、`--muted` 半透明；含修改为 `--accent`；含失败为 `--red`；正在运行的最后一轮为 `--warning` 并缓慢呼吸（`prefers-reduced-motion` 时静止）；当前轮次加长到 16 px、完全不透明。
  - 收起状态下刻度轨随对话滚动自动滚动，让当前轮次保持可见。
- **展开行**
  - 悬停行使用 `--hover` 背景；当前轮次行使用 `--accent-soft` 背景、标题加粗，`aria-current="step"`。
  - 统计仅在有增删时显示，只显示非零一侧：`+12` 用 `--accent`，`−3` 用 `--red`，10 px 等宽数字。失败轮次在统计位置显示红色小字“失败”，不只依赖颜色区分。
- **标题清洗**（`src/lib/conversation-layout.ts`，纯函数）
  - 依次：剥离 `project_file` 块；识别 Pi 技能块 `<skill name="…" location="…">…</skill>`（格式同 Pi `parseSkillBlock`），有附带用户消息时显示该消息，否则显示“使用技能 {name}”，并在标题前显示技能名小标签；合并换行与连续空白；去除行首 Markdown 标记（`#`、`>`、列表符号）；没有文字时显示“[图片 ×N]”或“（无文字）”。
  - 标题保留至 80 字后交给 CSS 省略，不再预截 36 字；`title` 提示显示清洗后的文字（上限 200 字）。
- **悬停意图**
  - 指针在刻度轨停留 120 ms 后展开；离开浮层 250 ms 后收起，期间回到浮层则取消收起。展开时淡入并向左滑入 6 px，耗时 120 ms（减少动态效果时直接显示）。
  - 展开时把当前轮次滚动到浮层可视区中部。
- **跳转反馈**：点击或 `Enter` 跳转后，目标用户消息以 `--accent-soft` 背景闪烁 1 秒以确认落点；指针仍在浮层上时浮层保持打开。
- **键盘**
  - 保留 `↑`/`↓`/`Home`/`End`；新增 `Esc` 收起浮层并把焦点还给对话区。
  - 新增 `Alt+↑` / `Alt+↓` 跳到上一轮 / 下一轮用户提问，写入 `shared/workbench-actions.ts` 与快捷键速查。焦点在有内容的文本输入框中时不拦截，保留系统光标行为（如 macOS `⌥↑` 移到段首）；输入框为空时生效（不与历史召回冲突，召回要求无修饰键）。
- **长会话筛选**：达到 10 轮时，浮层顶部显示“N 轮 · 修改 X · 失败 Y”，点击“修改”或“失败”切换为只看该类轮次，再次点击取消。筛选后键盘导航与虚拟列表按筛选结果计算；当前轮次被筛掉时不高亮任何行。
- **无障碍**：每行 `aria-label` 为“第 N 轮：标题，新增 X 行，删除 Y 行，有失败”，只包含实际存在的部分。
- **性能**：保留现有虚拟列表（最多渲染 60 行）；清洗后的标题随 `conversationTurns` 一同按消息缓存。

**验收标准。**

1. 展开浮层后，所有可见行刻度的右边缘横坐标一致（误差 ≤ 1 px）；悬停展开前后，同一轮刻度的屏幕坐标不变。
2. 无增删的轮次不显示统计；有增删的轮次增为墨绿、删为红色，只显示非零一侧。
3. 以技能调用开头的提问显示为技能标签加用户消息（或“使用技能 xxx”），不出现 `<skill` 原文；多行提问显示为一行；仅图片的提问显示“[图片 ×N]”。
4. 指针快速划过对话区右边缘（停留不足 120 ms）不展开浮层；从刻度轨移入浮层的过程中浮层不闪关。
5. 当前轮次行有背景高亮；运行中的最后一轮刻度为琥珀色，完成后恢复对应颜色。
6. 输入框为空时 `Alt+↑/↓` 逐轮跳转；`Esc` 收起浮层。
7. 五套主题下浮层文字与背景的对比度不低于 4.5:1。
8. 5000 条消息的性能用例中，目录渲染按钮数仍不超过 60，键盘导航用例保持通过。

**测试。** `tests/conversation-v014.test.ts` 覆盖标题清洗（技能块含/不含附带消息、`project_file`、多行、仅图片、空文本）与统计字段；`scripts/test-chat-ui.mjs` 覆盖刻度对齐与悬停不移位（比较 `boundingBox`）、零统计隐藏、悬停延迟、`Esc`、`Alt+↑/↓` 与筛选，并截取五套主题截图；`scripts/test-performance-ui.mjs` 现有目录用例保持通过。

**实现记录（2026-10-28）。**

- 使用固定 26 px 行高和最右侧刻度列，标题、统计、背景单独淡入；透明边框与长会话统计栏始终保留位置。收起时提前把当前轮次滚到中部（首尾按可滚范围限制），展开时不再移动刻度。
- 标题按消息缓存，保留技能标签和清洗后的用户文本；隐藏零增删，补齐失败文字、运行状态与减少动态效果支持。悬停背景由主题的 `--hover` 与 `--surface` 混合，保证五套主题的文字对比度。
- 目录支持延迟展开/收起、当前行高亮、修改/失败筛选、键盘导航和一秒定位提示。鼠标留在目录内时，焦点移出也保持展开；快速连续跳转按最新请求轮次计算，滚动完成或新轮次到来后释放跳转状态。
- 长会话最多挂载 58 行与 2 个筛选按钮，总按钮数不超过 60；筛选后的序号、键盘定位和虚拟列表使用同一份结果。原消息存储、轮次划分、消息分页与跳转定位沿用原实现。
- 本地验收覆盖五套主题，实测最低文字对比度为 4.58:1；截图位于 `test-results/turn-outline-{light,dark,sepia,green,navy}.png`。标题及快捷键单元测试、真实 Electron 交互与 5000 条消息目录用例随代码保留，可用上面的测试脚本复验。
- 验证通过：`npm run build`、`npm test`（704 通过、8 跳过）、`npm run test:integration`、`npm run test:features`（70 项）、`npm run test:chat-ui`、`npm run test:scroll-ui`、`npm run test:performance-ui`、`npm run lint`、`npm run format:check`。双语 README 与说明截图已更新；以上 UI 结果为 Windows 本地 Electron 验收，未替代 macOS/Linux 实机检查。

## v0.14.40：资源包确认与恢复一致性（已实现）

- 安装、更新资源包必须由主进程确认来源、作用范围和安装脚本风险；取消不执行命令并保留表单输入。
- 撤销识别文件名大小写别名，保留基线文件；扫描上限之外的文件及子目录进入未覆盖清单。旧检查点不能证明某个路径是新建时，不自动删除该路径。部分失败会报告已完成的文件并刷新清单。
- 停止、崩溃恢复保留排队消息的原始模板命令、文件引用、粘贴片段和图片；分支草稿不包含展开的附件正文。
- 配置支持 UTF-8 BOM，并可在界面修复损坏 JSON；原文视图提示可能含密钥，保存保留修复前备份。
- 普通轮次使用事件增量同步；压缩、导航、恢复或事件不完整时仍重新核对历史。哈希缓存保留最多八个会话。
- 补齐错误脱敏、目录类型检查、缺少 Bash 的就绪提示、Windows Python UTF-8 输出、终端锁清理与后台服务边界说明。
- 增加 ESLint、CI 格式检查、分支/PR 过期运行取消和 LF 换行约束；发布运行不自动取消，lint 工具不进入安装包。
- 验证与限制见 [审查后续修复记录](testing/review-followup-v01440.md) 和 [发布说明](releases/v0.14.40.md)。

## v0.8.0：稳定性与模块化（已实现）

本节实现范围为 R1、R2、R3。v0.9、v0.10 已完成；根据本轮合并迭代要求，v0.11–v0.14 的功能集中交付在 v0.14.0，实际实现和验证边界见 [v0.14 验收记录](v0.14-validation.md)。本版模块边界见 [架构说明](architecture.md)，验收证据见 [v0.8.0 验收记录](v0.8-validation.md)。

产品取舍原则：桌面端只做图形界面明显优于终端的事情（查看差异与撤销、审批、图片、通知、会话管理、稳定性）。Pi 已有的配置与管理能力复用其公开接口，不修改 Pi 本身。

### R1 本地索引与进程中断恢复

- 本地索引最多保留三份备份，相邻备份至少间隔十分钟。索引损坏时保留原文件，按顺序恢复可用备份；当前索引缺失时同样尝试恢复。无法恢复时以空索引启动，Pi JSONL 文件保持原样。
- 项目、会话与设置逐项校验，坏记录不影响其余记录。顶部提示明确显示备份时间、丢弃数量或重置设置数量，可以打开数据目录和关闭提示。
- 数据目录不能写入时进入只读状态，停止新任务及保存；任务发送前等待持久化结果，避免保存失败后仍调用模型。
- 意外退出卡片提供退出码、信号、最后工具及运行时间、最后二十行日志、本轮变更入口，以及重连、编辑提问后继续和撤销入口。十秒内重复崩溃有单独提示。
- 尚未执行的 steering/follow-up 文字与图片恢复到草稿，不自动重发；用户主动停止和终端交接不显示崩溃卡片。
- **明确边界：** Pi 主进程退出后，外部命令可能仍在运行。只有没有运行工具、或应用已成功结束整棵进程树时，才允许直接恢复。无法确认时后端与界面阻止启动、切换和撤销，用户需先手动结束残留命令，再重启应用；仅刷新窗口不会解除限制，仅重启应用不会结束旧命令。
- 覆盖：`tests/store.test.ts`、`scripts/test-recovery.ts`、`scripts/test-recovery-ui.mjs`，包括真实 Pi 崩溃、队列图片、磁盘写失败、停止竞争与只结束主进程的场景。

### R2 界面模块拆分与 CI

- `App.tsx` 只组合布局；面板、弹窗及消息展示进入 `components/`，状态订阅、草稿和快捷键进入 `hooks/`，纯展示函数进入 `lib/`。
- `PiFeatures.tsx` 按页签拆到 `features/`；样式按原顺序拆分，保留组件缓存、引用稳定性和增量推送。
- `App.tsx` 为 73 行，`src/` 最大文件为 676 行，均满足本版限制。
- Linux CI 通过 Xvfb 运行三套界面测试，失败时上传截图。Windows 本地界面测试已通过；macOS 界面未在本机实测，三平台的后端与构建结果以验收记录为准。
- 500 条消息、100 个工具、60 次更新：纯拆分前后中位耗时 14.9 → 14.8 ms，最终功能版本为 15.0 ms。纯拆分截图差异 3 / 1,189,040 像素（0.0002523%），低于 0.1% 阈值。

### R3 Pi 版本提示与协议边界

- 版本提示集中在 `shared/pi-version.ts`，由 `environment.ts` 导出供主进程使用。回归验证版本由 `VERIFIED` 指定，其他可识别版本（含预发布版）也允许使用，不限制主、次版本线。
- 设置中的 Pi 版本对所有可识别版本只显示版本号，不附加“已验证 / 未验证”标签，首页也不显示验证状态提示。无法识别的版本仍附加“未知”标签及安装引导。未验证版本不阻止连接、发送、模型测试、资源包操作或终端启动；只有入口无效或版本无法识别时阻止使用，并提供不指定版本线的 Pi 安装命令。
- `electron/pi/protocol.ts` 校验核心响应并转换统计字段；桌面扩展调用先确认命令注册，再核对协议版本。不会猜测新旧字段别名，也不会把缺失的内部扩展命令发送给模型。
- 诊断包含 `piCompatibility`。每周工作流安装最新 Pi，运行单元、集成与功能测试；开发依赖仍锁定完整回归基准，不作为运行版本限制。
- 覆盖：版本分类、跨版本放行、无法识别的入口、协议格式错误、扩展缺失、连接与模型探测和两处界面提示；真实 Pi 仍使用本地模型服务回归。

### 执行约定

交给其他同学执行时，请遵守以下约定，避免和现有实现冲突：

- **平台差异**统一放在 `electron/platform.ts`，不要在业务代码里写 `process.platform` 分支。路径比较用 `samePath()` / `pathKey()`。
- **与 Pi 交互**优先用 RPC 命令；RPC 没有的能力（树导航、标签、审批等）放进桌面适配扩展 `electron/pi-bridge.ts`，通过 `rpc.bridge(method, params)` 调用。不要修改 Pi 本身。
- **主进程到界面的状态**走增量推送（`runtimePatch`，见 `shared/types.ts` 的 `applyRuntimePatch`）。新增运行时字段时放在标量部分即可；新增数组必须同时更新 `flush()` 的增量逻辑和 `tests/runtime-patch.test.ts`。
- **新 IPC 方法**要在 `shared/types.ts` 的 `ApiMap` 声明，在 `electron/main.ts` 的 `handlers` 中校验所有参数（`text()` / `strings()`）；会启动或切换 Pi 的方法加入 `engineOperation` 列表。
- **文案**为中文，按钮写明动作结果（“撤销修改”而不是“确定”），错误说明原因和处理办法。
- **测试**：纯逻辑写进 `tests/*.test.ts`（`npm test`）；涉及 Pi 行为的用真实 Pi + 本地测试接口写进 `scripts/test-*.ts` 并加入 `npm run test:features`；界面行为加到对应的 `scripts/test-*-ui.mjs`。测试不得访问外网或调用付费模型。
- **文件换行**：仓库文本文件统一使用 LF，提交前运行 `npm run format:check` 和 `npm run lint`。
- **完成标准**：`npm run build`、`npm test`、`npm run test:integration`、`npm run test:features` 全部通过；涉及界面的同时通过对应 UI 测试；完成后把该项从“下一版”移入对应版本小节，写明实际范围；未做完的部分直接删除，不保留为待办。

## v0.9.0：应用内更新（已实现）

本版完成 U1，基于 v0.8.0 的索引备份和恢复能力。旧版用户需要手动安装 v0.9.0 一次，后续才可使用应用内更新。模块边界见 [架构说明](architecture.md)，验证证据见 [v0.9.0 验收记录](v0.9-validation.md)。

### U1 检查、下载与安装更新

| 安装方式 | 实际能力 |
| --- | --- |
| Windows NSIS 安装版 | 按用户安装，无需管理员权限；可选后台下载、显式重启安装，原生更新器支持差量下载 |
| Linux AppImage | 可选后台下载、显式重启安装 |
| Windows 便携版 | 检查与提示，打开对应 Release 页面，提示可改用安装版 |
| macOS | 签名验证、原子替换、启动健康检查与失败回滚 |
| Linux deb | 检查与提示，打开对应 Release 页面手动下载安装 |

- 启动 10 秒后检查，此后每 6 小时检查，手动检查立即发起。检查时点由客户端决定，不承诺在 GitHub 发版后 60 秒内主动推送。
- 支持应用内更新的安装方式默认手动下载，设置可开启后台下载；下载过程不中断任务。侧栏显示下载进度或“重启以更新”，点击查看 GitHub Release 的 Markdown 说明。
- 立即重启前检查任务、审批、配置修改及已经受理但尚未切换运行状态的操作。存在这些操作时拒绝安装；准备安装后阻止新操作，先保存最新草稿并等待写盘，断开空闲 Pi，再启动安装器。
- 选择“稍后”保留下载，正常退出或系统关机均不安装；仅显式点击“立即重启”才允许安装。
- “设置 → 关于与更新”显示当前版本、安装方式、上次检查时间、检查按钮、自动下载开关、本版说明和新版本说明。离线或校验失败不弹窗，错误和重试入口留在该页，提供手动下载链接。
- 开发模式和设置了 `PI_DESKTOP_DATA_DIR` 的测试模式不请求更新服务。更新状态通过独立 `update` 事件传给界面，不混入 Pi 运行状态。

### 数据与发布

- Windows 安装版和便携版的 `appId`、`productName`、默认数据目录保持一致；切换安装方式沿用原有会话、草稿、设置和审批模式。
- `state.json` 记录最后写入的 `appVersion`。升级首次启动前保存原始 `state.pre-<旧版本>.json`，最多三份；旧文件没有版本信息时使用 `state.pre-unversioned.json`，不猜测来源版本。备份失败则只读打开。
- 降级时，如果仍认识索引格式，可以正常使用；不认识较新格式则只读打开并提示所需版本，不重命名、不覆盖原文件。只读查看也不会尝试保存滚动位置。
- `electron-updater` 由 esbuild 打包进主进程，保留现有文件白名单。更新策略、原生更新器适配、共享状态与界面分别放在独立模块。
- CI 上传安装包、`latest.yml`、`latest-linux.yml` 和 Windows 安装包的 `.blockmap`；发布前验证清单版本、目标文件、大小与 SHA-512，SHA-256 清单覆盖全部发布文件。本地打包保持 `publish: never`。
- `scripts/test-update.ts` 在 Windows/Linux 使用两个真实安装包与回环 HTTP 服务验证校验失败、重试、任务阻止安装、重启安装、退出不安装和数据保留；Windows 另验证便携版切换安装版。测试使用独立应用标识、安装目录及数据，并阻断应用的非本地 HTTP 请求。
- 单元测试覆盖安装方式、稳定版比较、检查间隔、重复请求、安装竞争、备份失败、备份轮转、降级保护和发布清单；界面测试覆盖三类提示模式、进度、失败、设置持久化、审批限制和只读提示。

### 明确边界

不提供 beta 通道、强制更新或应用内回滚。Windows 安装包目前未签名，下载完整性依靠更新清单中的 SHA-512；发布账号仍需妥善保护。macOS 在完成签名前保持手动安装。应用更新不负责安装或升级 Pi CLI。

## v0.10.0：切换会话不再等待，模型错误看得懂（已实现）

本版完成 S1、S2，基于 v0.9.0。验收记录见 [v0.10.0 验收记录](v0.10-validation.md)，后续版本继续独立开发和验收。

### S1 切换会话复用 Pi 进程

**背景与结果。** 原流程调用原生切换后仍关闭并重新启动 Pi。本版把进程监听、会话绑定和启动分开：同一工作目录内复用原进程，切换后重新绑定目标历史、工具输出、模型、推理级别、审批模式、标题与命令列表。

| 情况 | 实际行为 |
| --- | --- |
| 当前进程正常，目标已有会话文件，且工作目录相同 | 原生 `switch_session`，保持 Pi 进程号 |
| 当前进程正常，目标是新会话，且工作目录相同 | 原生 `new_session`，保持 Pi 进程号 |
| 工作目录不同，包括已有会话 | 重新启动 Pi，重新加载项目环境 |
| 没有进程、进程退出、从 Pi 终端返回或运行环境配置改变 | 重新启动 |
| 复用切换失败，或适配扩展未确认目标会话开始 | 重新启动恢复，并记录原因；恢复成功不显示错误条 |
| 扩展明确取消切换 | 保持原会话并提示取消，不重启 |

- `rebindSession()` 统一初始化目标状态，清理旧对话框、队列图片、通知、停止标记和工具输出；历史与能力读取合并，避免重复获取模型列表和完整消息。
- 桌面扩展在 `session_start` 清空“总是允许”，并发出明确的会话开始事件。旧会话退出钩子的编辑操作仍属于旧草稿，新会话启动事件归入目标会话；切换确认框保持可回答。
- 旧的异步刷新不能覆盖目标会话。切换期间不能断开或修改运行环境，避免关闭旧进程后又被恢复流程重新启动。
- 诊断包含最近一次切换方式、后端耗时、重启原因与 Pi 进程号。界面验收单独测量实际点击至目标消息显示，不能用后端耗时代替。

**跨目录验证结论。** 真实 Pi 1.1.0 的原生跨目录切换会改变会话上下文，但 Node 进程的 `process.cwd()` 仍是项目 A；项目 B 扩展按该值注册的命令与冷启动 B 不一致。测试同时验证项目设置和“不信任项目资源”策略。因此按本版约定，跨目录统一重新启动，不修改 Pi 或猜测扩展兼容行为。

**回归。** `test-workflow.ts` 覆盖十次复用、模型与推理级别、旧草稿与目标事件、扩展确认/取消、断开竞争、切换失败恢复和进程退出后的首次切换；`test-session-context.ts` 固定跨目录对比；`test-approval.ts` 验证切走和切回都不继承“总是允许”。`test-session-ui.mjs --packaged` 在 Windows/macOS 发布构建中实际点击十次，要求每次不超过 200 毫秒且进程号不变，结果上传 CI 产物。

### S2 模型请求错误分类与处理入口

错误卡片替换模型请求失败时的原始红色错误条，显示中文原因、处理入口、复制详细信息和可展开的脱敏原文。未知错误直接展开原文，不猜测原因；Pi 安装、进程、存储等错误沿用原有提示。

| 类别 | 主操作 |
| --- | --- |
| 凭据无效或无访问权限 | 管理供应商与登录 |
| 额度不足或欠费 | 显示去当前供应商网站查看余额与账单的说明 |
| 请求过多或服务繁忙 | 重新生成当前失败回复 |
| 上下文过长 | 压缩上下文；未开启自动压缩时提供开启入口 |
| 模型不存在或无权使用 | 打开模型选择面板 |
| 网络或代理错误 | 打开常用设置中的 HTTP 代理 |
| 未识别错误 | 显示并允许复制原文 |

- `shared/errors.ts` 集中分类、说明和脱敏。匹配优先级为凭据、额度、限流、上下文、模型、网络；通用 503 只在没有具体原因时归为繁忙。真实 Pi SDK 的 `Connection error.` 同样归为网络错误。
- 同一会话同类请求连续失败三次起显示失败次数；成功请求清零。Pi 自带重试结束与任务结束不会重复计数；应用不会额外自动重试或切换模型。
- `runtime.errorKind/errorCount` 通过原有增量状态传递；`ModelErrorCard` 独立处理展示，操作复用现有供应商、重新生成、压缩、模型选择与代理设置入口。
- 界面、复制、诊断及重新读取的历史错误文本经过脱敏；不修改 Pi 自己保存的原始 JSONL。诊断额外记录最近五次错误的类别与时间，不在该列表保留原文。
- 单元测试包含 45 条供应商/SDK 格式样本。`test-model-errors.ts` 用真实 Pi 和本地 HTTP 服务验证 401、429、额度、上下文、模型错误、连续计数、成功清零与真实连接拒绝；`test-model-errors-ui.mjs` 验证操作入口、脱敏和界面布局。所有模型请求均使用隔离的本地测试服务。

## v0.11.0：按轮次撤销与精准代码审阅（随 v0.14.0 交付）

T1、T2 已实现。检查点在 Pi 等待的用户消息/工具扩展事件处记录；排队消息不会提前覆盖上一轮基线。轮次序号持续递增，回到历史消息后不复用旧编号。私有 Git 对象与增量清单共用，保留旧版项目基线的读取；实际性能和限制见 v0.14 验收记录。

| 编号 | 内容 | 估算 |
| --- | --- | --- |
| T1 | 每轮检查点，可撤销到任意一轮之前 | 4 人日 |
| T2 | 行范围文件引用与差异片段追问 | 2–3 人日 |

### T1 每轮检查点，可撤销到任意一轮之前

**背景与问题。** 运行快照按项目只保留最近一次（`electron/workspace.ts` 以 `${project.id}.json` 存一份基线，每次发送都会覆盖）。用户发出第二条消息后，第一轮的修改就无法再一键撤销；而实际使用中，往往要过两三轮才发现方向错了。v0.7.0 的 Git 快照让单次快照足够快（1 万文件约 0.4 秒），且内容相同的文件不重复存储，具备保留多轮的条件。

**目标。** 在一个会话中，可以把项目文件恢复到任意一轮开始之前的状态。

**不做。** 不撤销命令产生的外部副作用（数据库、网络请求、已安装的依赖等），界面需明确说明；不提供跨会话的检查点；非 Git 项目仍不支持撤销。

**交互。**

- 每条用户消息的悬停操作中，新增“撤销此轮起的文件修改”（仅项目会话、且该轮有检查点时显示）。
- 点击后先展示将被恢复的文件清单（新增 / 修改 / 删除），并单独标出“该轮之后你手动改过的文件”（检查点之后被修改，但不在 Pi 的工具调用记录中的文件），用户可取消勾选这些文件；确认后执行。
- 撤销完成后提示“已把 N 个文件恢复到第 3 轮之前”，并提供“同时回到这条消息之前的对话”按钮（复用现有“编辑后重新发送”的会话树导航，不自动执行）。
- 工作区“运行期间变更”的下拉框增加“自第 N 轮起”的选项，用于查看跨多轮的累计变更；原“本轮”保持默认。

**技术方案。**

- 存储：基线从“每项目一份”改为“每会话多份”，文件名 `${sessionId}-${turn}.json`，`turn` 为该轮用户消息在会话中的序号，同时记录该消息的时间戳以便界面定位。快照仓库沿用私有 Git 仓库，同一会话的多轮共用一个仓库，以免重复存储。
- 保留策略：每个会话最多 20 轮；全部快照总量上限仍为 200 MiB、保留 7 天；超过时先删除最旧会话的最旧检查点。
- 失效规则：切换 Git 分支后，该会话之前的检查点全部失效（与现在一致）；**提交不再使检查点失效**——恢复后，已提交的修改会以未提交变更的形式出现，确认清单中需注明“包含已提交的内容”。
- 撤销实现：比较当前文件与目标检查点，复用现有 `revert` 的逐文件恢复逻辑（先读取全部原内容再写入，新建文件移到回收站）。
- “手动改过的文件”：目标检查点之后，Pi 的 `edit` / `write` 工具记录及命令执行期间的变更都属于 Pi；其余变化的文件视为手动修改。无法确定时按手动修改处理，默认不勾选。
- 迁移：升级时现有的每项目基线继续作为“本轮”使用，不转换。

**验收标准。**

1. 连续 3 轮分别修改不同文件后，选择撤销第 1 轮起的修改，三轮的改动全部恢复，第 1 轮之前已有的未提交修改保持不变。
2. 第 2 轮后手动修改一个文件，撤销第 1 轮起的修改时，该文件出现在“手动改过”列表中且默认不勾选；不勾选时该文件保持手动修改后的内容。
3. 第 2 轮后执行一次 `git commit`，撤销第 1 轮起的修改仍可用，确认清单注明“包含已提交的内容”；切换分支后检查点显示为不可用并说明原因。
4. 20 轮之后，第 1 轮的检查点自动清理，对应消息不再显示撤销操作。
5. 单个检查点的建立耗时与 v0.7.0 相当（1 万文件仓库不超过 0.5 秒），20 轮检查点的磁盘占用不超过修改内容本身的 2 倍。

**测试。** `tests/snapshot.test.ts` 增加多轮、手动修改识别、提交后恢复、分支切换失效、保留上限；`scripts/test-coding.ts` 增加真实 Pi 三轮修改后撤销的场景。

### T2 行范围文件引用与差异片段追问

**背景与问题。** 目前 `@` 引用（`electron/workspace.ts` 的 `attachmentPrompt`）只能整文件读取，且单文件上限为 256 KiB：超过 256 KiB 的源码文件完全无法引用，未超限的长文件也会整篇注入请求、浪费上下文窗口。同时，工作区右侧“文件”预览（`src/components/Inspector.tsx`）不显示行号，无法圈选某一段代码；在“变更”页点击“继续提问”只往草稿填入一句 `请检查 ${selectedFile} 的这处变更：`，并不附带具体改动位置，对话流内的 `ToolCard` 差异块也没有针对单段改动直接追问的入口。

**目标。** 支持按行范围（`path#L起-L止`）精确引用文件片段，并能从文件预览或任意差异块（`@@` hunk）一键发起带上下文的追问。

**不做。** 不把文件预览做成可编辑的代码编辑器；不做语法树（AST）级符号解析；不放宽单条消息附件总计 1 MiB 的上限。

**交互。**

- **语法输入**：输入框 `@` 搜索选中文件后，允许继续输入 `:10-40` 或 `#L10-L40`（单行 `:15` 归一为 `#L15-L15`）加入附件栏；附件标签显示为 `src/agent.ts#L10-L40`，点击标签可在右侧文件预览定位并高亮对应行。
- **文件预览选行**：右侧“文件”页签的代码预览（`source-preview`）左侧显示行号；点击单行或按住 `Shift` 点击起止行选中范围后，预览工具栏出现“引用 L10–L40”，点击即加入当前会话的附件列表。
- **差异块（Hunk）追问**：右侧“变更”页的统一差异视图与对话流内联 `ToolCard` 的每个 `@@ -a,b +c,d @@` 标题行右侧提供“追问此段”按钮：
  - 若该段包含新文件行（`d > 0`），自动添加 `path#Lc-L(c+d-1)` 到附件，并在草稿末尾追加 `请看 ${path} 第 ${c}–${c+d-1} 行的改动：`（草稿已有内容时换行追加，不覆盖）；
  - 若该段为纯删除（`d === 0`），将删除行以 Markdown `diff` 代码块追加到草稿，并聚焦输入框。

**技术方案。**

- 标识格式：复用现有 `Session.attachments: string[]`，元素支持 `"path"` 或 `"path#L10-L40"`，无需升级 `state.json` 的索引版本。
- 主进程读取（`electron/workspace.ts`）：新增 `parseAttachmentSpec(spec: string): { path: string; startLine?: number; endLine?: number }`。带行范围时，允许读取最大 5 MiB 的普通文本文件（仍执行 `safePath` 与 `sensitive` 校验），按 LF / CRLF 切分并截取闭区间 `[startLine, endLine]`（越界时截断到文件实际末行；`startLine > 文件总行数` 时报错提示）。截取后的片段仍须 ≤ 256 KiB，且带行号拼入 `<project_file path="src/agent.ts" lines="10-40">`。
- 消息展示（`src/components/conversation/Markdown.tsx`）：`UserMessage` 解析 `<project_file>` 的可选 `lines` 属性，折叠标题展示为 `src/agent.ts (L10–L40)`。

**验收标准。**

1. 输入 `@src/workspace.ts:10-30` 回车补全或发送，实际发给模型的 `<project_file>` 仅包含第 10 至 30 行且标注 `lines="10-30"`。
2. 对一个 1.5 MiB 的项目内文本文件，整文件引用被拒并提示可指定行范围；引用 `#L1-L100` 成功发送。
3. 在右侧“文件”页签按住 `Shift` 选中第 5 至 20 行并点击“引用 L5–L20”，附件栏出现 `path#L5-L20`；草稿随会话切换与重启保留。
4. 在“变更”页和 `ToolCard` 点击某 `@@` 块的“追问此段”，输入框获得焦点且附件与草稿按规则填入，已有草稿文字不丢失。

**测试。** `tests/core.test.ts` 增加行范围解析、越界、大文件切片与凭据拦截测试；`scripts/test-coding-ui.mjs` 增加选行引用与差异块追问的界面回归。

## v0.12.0：细粒度审批、会话内查找与工作区实时感知（随 v0.14.0 交付）

W1、W2、W3 已实现：审批使用结构化临时授权；会话搜索覆盖全部历史和完整工具结果；选中项目使用文件事件刷新，后台空闲窗口不启动定时 Git 扫描。测试入口和性能记录见 v0.14 验收记录。

| 编号 | 内容 | 估算 |
| --- | --- | --- |
| W1 | 审批规则细化：命令前缀放行、项目内写入授权与已授权管理 | 2–3 人日 |
| W2 | 会话内全文查找与工具输出筛选 | 2 人日 |
| W3 | 工作区文件外部变更实时感知与按需刷新 | 2 人日 |

### W1 审批规则细化：命令前缀放行、项目内写入授权与已授权管理

> 安全修订（2026-10-24）：下列前缀放行方案保留为历史记录，已由完整命令匹配取代。修改参数必须重新审批，旧前缀授权不再生效；项目写入授权排除 Git/Pi 执行配置。读取路径与未信任项目的 Git 边界以 [architecture.md](architecture.md) 为准。

**背景与问题。** v0.7.0 的“确认修改”模式（`shared/approval.ts`、`electron/pi-bridge.ts`）在实际编程中存在两头不便：一是命令类的“本会话总是允许”按**完整命令文本**精确匹配（`alwaysKey` 为 `${toolName}\0${summary}`），Pi 依次执行 `npm test tests/a.test.ts` 和 `npm test tests/b.test.ts` 时每次都要重新点确认，用户容易因频繁弹窗而切回“全自动”；二是文件写入（`edit` / `write`）点击“本会话总是允许”后按工具名放行，不区分目标路径是否在项目内；三是会话内点过的“总是允许”没有地方查看或单条撤回，只能切出“确认修改”模式重来。

**目标。** 让“确认修改”模式真正适合全程开着写代码：单条安全命令可按前缀放行，文件写入放行限定在项目目录内，且随时可查看和撤回本会话已放行的规则。

**不做。** 不做跨会话永久保存的命令白名单（避免旧规则被遗忘带来隐患）；不对包含管道、重定向、命令串联或子 Shell 的复合命令开放前缀放行；不替代操作系统沙箱。

**规则与界面。**

| 请求类型 | 条件 | 确认卡片提供的放行选项 |
| --- | --- | --- |
| `bash` / `powershell` | 单条简单命令（不含 `&&`、`\|\|`、`;`、`\|`、`>`、`<`、`` ` ``、`$()`、`&` 及多行换行） | **允许一次** / **本会话允许 `<前缀>` 开头**（提取前 1–2 个命令词，如 `npm test`、`git diff`、`pytest`） / **拒绝…** |
| `bash` / `powershell` | 含上述连接符、重定向或换行的复合命令 | **允许一次** / **本会话总是允许此完整命令** / **拒绝…** |
| `edit` / `write` | 目标路径解析后位于当前项目根目录内，且非 `sensitive()` 凭据文件 | **允许一次** / **本会话允许修改项目内文件** / **拒绝…** |
| `edit` / `write` | 目标路径在项目外、包含符号链接越界或命中 `sensitive()` | 卡片头部标红提示“项目外路径”或“敏感文件”；仅提供 **允许一次** / **拒绝…**（不提供总是允许） |
| 其他外部工具（MCP 等） | 任意 | 保持现有行为：**允许一次** / **本会话总是允许 `<toolName>`** / **拒绝…** |

- 输入框左下角的 `ApprovalSwitch` 菜单在“确认修改”模式下，若当前会话已有生效的放行规则，底部展示“本会话已放行（N）”列表（如 `命令前缀：npm test`、`项目内修改：edit / write`），每项右侧可点 `×` 单独撤回，或点“全部清空”。

**技术方案。**

- `shared/approval.ts`：新增纯函数 `commandPrefix(cmd: string): string | null`（校验不含复合语法并提取规范化前缀，如 `npm run <script>`、`npm test`、`git <subcmd>`、`cargo <subcmd>` 等）与 `classifyWriteTarget(cwd: string, targetPath: string): 'project' | 'outside' | 'sensitive'`。
- `electron/pi-bridge.ts`：将 `alwaysAllowed` 从 `Set<string>` 升级为结构化规则列表 `ApprovalGrant[]`；每次判定时，复合命令绝不匹配前缀规则，项目外或敏感文件绝不匹配 `write:project` 规则。
- 桥接协议增加 `revoke_approval`（移除单条或清空全部），并在 `Runtime` 新增标量/轻量字段 `approvalGrants: ApprovalGrant[]` 供界面展示。切换会话或退出“确认修改”模式时依然自动清空。

**验收标准。**

1. 在“确认修改”模式下，Pi 请求执行 `npm test tests/a.test.ts`，点击“本会话允许 `npm test` 开头”后，后续 `npm test tests/b.test.ts` 自动放行，而 `npm test && rm -rf build` 或 `npm publish` 仍会弹出确认卡片。
2. Pi 请求修改项目内的 `src/index.ts`，点击“本会话允许修改项目内文件”后，修改项目内其他普通文件自动放行；但若尝试修改 `../outside.txt` 或 `.env`，仍会拦截并显示警告标识，且无“总是允许”按钮。
3. 在审批菜单中移除某条已放行规则后，下一次同类工具调用重新弹出确认卡片。

**测试。** `tests/core.test.ts` 覆盖至少 25 种 Shell 串联/注入变形（管道、反引号、`$()`、换行、引号转义）及路径边界；`scripts/test-approval.ts` 与 `scripts/test-approval-ui.mjs` 增加前缀放行、敏感文件拦截与规则撤回测试。

### W2 会话内全文查找与工具输出筛选

**背景与问题。** `Ctrl+K` 用于跨会话切换，但进入一个有上百条消息的长会话后，没有会话内查找（`Ctrl+F`）。由于对话流默认只渲染最后 80 条消息（`src/components/Conversation.tsx` 的 `visibleMessages`），且思考过程（`thinking`）与完成的工具卡片默认折叠，用户很难在当前会话里找回之前的某段讨论、报错文本或修改过的文件名。此外，右侧工作区“输出”页签在执行过数十次命令后，无法快速筛选失败命令或按关键词过滤输出。

**目标。** 提供 `Ctrl+F`（macOS `⌘F`）会话内查找，覆盖当前会话全部已加载历史（含未渲染的早期分页和折叠块），并在工作区“输出”页签支持按状态和关键词筛选。

**不做。** 不替代 `Ctrl+K` 全局搜索；不做正则表达式替换；不在磁盘上检索其他会话。

**交互。**

- **会话内查找栏**：在主窗口按 `Ctrl+F` / `⌘F`（或命令菜单 `/find`）在对话区顶部右侧展开查找栏：输入框、命中计数（如 `2 / 9`）、上一个（`Shift+Enter` / `↑`）、下一个（`Enter` / `↓`）、关闭（`Esc`）。
- **跨分页与自动展开**：检索在内存中的完整 `messages` 与 `runtime.tools` 上进行（匹配用户提问、Pi 回复、思考过程、工具名称/目标路径/输出）。当跳转到早于当前 `visibleMessages` 的消息时，自动将 `messageLimit` 扩大到包含该消息的 80 条分块；若命中内容位于折叠的“思考过程”、`<project_file>` 引用块或 `ToolCard` 内，自动展开该块并滚动居中高亮。
- **工作区“输出”页筛选**：右侧 `Inspector` 的“输出”页签顶部增加关键词输入框和“只看失败（N）”切换按钮，实时过滤工具输出列表；导出工具输出仍导出完整记录。

**技术方案。**

- 新建纯函数 `src/lib/session-search.ts`：输入 `messages`、`tools` 与查询词，返回有序命中项 `{ messageIndex?: number; toolId?: string; section: 'text' | 'thinking' | 'attachment' | 'tool'; snippet: string }[]`。
- `Conversation.tsx` 与 `ChatMessage.tsx`：只在存在当前活动命中项（`activeMatch`）的单个消息或工具卡片上传递高亮与自动展开属性，其余消息组件的 `memo` 属性保持不变，避免输入搜索词时触发整棵消息列表重渲染。

**验收标准。**

1. 在包含 200 条消息（默认仅渲染最后 80 条）的会话中按 `Ctrl+F` 搜索第 10 条消息中的词，能准确显示总命中数，按 `Enter` 自动加载早期消息并滚动定位到第 10 条。
2. 搜索仅出现在折叠的 `ToolCard` 输出或 `thinking` 中的报错词，跳转时对应折叠块自动展开。
3. 在 500 条消息基准下输入搜索词，单次检索与高亮切换耗时不超过 16 毫秒，未命中的历史消息组件不发生重复渲染。
4. 右侧“输出”页签开启“只看失败”或输入关键词后，只展示匹配的工具输出。

**测试。** `tests/core.test.ts` 测试跨消息类型检索与索引计算；`scripts/test-experience-ui.mjs` 增加 `Ctrl+F` 跨分页跳转、折叠展开及输出页筛选的 UI 测试。

### W3 工作区文件外部变更实时感知与按需刷新

**背景与问题。** 目前工作区变更列表依赖 `src/hooks/useWorkbench.ts` 的固定定时器（运行中每 2.5 秒、空闲每 7 秒）调用 `changes` IPC，每次都会连续派生多个 `git` 子进程（`rev-parse`、`status`）。窗口空闲放着时每分钟也在后台跑近十次 `git`；反过来，用户在外部编辑器保存文件、暂存代码或切换分支后，回到窗口最多要等 7 秒才能看到更新。同时，当用户正打开右侧“文件”或“变更”预览某个文件时，外部修改了该文件后预览内容不会提示更新（首版 PRD 第 7 节表格中“外部继续编辑：提示文件已更新，刷新前保留当前阅读位置”尚未实现）。

**目标。** 用主进程按需文件监听替代高频盲目轮询：外部改文件或切分支后 500 毫秒内界面感知，窗口空闲无变化时不反复启动 `git` 进程，且正在预览的文件发生外部修改时给出刷新提示并保留阅读位置。

**不做。** 不在文件更新时自动打断用户正在阅读的差异或重置滚动条；不监听项目以外的目录。

**交互与技术方案。**

- **主进程监听（`electron/workspace.ts`）**：当选中项目会话时，对项目根目录及 `.git/HEAD`、`.git/index`、`.git/refs` 建立防抖监听（300 毫秒合并，排除 `excluded` 中的 `node_modules`、`dist`、`.git/objects` 等目录；监听失败或不支持递归监听的挂载盘自动退化为低频轮询）。
- **事件推送**：检测到工作区或 Git 状态变化时，向渲染进程发送 `{ type: 'workspaceChanged', projectId: string, changedPaths?: string[] }` 事件（加入 `shared/types.ts` 的 `AppEvent`）。
- **渲染进程降频与预览提示（`src/hooks/useWorkbench.ts`、`src/components/Inspector.tsx`）**：
  - 收到当前项目的 `workspaceChanged` 或窗口重新获得焦点（`focus`）时立即刷新 `changes`；原先的 7 秒空闲轮询延长至 60 秒作为兜底，且窗口未聚焦（`document.hidden` 或失焦）且未运行时暂停轮询。
  - 若用户正在右侧预览 `selectedFile`（“文件”或“变更”页），而新的变更扫描或文件 `mtime`/`blob` 表明该文件已与当前预览内容不一致，在预览框顶部显示提示条“文件已在外部更新”与“刷新”按钮；点击“刷新”重新读取并保持 `pre` 容器原本的 `scrollTop`。

**验收标准。**

1. 窗口空闲且项目无文件变化时，60 秒内主进程派生的 `git status` 次数不超过 1 次；窗口最小化或失焦且无运行任务时为 0 次。
2. 在外部修改项目文件或执行 `git checkout -b`，500 毫秒内顶栏分支名与右侧变更计数自动更新。
3. 右侧正在预览 `src/a.ts` 并滚动到中部时，外部修改 `src/a.ts`，预览顶部出现“文件已在外部更新 · 刷新”，未点击前原文和滚动位置不变；点击刷新后更新内容并保留滚动位置。

**测试。** `tests/snapshot.test.ts` 或 `tests/workspace.test.ts` 验证监听防抖、忽略目录过滤与退化策略；`scripts/test-coding-ui.mjs` 验证外部改文件后的预览更新提示与滚动位置保留。

## v0.13.0：桌面界面与交互体验打磨（随 v0.14.0 交付）

UI1–UI5 已实现，沿用浅色墨绿 `#1F6B52` / 深色 `#74C7A3`、运行态琥珀色 `#B4730F` / `#E9B45E`。分隔条、搜索、输入片段、范围引用及图片交互由新增的 v0.14 界面用例验证；长会话性能与 v0.8 使用同一脚本比较。

| 编号 | 内容 | 估算 |
| --- | --- | --- |
| UI1 | 面板边缘直接拖拽缩放、预览区最大化与全键盘面板切换 | 2 人日 |
| UI2 | 侧栏项目独立展开/收起、状态聚合徽标与文件树快速过滤 | 2 人日 |
| UI3 | 连续只读工具折叠组与对话轮次快速目录（Turn Outline） | 2–3 人日 |
| UI4 | 代码块头部栏与语法着色、行内字符级 Diff、对照同步滚动与 ANSI 输出净化 | 2–3 人日 |
| UI5 | 输入框交互完善：`@` 文件键盘导航、长文本粘贴转芯片、容量预估与图片灯箱 | 2 人日 |

### UI1 面板边缘直接拖拽缩放、预览区最大化与全键盘面板切换

**背景与问题。** 目前调整左栏宽度（`sidebarWidth`）与右栏宽度（`inspectorWidth`）必须打开“设置 → 外观与编辑器”拖动滑块（`src/components/SettingsModal.tsx`），弹窗遮挡了工作区，无法边看效果边调。同时，右侧 `Inspector` 上半部列表（`src/styles/inspector.css` 中 `.change-list` 固定 `max-height: 40%`、`.file-tree-scroll` 固定 `45%`）与下半部代码预览高度比例写死，查看大文件或长 Diff 时预览区域局促。此外，左栏有 `Ctrl+B` 快捷键，而右侧工作区面板及其三个页签没有键盘直达快捷键。

**目标。** 所有分栏边界支持在主界面直接拖拽与双击复位，代码预览支持一键最大化，右侧工作区面板可全程键盘开合与切页。

**不做。** 不做任意浮动停靠（Docking）多窗口系统；窄窗口（`< 900 px`）抽屉模式下禁用宽度拖拽。

**交互与技术方案。**

- **分栏拖拽手柄（Resize Sash）**：
  - 在左栏右边缘（`180–360 px`）、右栏左边缘（`300–720 px`），以及右栏内部“变更/文件列表与下部预览区之间”（上方列表高度占比 `15%–70%`）放置 4 px 宽的拖拽分隔条（`role="separator"`，悬停 150 ms 后浮现墨绿细线，支持键盘 `←`/`→` 或 `↑`/`↓` 每次调整 10 px）。
  - 拖动过程直接更新 CSS 变量（`--sidebar-width`、`--inspector-width`、`--inspector-split`），松手（`pointerup`）后持久化到 `Settings`；双击分隔条恢复默认宽度（240 px / 380 px / 40%）。设置页的原滑块保留并双向同步。
- **预览区最大化切换**：右侧 `preview-toolbar` 新增“最大化预览 / 恢复列表”图标按钮（快捷键双击 `preview-toolbar` 空白处同效），开启后临时收起上方文件树或变更列表，让代码/差异占满整个右栏高度，顶部显示“返回列表（共 N 项）”切换条。
- **工作区键盘快捷键**：新增 `Ctrl+J`（macOS `⌘J`）切换右侧工作区面板开合，面板打开时 `Alt+1` / `Alt+2` / `Alt+3` 分别切换到“变更 / 文件 / 输出”页签，并同步写入 `src/hooks/useShortcuts.ts` 与 `src/components/ShortcutsHelp.tsx`。

**验收标准。**

1. 鼠标拖动左右分栏及右栏上下分隔线时跟手无卡顿（60 fps），双击分隔线复位，重启应用后保持上次拖动的尺寸。
2. 点击预览工具栏“最大化预览”，上方列表收起、预览区占满右栏；切换文件或再次点击可恢复列表。
3. 按 `Ctrl+J` 与 `Alt+1/2/3` 能开合右栏并切换页签，`Ctrl+/` 快捷键速查面板展示新增项。

**测试。** `scripts/test-experience-ui.mjs` 增加拖拽分栏持久化、双击复位、预览最大化与快捷键切页测试。

### UI2 侧栏项目独立展开/收起、状态聚合徽标与文件树快速过滤

**背景与问题。** 当前侧栏（`src/components/Sidebar.tsx`）仅当 `p.id === project?.id` 时才渲染该项目下的会话列表，且 `src/styles/shell.css` 隐藏了项目行的折叠箭头（`.project-row > svg:last-child { display: none }`）。这带来两个明显问题：一是用户处于“独立对话”或项目 A 时，想看一眼项目 B 有哪些历史会话，点击项目 B 会直接打断当前视图并切换到项目 B 的首个会话；二是当其他项目有会话正在后台执行、等待工具审批或刚执行完成（未读）时，因项目处于收起状态，用户完全看不到那些会话行上的状态图标。此外，右侧“文件”页签（`src/components/FileTree.tsx`）只能逐层点击展开文件夹，没有顶部快速过滤和未提交状态标识。

**目标。** 解耦“展开项目目录”与“切换当前会话”，在收起的项目行上聚合展示内部会话状态，并为右侧文件树提供即时过滤与变更标记。

**不做。** 不改变“同一时间只运行一个会话”的规则；不在侧栏直接展示项目文件树。

**交互与技术方案。**

- **项目列表独立展开/折叠**：
  - 恢复项目行右侧 `ChevronDown` 图标并随展开状态旋转；点击项目行只切换该项目的展开/收起状态（默认展开当前选中项目，支持同时展开多个项目，展开集合保存在 `localStorage`），不再强制切换活动会话；项目下没有会话时显示“新建项目会话”入口。
- **项目行状态聚合徽标**：
  - 当某个项目处于**收起**状态时，项目行右侧自动汇总其名下会话的最高优状态：存在待审批/待回复对话框时显示琥珀色计数胶囊（如 `待确认`），正在执行时显示琥珀色旋转图标，有未读完成会话时显示墨绿圆点（`.unread`）。
- **右侧文件树过滤与变更指示（`src/components/FileTree.tsx`、`src/components/Inspector.tsx`）**：
  - 右侧“文件”页签顶部增加紧凑过滤框（复用现有 `searchFiles` IPC，输入时切换为匹配的扁平文件列表，清空后回到目录树）与“定位当前预览文件”按钮（自动展开父目录并滚动到 `selectedFile`）。
  - 文件树中的文件若存在于当前 `changes.files` 中，同行右侧显示对应的 `+`（新增）/ `M`（修改）微标。

**验收标准。**

1. 在独立对话中点击侧栏的项目 A，仅展开项目 A 的会话列表，主对话区仍保持在当前独立对话；点击项目 A 下的具体会话才切换过去。
2. 项目 A 的会话在后台运行或产生未读标记时，收起项目 A 后，项目 A 标题行右侧仍显示运行图标或未读圆点。
3. 在右侧“文件”页签顶部输入文件名片段，150 毫秒内展示匹配文件列表；有未提交修改的文件在文件树中带有状态标记。

**测试。** `scripts/test-experience-ui.mjs` 与 `scripts/test-coding-ui.mjs` 增加多项目独立展开、收起态徽标汇总与文件树过滤回归测试。

### UI3 连续只读工具折叠组与对话轮次快速目录（Turn Outline）

**背景与问题。** Pi 在理解项目或排查问题时，常在一轮回复中连续调用 10–30 次 `read`、`grep`、`find`、`ls` 工具。目前每条工具结果都作为独立 `<ToolCard>` 纵向排列（`src/components/Conversation.tsx`），导致一轮探索动辄占满三四屏高度，把用户的提问和 Pi 的文字结论冲散。同时，在几十轮的长会话中，用户想快速跳回之前的某轮提问或查看哪几轮改了代码，只能靠滚轮盲翻，或者打开模态弹窗“Pi 功能 → 会话树”。

**目标。** 自动收拢连续的只读探索过程以保持对话主线清晰，并在对话区右侧提供非模态的轮次快速跳转目录。

**不做。** 绝不隐藏或自动折叠任何产生修改（`edit`、`write`）、执行命令（`bash`、`powershell`）、正在运行（`running`）或失败（`error`）的工具卡片；不改动底层 `messages` 存储结构。

**交互与技术方案。**

- **连续只读工具折叠组（`ToolGroupCard`）**：
  - 在渲染层（`Conversation.tsx`）对同一轮助手回复内**连续 3 个及以上、状态均为 `done` 且无报错**的只读工具（`read`、`grep`、`find`、`ls`、`tool_search`）进行视觉分组，默认收拢为单行时间线摘要卡：`已探索 N 项（读取 X 个文件 · 搜索 Y 次）· 合计 1.2s`。
  - 点击摘要卡可原地展开查看组内每张独立的 `ToolCard`，展开状态记入会话视图；只要组内有任一工具仍在运行、失败或被用户单独展开，该项保持可见。
- **对话边缘轮次导航刻度（Turn Outline）**：
  - 当会话达到 3 轮及以上时，在对话滚动区（`.thread`）右侧边缘显示一列紧凑刻度线：每个刻度对应一轮用户提问，普通轮次为灰色短线，包含文件修改（`edit`/`write`）的轮次为墨绿短线，包含失败工具或错误的轮次为红色短线，当前视口所在轮次加长高亮。
  - 鼠标移入刻度区时浮出轻量化目录浮层（显示 `#轮次`、用户提问前 36 字、该轮 `+增/−删` 汇总），点击任一轮次即平滑滚动定位（若该轮尚未加载进 `visibleMessages`，自动扩大 `messageLimit` 后定位）。

**验收标准。**

1. 连续 5 次成功的 `read` / `grep` 调用在界面上合并为 1 行摘要卡，点击可展开全部 5 张卡片；中间若夹杂 1 次 `edit`、`bash` 或失败的 `read`，则修改/命令/失败卡片独立显示，不被吞入折叠组。
2. 在 10 轮以上的会话中，右侧刻度条准确标出含代码修改的轮次；点击第 2 轮刻度能直接滚动到第 2 轮用户提问顶部。

**测试。** `tests/core.test.ts` 验证工具分组纯函数（覆盖只读、穿插写入、运行中、失败等组合）；`scripts/test-chat-ui.mjs` 验证折叠组展开与轮次刻度跳转。

### UI4 代码块头部栏与语法着色、行内字符级 Diff、对照同步滚动与 ANSI 输出净化

**背景与问题。** 当前代码与输出展示存在四处视觉短板：
1. 对话流代码块（`src/components/conversation/Markdown.tsx` 的 `CodeBlock`）只有右上角悬浮的“复制”按钮，不显示语言名称与行数，不支持自动换行切换，也没有基础语法高亮，且点击复制后无状态反馈；
2. 统一差异视图（`Inspector.tsx` 与 `ToolCard.tsx`）只有整行红绿底色，当一行 120 字符的代码只改了一个参数名时，肉眼很难找出改动点；
3. 左右对照差异（`split-diff`）只是放了两个独立的 `<pre>`（`fileDiff.before` 与 `fileDiff.after`），双栏滚动互不同步，且直接展示全文而非对齐改动位置；
4. 命令输出（`ToolCard` 与“输出”页）原样渲染 `tool.output`，测试框架或 CLI 输出的 ANSI 颜色与控制码（如 `\x1b[32m`、`\x1b[2K`）会直接显示为乱码符号。

**目标。** 全面提升代码块、Diff 审阅与终端输出的可读性，达到桌面开发工具应有的视觉水准。

**不做。** 不引入体积庞大或阻塞渲染的重型编辑器内核（如完整 Monaco）；保留 Markdown 与消息组件的流式渲染性能（500 条消息更新耗时仍须符合 R2 基准）。

**交互与技术方案。**

- **代码块头部栏与语法着色（`Markdown.tsx`）**：
  - `CodeBlock` 顶部增加 28 px 高的头部栏：左侧显示语言标识（从 `language-*` 提取，无标注时显示 `文本`）与行数；右侧提供“自动换行”开关与“复制”按钮（点击后图标变为 `Check` 并显示 `已复制` 持续 1.5 秒）。
  - 对常见代码块（TS/JS、JSON、Bash/PowerShell、Python、Rust、Go、HTML/CSS、Diff、Markdown）采用轻量词法分词器生成语义类名（关键字、字符串、注释、数字、函数名），通过 CSS 变量适配浅色与深色主题；流式输出中的未闭合代码块按纯文本或增量分词渲染，完成后缓存结果。
- **行内字符级 Diff 与左右同步对照（`Inspector.tsx`、`ToolCard.tsx`）**：
  - 对相邻的删除行（`-`）与新增行（`+`）使用现有的 `diff` 库（`diffWordsWithSpace` / `diffChars`）计算行内变化片段，以加深底色（`--diff-word-add` / `--diff-word-del`）高亮具体改动的词或字符。
  - 左右对照模式（`split-diff`）按 Hunk 对齐左右行号（新增侧或删除侧缺失处填充空白占位行），左右容器绑定同步纵向滚动（`scrollTop` 联动），并在预览工具栏支持切换“仅看改动上下文 / 展开完整文件”。
- **命令输出 ANSI 净化与基础着色**：
  - 新增纯函数 `src/lib/ansi.ts`：剥离光标控制、清屏、标题设置等非文本 CSI/OSC 序列（消除 `\x1b[2K`、`\x1b[1G` 等乱码），处理 `\r` 同行覆盖（如进度条输出），并将标准前景色（红、绿、黄/琥珀、蓝、灰）与粗体解析为安全的受控 `<span>` 片段；点击“复制输出”或“导出输出”时自动提供去除转义码的干净文本。

**验收标准。**

1. 含语言标记的 Markdown 代码块显示语言名、行数、换行切换及语法着色；点击复制后按钮显示 `已复制` 反馈。
2. 单行局部修改的 Diff 能清晰高亮行内具体增删字符；左右对照视图滚动左侧时右侧同步对齐滚动。
3. 含 `\x1b[32mPASS\x1b[0m` 与 `\r` 进度条刷新的命令输出在 `ToolCard` 和“输出”页无乱码字符，颜色正确，复制出的文本不含 `\x1b`。
4. 运行 `scripts/perf-ui.mjs`，500 条消息与 100 个工具卡片的中位更新耗时相比 v0.8.0 回归不超过 2 毫秒。

**测试。** `tests/core.test.ts` 测试 ANSI 净化/进度条覆写与行内 Diff 计算；`scripts/test-chat-ui.mjs` 与 `scripts/test-coding-ui.mjs` 验证代码块头部、行内高亮与对照同步滚动。

### UI5 输入框交互完善：`@` 文件键盘导航、长文本粘贴转芯片、容量预估与图片灯箱

**背景与问题。** 输入框（`src/components/Composer.tsx`、`src/hooks/useDraft.ts`）在高频使用中存在四处交互断点：
1. 输入 `/` 调出命令菜单时支持 `↑`/`↓` 选择，但输入 `@` 调出文件候选框（`.file-picker`）时**不支持 `↑`/`↓` 键盘上下选择**，只能按回车选第一项或改用鼠标点击；
2. 用户把几十上百行的报错堆栈、日志或代码片段粘贴进输入框时，`textarea`（最高 `20vh`）被瞬间撑满，既遮挡视线又难以在前后继续编写提问；
3. 添加多个 `@` 引用文件或长文本后，界面没有展示各附件大小及距离 1 MiB 上限的占比，直到点击发送才报错拦截；
4. 点击消息或草稿中的图片（`MessageImages`）只是在消息流内切换 `.expanded-image` 取消高度限制，缺乏独立灯箱，无法缩放看清大图细节或一键复制图片。

**目标。** 补齐 `@` 文件选择的完整键盘流，让长文本粘贴与多文件引用保持清爽可控，并提供完整的图片灯箱检视体验。

**不做。** 不把输入框改成富文本编辑器；不突破单条消息 1 MiB 文本、8 张图片（合计 16 MiB）的协议上限。

**交互与技术方案。**

- **`@` 文件选择器键盘导航与路径高亮（`Composer.tsx`、`useDraft.ts`）**：
  - 新增 `fileIndex` 状态：当 `.file-picker` 打开时，`↑`/`↓` 在候选文件间循环移动高亮（`role="option"`，`aria-selected` 自动滚入视口），`Tab` 或 `Enter` 选中当前高亮项加入附件，`Esc` 关闭候选框；候选文件名中高亮匹配 `fileQuery` 的字符片段。
- **长文本粘贴折叠为片段芯片**：
  - 在 `Composer.tsx` 的 `onPaste` 中，若粘贴的纯文本超过 30 行或 4 KiB（且当前并非在编辑 `/` 命令），自动将其收拢为附件栏中的一枚“粘贴片段 · N 行（X KiB）”胶囊，光标留在原输入框供用户继续写指令；胶囊悬停或点击可预览全文、点击“展开到输入框”可还原为普通正文，发送时按原顺序拼入消息。
  - 输入框顶部边缘增加轻量拖拽热区，允许用户在需要手写长段提示词时手动拉高输入框上限（`20vh–55vh`）。
- **附件体积提示与容量预警**：
  - 每个 `@` 文件胶囊和粘贴片段胶囊悬停显示具体大小（KiB）与行数；
  - 当草稿正文与全部文本附件合计超过 512 KiB（上限 1 MiB 的 50%）时，输入框工具栏右侧显示 `已用 X KiB / 1 MiB` 计数，达到 850 KiB 时转为琥珀色，超过 1 MiB 时转为红色并提示移除或改用 `T2` 行范围引用。
- **图片灯箱检视（`Lightbox`）**：
  - 点击草稿区的预览图或历史消息中的 `MessageImages` / `MarkdownImage`，打开全窗口居中灯箱遮罩（`role="dialog"`）：支持滚轮缩放（`50%–400%`）、双击切换适应窗口与 `1:1` 原始像素、鼠标拖拽平移、“复制图片”按钮，以及 `←`/`→` 在同条消息的多张图片间切换、`Esc` 或点击背景关闭。

**验收标准。**

1. 输入 `@` 后用 `↓` 切到第 3 个候选文件并按 `Tab` 或 `Enter`，准确引用第 3 个文件并关闭候选框。
2. 粘贴一段 60 行的报错日志，自动生成“粘贴片段 · 60 行”胶囊，输入框保持单行高度可继续输入；点击胶囊可预览或还原回正文，发送后模型收到完整内容。
3. 附件累计超过 512 KiB 时工具栏显示容量提示，超 1 MiB 时明确标出占用最大的附件。
4. 点击消息中的图片打开灯箱，支持缩放、切换上下张与 `Esc` 关闭。

**测试。** `scripts/test-chat-ui.mjs` 与 `scripts/test-experience-ui.mjs` 增加 `@` 键盘选文件、长文本粘贴转芯片、容量提示及图片灯箱交互测试。

## v0.14.0：工程化验证闭环、模板交互与会话成本治理（已实现）

本版完成 E1、E2、E3、E4，并与 v0.11–v0.13 合并发布。模板继续使用 Pi 原生文件；费用读取实际 Pi usage 并缓存到桌面 `state.json` 的 `Session.stats`。日期筛选按会话最后活动时间选择整份会话，因此不是服务商逐日账单。

- **`E1`**：项目规则卡片（`AGENTS.md` 感知与快速初始化）与验证命令一键重跑
- **`E2`**：提示词模板（Prompt Templates）参数化填空与可视新建
- **`E3`**：上下文水位预警、本地费用统计与冷会话自动收纳
- **`E4`**：设置与 Pi 功能中的 Skills 及资源展示优化

### E1 项目规则卡片（`AGENTS.md` 感知与初始化）与验证命令一键重跑

**现状与问题。**

1. Pi 原生支持读取项目根目录下的 `AGENTS.md`（或 `.pi/SYSTEM.md`）作为项目级常驻指令，但桌面端在接入新项目后没有任何状态提示或引导，用户不知道可以把项目的构建、测试命令与目录规范固化下来，导致每次新开会话都要重复交代背景；
2. 开发者在 Pi 执行完测试或构建命令（如 `npm test`）报错后，常在外部编辑器微调一两行代码，随后需要重跑刚才那条命令验证。目前只能往上翻找历史工具卡片、手动复制命令，再回到底部输入框手敲 `!!<command>` 或 `!<command>`。

**目标。** 让新项目的规则配置显性化、可一键初始化；让“AI 改码 → 人工微调 → 重跑验证命令”形成一键闭环。

**不做。** 不自动后台静默修改用户的 `AGENTS.md`；不内置自动循环跑测试直到通过的无人值守守护任务；不为生成 Commit Message 单独增加隐性消耗 Token 的后台模型调用（此类场景统一由 `E2` 提示词模板承接）。

**交互与技术方案。**

- **项目规则（`AGENTS.md`）状态卡片与快速初始化（`electron/workspace.ts`、`Inspector.tsx`）**：
  - `projectSnapshot` 扫描时顺带检测项目根目录是否存在 `AGENTS.md` 或 `.pi/SYSTEM.md`，在 `ProjectSnapshot` 中返回 `agentRulesFile?: { relativePath: string; size: number }`；
  - 在右侧检查面板“文件”页顶部展示项目规则栏：
    - **已存在时**：显示 `项目规则：AGENTS.md`，点击直接在预览区打开该文件，右侧提供“用默认编辑器打开”按钮；
    - **未配置时**：显示轻量提示卡片 `尚未配置 AGENTS.md（可固定构建/测试命令与代码规范）`，提供 **“生成模板草稿”** 按钮（主进程根据根目录是否存在 `package.json`、`Cargo.toml`、`pyproject.toml`、`go.mod` 生成带常用脚本注释的基础 `AGENTS.md` 并打开预览与外部编辑器）。
- **验证命令一键重跑（`ToolCard.tsx`、`Inspector.tsx`）**：
  - 在对话流的 `bash` 工具卡片标题栏，以及右侧检查面板“输出”页签的每条历史命令旁，当会话处于空闲（`status !== 'running'`）且不处于 `readonly` 审批模式时，提供两个快捷动作按钮：
    - **“本地重跑（不发给模型）”**：等价于发送 `!!<command>`，直接在本地执行并更新输出面板，不消耗模型上下文；
    - **“重跑并发给 Pi”**：等价于发送 `!<command>`，将最新执行结果作为上下文交给 Pi 继续排查。

**验收标准。**

1. 导入未含 `AGENTS.md` 的 Node.js 项目，右侧“文件”页顶部显示未配置提示；点击“生成模板草稿”后自动提取 `package.json` 的 `scripts` 生成 `AGENTS.md` 并在预览区打开。
2. 对话流中 `bash` 工具执行完毕后，点击卡片上的“本地重跑（不发给模型）”，立即以 `!!` 方式重跑该命令并在“输出”页展示最新结果；点击“重跑并发给 Pi”则将结果送入下一轮模型上下文。

**测试。** `tests/workspace.test.ts` 覆盖 `AGENTS.md` 检测与模板生成；`scripts/test-experience-ui.mjs` 增加 `AGENTS.md` 卡片与命令一键重跑交互测试。

---

### E2 提示词模板（Prompt Templates）参数化填空与可视新建

**现状与问题。**

1. `electron/agent.ts` 已支持解析提示词模板 Markdown frontmatter 中的 `description` 与 `argument-hint`，但 `Composer.tsx` 仅在输入框上方展示一行静态文字（`参数提示：...`），用户仍需手动在 `/命令名 ` 后面按位置拼写参数，多个参数时容易漏填或错位；
2. `ResourcesTab.tsx` 仅支持查看与启停已有资源，用户若想把高频指令（如 `/review`、`/commit-msg`、`/fix-test`）保存为个人或项目级模板，必须手动去文件系统找 `~/.pi/agent/prompts/` 或 `.pi/prompts/` 目录并手写 YAML frontmatter。

**目标。** 为带参数的 `/` 模板提供结构化填空体验，并支持在“Pi 功能与设置”中直接新建与编辑本地提示词模板。

**不做。** 不做云端提示词社区或在线模板市场；不发明私有模板格式，100% 读写 Pi 标准 `.md` 模板文件。

**交互与技术方案。**

- **`/` 模板参数填空栏（`Composer.tsx`）**：
  - 当用户在输入框选择或输入匹配某个带 `argumentHint` 的 `prompt` 命令（如 `argument-hint: <目标文件> [关注点]`）时，输入框上方浮现轻量参数填空条，按占位符拆分为行内小输入框：
    - 支持 `Tab` / `Shift+Tab` 在参数框与主输入框之间切换，参数框内输入 `@` 同样可唤起文件选择器；
    - 发送时按顺序拼装为标准 `/命令名 参数1 参数2` 文本交给 Pi。
- **提示词模板可视新建与编辑（`ResourcesTab.tsx`、`electron/agent.ts`）**：
  - 在“Pi 功能与设置 → 资源”页签顶部增加 **“新建提示词模板”** 按钮，并在已有 `prompts` 类型资源行提供 **“编辑”** 与 **“删除”**（仅限用户自建的全局 `~/.pi/agent/prompts/*.md` 或当前项目 `.pi/prompts/*.md`，内置或第三方包资源只读）：
    - 表单字段：模板命令名（仅限字母、数字、连字符）、简短说明（写入 frontmatter `description`）、参数提示（可选，写入 `argument-hint`）、作用范围（“个人全局”或“仅当前项目”）、模板正文（支持 `$ARGUMENTS`、`$1` 等 Pi 原生占位符提示）；
    - 保存后自动触发 `getCommands` 刷新当前会话的 `/` 菜单，立即生效。

**验收标准。**

1. 在“资源”页签点击“新建提示词模板”，创建名为 `check-diff`、参数提示为 `<模块名>` 的项目级模板并保存，`<project>/.pi/prompts/check-diff.md` 文件格式符合 Pi 规范。
2. 回到输入框输入 `/check-diff`，自动显示 `<模块名>` 参数填空框，填入内容发送后正确展开。

**测试。** `tests/core.test.ts` 覆盖模板 frontmatter 序列化与路径安全校验；`scripts/test-features-ui.mjs` 增加新建模板与参数填空测试。

---

### E3 上下文水位预警、本地费用统计与冷会话自动收纳

**现状与问题。**

1. 长会话进行多轮工具调用后，上下文占用（`contextPercent`）逼近 80%–95%，此时不仅单轮响应变慢、费用陡增，还可能随时触发被动截断；但底部状态栏仅以普通灰色小字显示百分比，没有醒目预警和一键减负入口；
2. `SessionTab.tsx` 目前只展示当前单条会话的 Token 和费用，重度用户无法得知“今天或近 7 天在各个项目上累计消耗了多少 Token 与费用”；
3. 随着使用时间增长，左侧栏每个项目下积累几十条历史会话，夹杂着刚点开又没发消息的“空会话”和数周前的旧会话，列表冗长难找。

**目标。** 让上下文水位与本地累计开销透明可控，并提供一键上下文减负与历史会话自动收纳能力。

**不做。** 不建立云端账单中心或充值限额系统；不修改历史 `SessionSummary.stats` 数据结构去强行拆分单会话内多模型的明细账单（仅按现有会话级统计做本地聚合）。

**交互与技术方案。**

- **上下文水位三级指示与一键减负气泡（`Composer.tsx` / 状态栏）**：
  - 状态栏的上下文占用百分比按阈值着色：`< 75%` 常态、`75%–89%` 琥珀色预警、`>= 90%` 红色告警；
  - 点击该上下文指示器弹出快捷操作气泡：展示当前累计 Token 与上下文占比，并提供 **“立即压缩上下文（`/compact`）”** 与 **“从当前节点分支新会话”** 两个一键动作。
- **本地费用与用量汇总看板（`SessionTab.tsx`）**：
  - 在“Pi 功能与设置 → 会话”页签新增“本地用量汇总”区块，聚合桌面 `state.json` 中会话的 `stats` 与 `updatedAt`；旧会话的统计从原始 Pi JSONL 补全，缺失费用保持未知：
    - 展示 **今日 / 近 7 天 / 全部历史** 的总 Token 数与总费用（`$`）；
    - 按项目分组列出各项目的累计会话数、Token 与费用占比。
- **冷会话自动折叠与空会话一键清理（`Sidebar.tsx`、`electron/main.ts`）**：
  - 每个项目下的会话列表中，**未置顶（`!pinned`）且超过 7 天未更新**的会话默认收拢进该项目底部的 `更早的会话 (N)` 折叠组，点击可展开；搜索筛选时自动穿透展开匹配项；
  - 项目标题旁或侧栏底部提供 **“清理空会话”** 按钮：一键删除所有未置顶、无运行进程且消息数为 0（`messages.length === 0` 且无关联非空 JSONL）的空白会话，删除前提示数量。

**验收标准。**

1. 当 `runtime.stats.contextPercent` 达到 `80%` 时，底部状态栏指示器变为琥珀色；点击后可一键触发压缩上下文。
2. 打开“Pi 功能与设置 → 会话”，准确显示本地各项目的累计 Token 与费用汇总。
3. 超过 7 天未活跃的未置顶会话自动归入 `更早的会话 (N)` 折叠项；点击“清理空会话”准确移除无消息的空白会话，不影响有内容的会话。

**测试。** `tests/store.test.ts` 增加空会话判定与按项目费用聚合单元测试；`scripts/test-experience-ui.mjs` 增加上下文预警气泡、费用汇总展示与冷会话折叠测试。

---

### E4 设置与 Pi 功能中的 Skills 及资源展示优化

**现状与问题。**

1. **缺失语义简介（看不懂用途）**：原 `ResourcesTab.tsx` 仅显示 `SKILL.md` 父目录名（或文件名）、英文内部枚举 `{kind} · {scope}`（如 `skills · user`）以及完整绝对路径，未读取 `SKILL.md` 与提示词模板 `.md` 的 YAML frontmatter（`name`、`description`、`argument-hint`）。用户无法在界面上判断某个 Skill 的触发场景与功能职责，也无法按简介检索；
2. **无分类与状态统计（找不到目标）**：`skills`、`prompts`、`extensions`、`themes` 四类资源混排在单一列表中，没有按类别切换的分段标签、分类计数与已启用数量统计；
3. **路径喧宾夺主与长列表挤压（版面失控）**：每条资源的完整绝对路径独占一行且自动折行，且 `.resource-list` 无高度上限；当用户本机安装了数十个 Skills 时，下方的“安装与管理资源包”与“当前工具”被彻底挤出视口，同时缺少一键在编辑器或系统文件管理器中定位该资源文件的动作；
4. **设置入口割裂**：用户常先通过 `Ctrl+,` 打开主“设置”弹窗寻找 Skill 管理，但“设置 → 运行环境”仅展示“Pi 配置目录”路径，缺少像“模型连接 → 管理供应商与登录”那样一键跳转到“Skills 与扩展”的直达入口。

**产品结论（PM 决策定稿）。**

经产品评估，上述四项痛点互为因果，仅靠局部调样式无法解决几十个 Skills 场景下的可用性问题，因此**全部纳入本轮正式方案一并交付**：
1. **主进程补齐资源元数据提取**（`name`、`description`、`argumentHint`），展示与检索均覆盖简介说明；
2. **重构顶部操作栏与分类分段筛选**（全部 / Skills / 提示词模板 / 扩展 / 主题 + 数量与启用统计），并将原始英文 `kind · scope` 升级为中文语义徽章与命令调用微标（`/skill:名称`、`/命令名`）；
3. **采用紧凑列表排版、路径单行收敛、列表独立滚动（上限 `360px`）与一键打开文件（`openResource`）**；
4. **在主“设置 → 运行环境”页签补充直达“Skills 与扩展”的快捷入口**。

**不做。** 不建立私有资源数据库或缓存索引，所有展示元数据实时从本地文件头部轻量读取；不对第三方或不可读的异常 `SKILL.md` 报错阻断列表加载；不放开对非 Pi 资源路径的任意文件打开权限。

**交互与技术方案。**

- **主进程资源元数据轻量解析（`electron/prompts.ts`、`electron/main.ts`、`shared/types.ts`）**：
  - `ResourceItem` 扩展可选字段 `name?: string`、`description?: string`、`argumentHint?: string`；
  - 新增 `describeResource(context, resource)`：对 `skills` 与 `prompts` 的 `.md` 文件读取前 `16 KiB` 内容，解析 YAML frontmatter：
    - `name`：`skills` 优先取 frontmatter `name`，回退取 `SKILL.md`（不区分大小写）所在父目录名；`prompts` 取不含 `.md` 的文件名以严格对应 `/命令名`；其余资源取文件名；
    - `description`：优先取 frontmatter `description`（压缩多行空白并截断至 240 字）；若无则提取正文首段非标题、非注释文本；
    - `argumentHint`：取 frontmatter `argument-hint`（截断至 200 字）；
    - 异常容错：文件不存在、权限不足或 YAML 损坏时静默降级为默认文件名，绝不阻断 `resources` 列表返回。
- **分类分段筛选、中文化徽章与紧凑列表（`src/features/ResourcesTab.tsx`、`src/styles/management.css`）**：
  - **顶部操作栏**：标题右侧并排放置“新建提示词模板”与“刷新”按钮；
  - **分类工具栏**：提供 `全部`、`Skills`、`提示词模板`、`扩展`（以及存在主题时显示 `主题`）分段按钮（附带各自数量），右侧展示当前分类下的 `已启用 X / Y` 统计；
  - **多维检索**：筛选框支持按名称、简介（`description`）、参数提示、路径、中英文类型及范围关键词实时过滤；
  - **紧凑资源行（`.resource-row`）**：
    - 首行展示启用复选框、**名称**、命令调用提示（`skills` 显示 `/skill:<name>`，`prompts` 显示 `/<name>` 及参数提示）、中文类型徽章（`Skill` / `提示词模板` / `扩展` / `主题`）、中文范围徽章（`个人` / `当前项目` / `临时` 及资源包来源），右侧放置“定位/打开文件”与模板“编辑 / 删除”操作；
    - 次行展示 `description`（最多 2 行截断，`title` 悬停显示完整说明）；
    - 末行路径 `<code>` 设为单行尾部省略并弱化字色，`title` 保留完整路径；
  - **高度约束**：`.resource-list` 设置 `max-height: 360px` 独立滚动，确保下方的“安装与管理资源包”与“当前工具”始终留在视口内。
- **受控资源文件打开（`openResource` IPC）**：
  - 在 `shared/types.ts` 与 `electron/main.ts` 新增只读方法 `openResource(sessionId, targetPath)`；
  - 主进程校验 `targetPath` 必须属于该会话已解析出的 `ResourceCatalog.resources` 路径集合（使用 `samePath` 比对），拒绝任何列表外路径；若用户配置了 `editorPath` 则在外部编辑器中打开，否则调用 `shell.showItemInFolder` 在系统文件管理器中定位。
- **主“设置”直达入口（`src/components/SettingsModal.tsx`）**：
  - 在“设置 → 运行环境”的“Pi 配置目录”下方提供 **“管理 Skills、扩展与提示词模板”** 按钮，点击后关闭设置弹窗并直接打开 `Pi 功能 → Skills 与扩展` 页签。

**验收标准。**

1. 包含 YAML frontmatter（`name`、`description`）的 `SKILL.md` 在“Skills 与扩展”列表中展示其名称、`/skill:<name>` 调用提示、中文简介及“Skill · 个人/当前项目”徽章；输入简介中的关键词可准确筛选出该 Skill。
2. 点击分类分段标签（如 `Skills`、`提示词模板`、`扩展`）可按类别过滤列表并显示准确计数与已启用统计；当存在数十个资源时，列表在独立容器内滚动，下方“安装与管理资源包”无需滚穿全表即可操作。
3. 点击资源行右侧的定位按钮，仅对当前会话已解析的资源文件触发打开/定位，传入未注册路径时被主进程拒绝。
4. 在主“设置 → 运行环境”点击“管理 Skills、扩展与提示词模板”，可直接跳转至“Pi 功能 → Skills 与扩展”页签。

**测试。** `tests/templates-v014.test.ts` 增加 `describeResource` 对 Skill / 模板 frontmatter、正文首段回退与损坏文件容错的单元测试；`scripts/test-features-ui.mjs` 与 `scripts/test-management-v014-ui.mjs` 回归分类筛选、简介展示与模板编辑操作。

## v0.14.30：背景配色主题（已实现）

默认仍是浅色（白）、深色（黑）及跟随系统。新增三套整体背景配色，改变窗口背景、侧栏、面板、文字、分隔线和标题栏；按钮、选中项等强调色沿用浅色或深色的原有配色，不随背景主题改变。v0.14.29 的独立“强调色”设置已移除。

### A1 护眼米黄、豆沙绿与深蓝主题

- “设置 → 外观与编辑器 → 主题”在浅色、深色、跟随系统之后新增护眼米黄、豆沙绿、深蓝三项，每项显示背景色块；点击立即生效并保存。
- 护眼米黄与豆沙绿是浅色系，原生菜单、对话框和滚动条按浅色显示；深蓝是深色系，按深色显示，代码语法色使用深色版本。
- Windows/Linux 的窗口背景与标题栏按钮区使用所选主题的 `--bg`、`--rail`、`--ink`，避免标题栏与界面颜色不一致；macOS 保留系统红绿灯。
- `Settings.theme` 取值为 `light` / `dark` / `system` / `sepia` / `green` / `navy`（`THEMES` 位于 `shared/window-theme.ts`）。主进程拒绝未知值；读取 `state.json` 时未知主题按坏设置修复为跟随系统并计入恢复提示。旧版本残留的 `accent` 字段会被忽略。
- 实现：`src/styles/themes.css` 覆盖背景、文字、线条与阴影变量；`windowTheme()` 与 `nativeThemeSource()` 负责原生窗口配色与系统外观。
- 测试：`tests/store.test.ts` 覆盖主题保留与修复；`tests/app-dialogs.test.ts` 校验原生窗口配色与 CSS 一致；`tests/desktop-chrome.test.ts` 覆盖切换主题时窗口背景与标题栏；`tests/theme-ui-selectors.test.ts` 覆盖六个主题按钮。

## v0.7.0 需求补充：工具审批、Git 快照与长会话性能

以下三项为 v0.7.0 的新增功能。审批使用真实 Pi 1.1.0 和本地测试接口验收（`scripts/test-approval.ts`、`scripts/test-approval-ui.mjs`）；快照与增量状态使用回归测试验证（`tests/core.test.ts`、`tests/snapshot.test.ts`、`tests/runtime-patch.test.ts`）。性能部分尚未完成原方案全部目标。

### 工具审批模式（原 C1）

- 输入框左下角新增审批模式切换：**全自动**（默认，沿用原行为）、**确认修改**、**只读**。模式按会话保存，重连后恢复；执行中切换会在本轮结束后生效。
- 判定由桌面适配扩展在 Pi 的 `tool_call` 和 `user_bash` 钩子中完成：内置读取与搜索工具（read / grep / find / ls / tool_search）放行；“确认修改”下写入、命令和其他工具需要确认；“只读”下直接拒绝这些操作，不弹确认。外部工具自报的 `readOnlyHint` 不作为放行依据。手动 `!` / `!!` 命令也遵守当前模式。
- “只读”限定于经过拦截的工具调用，不能限制扩展自身代码或系统进程，不是操作系统沙箱。扩展仍需要用户信任。
- 确认以卡片形式出现在对话流中（不再是模态框）：命令显示全文，edit 显示改动行，write 显示写入内容。操作为“允许 / 本会话总是允许（命令按完全相同的文本匹配，其他工具按工具名） / 拒绝…（可填写原因）”，拒绝原因作为工具结果交给模型。
- 停止任务会自动拒绝所有待确认项；被拒绝的调用不会开始执行。临时“总是允许”授权在切换 Pi 会话或退出确认模式后清除，重新连接也不会保留。

### 基于 Git 的运行快照（原 C2）

- Git 项目中，每次发送前把工作区文件以 Git 对象形式存入应用数据目录下的私有仓库，该仓库借用项目的对象库，项目已有的内容不重复存储。项目自身的 `.git` 只读，不新增对象、引用、stash 或索引变化。
- 单文件上限从 1 MiB 提高到 50 MiB；纳入快照的二进制内容、原始换行符和 POSIX 读写执行权限可恢复，SHA-1 和 SHA-256 仓库均支持。二进制或超过 1 MiB 的文件可以撤销，但不显示差异预览。
- 范围沿用项目文件扫描：最多 2 万个文件，排除凭据、构建目录及未跟踪的忽略文件。符号链接、非普通文件、超过 50 MiB 或名称包含换行的文件不纳入快照；非 Git 目录不提供本轮撤销。
- 保留最多 7 天，应用快照总量上限 200 MiB（包含私有 Git 对象）。超过容量会清理旧快照；如果新快照本身超过上限，任务不会开始并提示原因。每个项目仅保留最近一次基线。
- 撤销前先检查变化扫描是否成功并读取全部原内容，避免缺失对象后才发现无法恢复；后续磁盘写入失败仍可能留下部分已恢复文件。旧格式快照不能沿用，升级后需要新任务建立基线。借用的 Git 对象若被项目的垃圾回收删除，撤销会明确报错；快照不能替代备份。
- 尚未提供可复现的性能测量脚本，不对 1 万文件仓库的快照耗时作数值承诺。

### 长会话性能（原 C4）

- 主进程不再每次发送整个消息和工具数组，改为从首个变化位置推送后续项；未变化的前缀保留原对象，完全未变化的数组保留原引用。窗口刷新或重连时自动全量同步。
- 消息使用缓存组件，Markdown 只在文本变化时重新解析；工具完成状态也必须刷新，不能复用仍在运行时的旧缓存。
- 未实现可视区域虚拟列表；`App.tsx` 的拆分见下一版 R2。

## v0.6.1 修复与视觉调整

- 纯文字消息不再渲染空图片容器，修正气泡下方多出的段落间距；多段文字与图片消息保留各自间距。
- 调整工具调用之间的连接线、展开状态连线及输入框运行提示。
- 使用新的高清 π 图标，统一窗口与 Windows、macOS、Linux 打包资源；Windows ICO 包含 16 至 256 像素的九种尺寸。

## v0.6.0 需求补充：macOS 与 Linux

- 支持 Windows x64、macOS（x64 / arm64）与 Linux x64。macOS 暂不签名、不公证，README 说明首次打开方式。
- 平台差异集中在 `electron/platform.ts`：路径比较（Windows、macOS 不区分大小写，Linux 区分）、外部终端、外部文本编辑器、编辑器路径校验、登录 shell PATH。
- “在 Pi 终端继续”：Windows 用 PowerShell，macOS 用“终端”，Linux 依次尝试常见终端。锁文件记录实际运行 Pi 的进程（Windows 为等待 Pi 结束的 PowerShell），不使用启动器进程号。启动失败立即释放，启动未确认最多等待 15 秒；运行期间不按时长过期，进程结束后自动清除残留锁。
- 停止任务：POSIX 上 Pi 运行在独立进程组，强制结束会连同 Pi 启动的命令一起结束。
- 运行环境：只有 Windows 要求 Git Bash；macOS / Linux 使用系统 bash。从访达或桌面菜单启动时读取登录 shell 的 PATH。
- macOS 习惯：快捷键使用 ⌘，界面中的快捷键提示随平台显示；提供应用菜单（关于、设置 ⌘,、隐藏、退出）和窗口菜单；隐藏式标题栏，侧栏和顶栏可拖动窗口；关闭窗口不退出，点程序坞图标恢复，⌘Q 退出时仍提示正在执行的任务。“回收站 / 资源管理器”等文案按平台显示为“废纸篓 / 访达 / 文件管理器”。
- 打包：`npm run package` 生成当前系统的安装包；CI 在 Windows、macOS、Ubuntu 上分别构建并运行单元测试与真实 Pi 测试，推送 `v*` 标签时上传三个平台的安装包。

## v0.5.0 需求补充：使用体验

- 后台提醒：窗口未获得焦点时，当前会话本轮稳定结束（完成）、失败/中断，或扩展新增等待回复的对话框，发送一条 Windows 系统通知并闪烁任务栏；窗口重新获得焦点时停止闪烁。点击通知恢复窗口并切到该会话。完成通知正文为最后回复的前 120 字，失败通知为已脱敏的错误。“设置 → 外观与编辑器”可关闭，默认开启。只在同一会话的状态转换时提醒，切换会话或重连不触发。
- 窗口状态：记住正常尺寸、位置与最大化，写入应用数据目录 `window.json`。恢复时校验仍在某个显示器的工作区内，否则回到默认居中；全屏和最小化不记录。
- 提问历史：输入框为空（或仍是刚调出的历史）时，`↑`/`↓` 在本会话已发送的用户消息间翻看，去掉项目文件引用块和连续重复；继续输入即退出翻看。不覆盖用户正在编辑的草稿。
- 停止确认：执行中按 `Esc` 进入 2 秒确认态，停止按钮和底部提示变为“再按一次 Esc 停止全部”，再按一次调用与按钮相同的停止流程。弹窗、菜单、工作区面板打开时 `Esc` 仍只负责关闭它们。
- 快捷键速查：`Ctrl+/`、`/hotkeys` 或输入框下方的提示打开，按输入 / 运行 / 导航分组。
- 拖入引用：拖入图片仍作为图片附件；其他文件在项目会话中由主进程校验（位于项目内、非凭据文件、文本、≤256 KiB，单次最多 20 个）后加入引用，不合格的列出文件名和原因。校验完成后合并到最新草稿，保留期间输入的文字和移除附件的操作；切换会话会取消尚未完成的添加。独立对话提示需要打开项目。
- 开始前检查：空会话欢迎页在 Pi 未就绪或尚未有模型时显示两步清单（找到 Pi、选择模型），每一步给出当前状态和唯一的下一步操作：检查运行环境、连接并读取模型、选择模型或登录供应商。全部就绪后不显示。

## v0.4.0 需求补充：改代码主线、命令与配置

- 工具卡片：`edit` 直接显示 Pi 返回的统一差异和 `+增/−删` 行数，`write` 显示写入行数，命令失败显示退出码；历史会话重新打开时同样可见。
- 回复信息：每条 Pi 回复悬停显示实际响应模型、tokens 与费用，提示中列出输入/缓存/输出明细与推理级别。
- 撤销修改：工作区“运行期间变更”可“撤销本轮”或在文件预览中“撤销此文件”，恢复到本轮任务开始前的快照；本轮新建的文件移到回收站，任务前已有的未提交修改不动。执行中、基线失效（切分支/提交）时不可撤销，操作前确认。
- 命令菜单：按桌面命令 / 提示词模板 / Skills / 扩展分组，名称和说明都可检索，`Tab`/`Enter` 补全；模板显示 `argument-hint`，补全后输入框上方保留参数提示。与桌面命令同名的 Pi 命令用 `//名称` 调用，不再被遮挡。
- 会话树：可给任意记录加/改/清除标签（Pi `setLabel`，写入会话文件）；筛选“对话 / 只看提问 / 有标签 / 全部记录”，标签可搜索。
- 常用设置：“Pi 功能 → 常用设置”以表单编辑压缩、重试、新会话推理级别、内置工具、图片、Shell、代理与传输方式，个人/项目范围可选；只写入改动的键，保存前备份并重新加载 Pi。完整 JSON 编辑保留。
- 真实 Pi 验收：`scripts/test-coding.ts`（已并入 `npm run test:features`）。

### 撤销与设置的行为约定

- 撤销使用原始字节快照，不改变文件编码。符号链接及目录链接下的文件不参与自动撤销；旧文本快照不再用于恢复，新任务重新采集快照。
- 新会话从 Pi 配置读取默认推理级别，项目配置覆盖个人配置；模型面板切换推理级别时同步更新个人默认值，已有会话继续保留自己的选择。
- 项目表单显示继承后的有效值，只保存用户修改的项。个人工具空列表表示全部禁用；项目工具全部取消勾选时写入对继承工具的明确移除，避免 Pi 将空项目列表解释成继续继承。
- 设置与命令补全的界面回归：`scripts/test-coding-ui.mjs`（已并入 `npm run test:features-ui`）。

## v0.3.0 需求补充：按 Pi 能力完善工作流

- 消息操作：用户消息悬停可“编辑后重新发送”（Pi 树导航回到该消息之前，原文与图片回填输入框）和“从这里分支”（Pi `fork` 生成新会话）；最后一条回复可“重新生成”。原分支都保留在会话树中，不在当前分支上的消息会提示先切换。
- 模型热切换：模型与推理级别通过 `set_model` / `set_thinking_level` 直接作用于运行中的 Pi，不再重启进程；每个会话记住自己的模型和推理级别，重连时恢复，新会话沿用最近一次选择。执行中禁止切换。
- 会话管理：侧栏会话支持右键/“⋯”菜单置顶、重命名、导出 HTML、删除；删除将 Pi 会话文件移到系统回收站。置顶会话排在最前。
- 搜索：`Ctrl+K` 同时匹配标题与消息内容（两个字以上，展示命中片段），支持 `↑↓` / `Enter`；“Pi 历史会话”页列出 Pi 会话目录中尚未加入桌面的会话（如终端中创建的），选择后直接打开并归入匹配的项目。
- 运行反馈：扩展 `notify` 按 info / warning / error 以右下角通知显示，错误需手动关闭；自动重试显示次数、倒计时和原因，可“取消重试”（`abort_retry`）；扩展对话框显示剩余秒数和后续排队数量；模型正在生成工具参数时显示“正在准备 某工具”。
- 底部状态显示上下文占用条（60% 起琥珀、85% 起红色）、累计 tokens 与费用，点击打开“会话与上下文”。
- 真实 Pi 验收：`scripts/test-workflow.ts`（已并入 `npm run test:features`）。

### 模型就地切换与视觉更新

- 输入框左下角的模型按钮就地弹出模型面板，不再打开设置。面板按供应商分组，可搜索名称/ID，显示推理、图片和上下文窗口标签；`↑↓` 选择、`Enter` 切换、`Esc` 或点击外部关闭。
- 面板底部提供推理级别分段切换；按钮显示已选级别。未连接时打开面板自动连接 Pi；没有可用模型时引导到“供应商与登录”。运行中可修改模型和推理级别，展示本轮值及下次值；下次发送新任务才应用，工具继续推理、运行中补充及排队消息沿用本轮设置。初始化尚未读出模型时保留入口并解释原因。
- 输入框模型面板与设置中的模型选择行为一致，选择后立即保存，无需点击“保存设置”；任务期间运行环境设置仍不可保存。真实 Pi 回归见 `scripts/test-model-switch-ui.mjs`，覆盖当前回复不中断、工具后的请求使用新模型，以及切换确认期间的保护。
- “连接设置”进入设置中的模型页，用于测试连接、查看凭据状态。
- 视觉：墨绿主色（浅色 `#1F6B52` / 深色 `#74C7A3`）只用于选中、完成和主操作；新增琥珀色（`#B4730F` / `#E9B45E`）专门表示“正在执行/等待”，与完成状态区分。
- 品牌标记与欢迎页使用数学斜体 π；正文 Segoe UI Variable，代码 Cascadia Code。
- 工具调用改为左侧时间线：完成为绿点、执行中为琥珀点、失败为红点并自动展开。执行中输入框描边转为琥珀色并有扫描线，停止按钮同色。
- 侧栏当前会话用白色浮起与左侧色条标出，项目会话以缩进线归属项目；欢迎页建议改为带一句说明的三列卡片，窄窗口改为单列。

## v0.2.0 需求补充：Pi 功能覆盖

- 右上角“Pi 功能”集中承载会话/上下文、会话树、资源、MCP、供应商和完整配置，聊天主页面保持简洁。
- 独立对话保留 Pi 工具与用户资源，无需先添加项目；显示并可打开实际工作目录。项目会话继续提供文件与 Git 面板。
- 支持图片选择、粘贴、拖放与预览；图片随草稿、消息和分支恢复。单条最多 8 张、单张 8 MiB、合计 16 MiB。
- 会话树展示当前分支，支持检索、导航、分支总结、fork 和 clone；旧会话及原分支保留。
- 通过 `/` 菜单发现桌面命令及 Pi 已加载命令。提供手动压缩、自动压缩/重试、队列策略和 `!` / `!!` 直接命令。
- 原生 API Key 与 OAuth 流程在 GUI 展示输入、授权链接、进度和取消；兼容端点支持添加和完整编辑，不回显已有密钥。
- 管理个人/项目 MCP、工具暴露与连接；管理 Skills、模板、扩展和资源包。高级 Pi 设置通过完整 JSON 配置提供。
- HTML 与 JSONL 导出、Gist 分享（确认后上传），支持恢复同一会话到原生 Pi 终端，覆盖仅有终端 UI 的扩展。
- 配置写入保留备份，检测外部修改；升级沿用已有 CPA 配置和会话。运行、打包和验证边界见 IMPLEMENTATION.md。

## v0.1.2 需求补充：独立对话

工作区是执行本地编程任务的可选入口。用户无需选择文件夹即可新建对话、选择已配置的模型、发送消息、搜索历史，以及恢复未发送的草稿。

- 全局“新建对话”和 `Ctrl+N` 创建独立对话；首次启动自动准备一条空对话。
- 侧栏的“对话”列表存放独立对话，“项目”列表继续按项目组织编程会话；项目旁的 `+` 在该项目内新建会话。
- 独立对话不展示工作区检查、文件引用和项目授权；文件/命令工具及项目扩展上下文关闭。模型选择、思考、流式回复、停止和历史保留。
- 项目会话维持既有授权与工具能力。两类会话切换时不混入对方的正文、草稿或工具结果。
- 升级保留已有项目和历史；关闭重开后恢复当前对话及草稿，不自动重放消息。

## 1 产品定位与首版目标

Pi 桌面 GUI 把本地 Pi 编程智能体带到一个可持续工作的桌面窗口：用户选择项目、描述任务、跟踪执行、检查文件变化，并在同一会话中继续修改。首版围绕个人开发者的日常改代码流程交付。

首版方案写于 2026 年 10 月 11 日，后续版本的变化见文首各版本小节。产品名 Pi Desktop，仓库名 pi-desktop-gui。

### 建议采用的产品形态

Windows 11 x64 优先，中文界面，连接用户已经安装的 Pi。应用保持本地项目和会话入口；模型请求沿用 Pi 的供应商配置。首次使用无需注册本产品账号。

主界面采用项目与会话侧栏、对话执行区、文件与变更面板。开发者可以从一句需求走到可检查的代码差异，遇到失败也能知道停在了哪一步。

| 用户问题 | 首版需要提供的结果 |
| --- | --- |
| 命令行会话不易找回 | 按项目管理会话，重新打开后继续已有上下文 |
| 执行过程看不清 | 工具动作、命令输出、失败原因和运行状态可查看 |
| 不知道改了什么 | 展示工作区差异和运行前已有的未提交变化 |
| 想在执行中补充要求 | 明确区分立即补充、完成后执行和停止全部 |

### 首版成功标准

- 已有可用 Pi 环境的用户，在 3 分钟内选定项目并发出第一条任务；模型响应时间单独记录。
- 一次完整流程能完成读取文件、修改文件、执行测试、查看差异、停止以及恢复会话。
- 界面中的已结束、已停止和失败均有实际事件或进程状态依据；测试通过需要展示命令和结果。

本方案默认单人本地使用，依赖已有 Pi，每次运行一个会话。

## 2 使用场景与功能范围

### 主要用户与核心路径

主要用户是已经会使用 Git 和代码编辑器、希望减少命令行切换的个人开发者。最常见的任务是理解代码、修复缺陷、添加小功能和补充测试。

核心路径：添加本地项目 → 选择或继续会话 → 选择模型 → 输入需求与文件引用 → 跟踪执行 → 查看差异和测试输出 → 继续提出修改要求。

| 级别 | 功能 | 交付范围 |
| --- | --- | --- |
| P0 | 环境与连接 | 检测 Pi、版本、Git、Bash；复用 Pi 认证；显式测试连接 |
| P0 | 项目与会话 | 添加目录、新建与恢复会话、重命名、按项目筛选 |
| P0 | 对话与上下文 | 流式回复、代码块、项目内文本文件引用、复制内容 |
| P0 | 运行控制 | 工具与输出、立即补充、后续队列、停止全部、异常恢复 |
| P0 | 文件与变更 | 只读文件预览、Git 差异、运行前变更标记、外部编辑器入口 |
| P0 | 基础设置 | 运行路径、配置来源、模型、推理级别、亮暗主题 |
| P0 | 扩展兼容 | 支持 RPC 基础对话框、通知与状态；提供兼容性提示 |
| P1 | 使用体验 | 图片输入、会话树和分叉、搜索全文、导出、原生 API Key 表单（已在 v0.2.0–v0.3.0 交付） |
| P1 | 开发流程 | 受控文件快照与恢复（v0.4.0 交付，v0.7.0 改为 Git 快照） |
| P1 | 跨平台 | macOS 与 Linux（v0.6.0 交付） |

### 首版边界

不提供代码编辑器、交互终端、云端账号同步、插件市场、后台无人值守任务、多智能体编排、多会话并发、WSL/SSH 远程项目和容器执行。应用支持查看和打开文件；编辑、提交和推送继续在现有开发工具中完成。

以可信本地项目为使用前提。Pi 可以直接改写文件并执行命令；变更面板是执行后的检查入口。工具审批与只读模式已在 v0.7.0 提供，但不是操作系统沙箱。[S8](https://github.com/earendil-works/pi#permissions--containerization)

## 3 主工作区界面设计

![图 1 主工作区线框图 以修复登录校验为例](assets/pi-workspace.png)

图 1 主工作区线框图 以修复登录校验为例

### 布局与信息层级

- 左栏显示项目和当前项目会话，保留新建入口、运行状态和未读标记。切换会话时保存草稿、滚动位置和已展开的工具卡片。
- 中央以对话为主，工具过程折叠显示，失败动作自动展开。输入框固定底部，运行时保留补充输入和停止入口。
- 右栏提供变更、文件和输出三个页签。点击工具里的文件路径定位到文件预览；点击命令定位到完整输出。

建议默认窗口 1440 × 900，最小 800 × 700，以支持 C2 小于 900 px 的侧边对话抽屉。宽屏初始左栏 240 px、右栏 360 px，其余留给对话；宽度不足 1200 px 时右栏改为可展开抽屉。字号默认 14 px，代码 13 px，可调整到 200%。

运行状态同时使用文字和图标，不仅依赖颜色。用户向上阅读时暂停自动滚动，出现新内容按钮；返回底部后才恢复跟随。图中模型、项目和代码均为交互示例。

## 4 首次使用与模型连接

![图 2 首次使用向导 模型连接步骤](assets/pi-setup.png)

图 2 首次使用向导 模型连接步骤

### F01 环境检查

按运行环境、模型连接、选择项目三步完成。支持自动查找 Pi 和手动选择可执行入口；显示路径、实际版本与验证情况。以 Pi 1.1.0 为回归基线，其他可识别版本也允许运行，仅提示尚未验证，实际交互保留协议校验。[S1](https://github.com/earendil-works/pi/releases/tag/v1.1.0)

原生 Windows 需检查 Git Bash，展示当前实际使用的命令环境。Pi 支持 Windows 原生运行和可选 PowerShell 工具；桌面端适配 Git Bash，不支持 WSL。[S7](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/windows.md)

### F02 凭据与模型

P0 复用用户 Pi 的配置和已保存凭据，提供配置位置、登录指引与重新检测。界面分别显示未配置、已发现未验证、可连接和连接失败。找到配置不能直接标记连接成功。[S6](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/providers.md)[S11](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/configuration.md)

模型列表和可用推理级别动态读取。用户点击测试连接后才发送一次简短模型请求，并显示耗时和明确错误。首次未验证也可进入工作区，但发送任务前必须选定模型；实际请求结果更新连接状态。

项目选择使用本机目录对话框。添加后显示完整路径和 Git 分支；非 Git 目录也能使用对话与工具输出，变更页提示可用范围。

## 5 对话输入与执行过程

### F03 输入和文件引用

空闲时 Enter 发送，Shift + Enter 换行；中文输入法正在组词时 Enter 仅确认输入。Ctrl + N 在当前项目新建会话，Ctrl + K 打开项目与会话切换器，Ctrl + , 打开设置。快捷键可在菜单中找到。

输入 @ 后搜索项目内文本文件，选中后形成可移除引用。发送前显示文件路径、大小与内容预览；每个文件上限 256 KiB，每条消息总计 1 MiB，超出时要求缩小内容。二进制、默认忽略目录和疑似凭据文件不进入候选列表。

文件引用在发送时由主进程读取并附入请求，使用项目相对路径标注来源。解析符号链接后的目标必须仍在项目内；不可读或已删除的文件使发送失败并保留草稿。上述限制只约束 GUI 附件入口，不能限制 Pi 自己的文件访问。

### F04 运行中的补充消息

| 输入方式 | 用户含义 | 界面反馈 |
| --- | --- | --- |
| 立即补充 | 请在当前工作中纳入新要求 | 显示待处理补充；由 Pi 决定安全接入时机 |
| 完成后执行 | 本轮结束后再处理这个任务 | 显示后续队列及顺序，不显示为已执行 |
| 停止全部 | 结束当前工作并清空后续队列 | 进入停止中，排队内容恢复到草稿区 |

运行中默认选择立即补充，发送按钮旁可切换完成后执行。两者分别映射 Pi 的 steer 和 follow_up；收到队列事件后才更新已排队状态。首版提供清空全部队列，不提供尚未验证的逐条撤回能力。[S3](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)[S4](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/json.md)

### F05 工具过程与结果

工具卡片显示动作名称、目标路径或命令、开始时间、耗时、当前状态和结果摘要。命令输出允许复制与保存本地文本。单张卡片默认只展示 200 行；超出内容由输出页按需加载。

Pi 回复、工具执行结果和测试状态分别展示。只有观察到实际命令及退出结果，才展示该命令的通过或失败；模型声称完成不能替代验证记录。首版不推断整个项目测试已全部通过。

## 6 运行状态与异常恢复

| 状态 | 界面行为 | 退出条件 |
| --- | --- | --- |
| 空闲 | 允许发送与切换模型 | 用户发送任务 |
| 启动中 | 显示当前启动步骤，允许取消 | 进程可用并接受请求，或启动失败 |
| 运行中 | 持续接收回复和工具事件 | 收到等待、重试、停止或稳定结束事件 |
| 等待输入 | 呈现扩展提出的问题和选项 | 用户回复、取消或请求超时 |
| 重试或整理上下文 | 显示原因与进度，仍可停止 | Pi 继续运行或稳定结束 |
| 停止中 | 禁止新发送，保留输出 | Pi 停稳，或用户选择强制结束 |
| 本轮已结束 | 显示结果和继续输入入口 | 用户发起下一轮 |
| 失败或已中断 | 保留历史与草稿，提供诊断 | 用户选择恢复或重新连接 |

### F06 完成判定与停止

prompt 的成功响应只代表接收请求；agent_end 也可能之后继续重试或执行队列。界面以 agent_settled 和消息结果确定本轮稳定结束，再区分正常结束、失败和用户中止。扩展直接处理的 handled 请求单独回到空闲，不等待不存在的运行。[S2](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)[S4](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/json.md)

停止全部时先冻结发送并 clear_queue，保存返回的队列文本，再 abort；确认空闲后结束停止状态。Pi 的 abort 本身不会保证清空队列。清队列失败时保持停止中并显示错误，不能宣布已经全部停止。[S3](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)

停止超过 5 秒显示仍在停止，超过 15 秒提供强制结束该会话进程的操作。强制结束需再次明确影响；实现必须限定到应用创建的进程树，并在 Windows 上验证子命令也已退出。

### F07 故障与退出

网络、限流、认证失败均保留已经收到的内容。Pi 自己的重试只显示状态；稳定失败后才允许用户重新发送。进程崩溃标记已中断，重新连接只恢复历史，不自动重放最后一个任务。

关闭窗口时如有运行任务，提供继续留在窗口和停止并退出。首版不后台驻留。历史会话可离线查看；关闭和异常重启后草稿必须可恢复。

## 7 文件检查与变更审阅

### F08 文件浏览

文件树按需展开，默认遵循忽略规则；只读预览文本和代码，超大文件显示截断提示与在编辑器中打开。复制路径时使用真实路径，界面显示项目相对路径。应用不会在用户浏览文件时自动将其附入模型请求。

### F09 Git 差异

默认变更页显示当前工作区相对 HEAD 的差异，并标识暂存、未暂存、新增、删除、重命名及二进制文件。对没有首个提交的仓库按空基线显示新增文件；Git 不可用时退化为文件预览和工具记录。

每次运行前记录 Git 状态和受支持文本文件的内容基线，保存在应用本地数据目录。默认排除忽略文件、敏感文件和单个超过 1 MiB 的文件，单次基线上限 20 MiB；达到限制则明确提示哪些文件无法生成运行差异。

提供全部未提交变更和运行期间变更两个视图。运行前已修改的文件始终带标记；运行中用户或编辑器也可能改文件，因此第二个视图只表示时间范围内的差异，不声称全部由 Pi 产生。Git 分支或 HEAD 在运行中变化时使该次基线失效。

| 情况 | 展示规则 |
| --- | --- |
| 文本修改 | 优先统一差异；可切换左右对照，显示完整文件入口 |
| 新文件或删除 | 明确新增或删除状态，列出内容或删除前基线 |
| 二进制或超出限制 | 显示状态与大小，不伪造文本差异 |
| 外部继续编辑 | 提示文件已更新，刷新前保留当前阅读位置 |
| 非 Git 项目 | 显示工具提及的文件和文件浏览；不显示完整仓库差异 |

### 审阅后的动作

首版提供在编辑器中打开、复制相对路径和就该文件继续提问。Pi 的编辑已写入工作区，因此界面不使用接受后应用这类按钮。首版也不提供一键撤销整轮，避免覆盖用户已有修改。

Git commit、push、分支合并及部署不提供专用按钮。Pi 仍可能通过命令执行这些操作；本产品的功能范围不能作为限制 Pi 权限的保证。[S8](https://github.com/earendil-works/pi#permissions--containerization)

## 8 会话 设置与扩展兼容

### F10 项目与会话生命周期

项目以规范化后的绝对路径去重，展示名称允许修改。会话保存标题、所属项目、Pi 会话文件引用、更新时间和最近状态；正文继续由 Pi 的会话格式保存，应用索引不作为另一份正文真相。

首次仅展示本应用创建或显式导入的会话。导入已有会话时选择本地 Pi 会话文件并核对工作目录；P0 不扫描用户全部磁盘。界面可移除项目入口，但保留磁盘项目及会话文件。

首版全应用只允许一个会话运行。可以切换查看其他历史，发送按钮提示当前运行位置；必须等待其结束或停止后才能启动新任务。恢复和切换遇到 Pi 扩展取消时维持原会话，不能只凭命令成功响应切换界面。[S3](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)

### F11 设置范围

| 设置组 | 可操作项 | 生效方式 |
| --- | --- | --- |
| 运行环境 | Pi 入口、配置目录、诊断信息 | 空闲时重连并重新检测 |
| 模型 | 供应商、模型、支持的推理级别 | 输入框模型面板或设置中切换；空闲时生效，运行中禁用 |
| 界面 | 亮暗主题、字号、侧栏宽度 | 即时保存 |
| 项目 | 默认编辑器、文件显示偏好 | 当前项目生效 |
| 本地数据 | 查看存储位置、保留期限、导出诊断 | 导出前预览内容并去除已知凭据 |

### F12 扩展交互

将 select、confirm、input、editor 渲染为应用对话框，响应必须关联原请求 ID；支持取消和超时失效，防止关闭对话框后 Pi 永久等待。notify 和状态消息显示于会话内，长内容可以展开。[S5](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-extension-ui.md)

RPC 无法完整呈现依赖终端自定义组件的扩展。发现已知不兼容能力时标记受限并给出终端使用入口；未知能力先记录诊断，不宣称全部插件兼容。首版复用已配置的扩展，不在 GUI 内安装扩展或管理 MCP 服务。[S5](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-extension-ui.md)

新项目的执行说明只在首次启用时展示，并记录该项目的确认状态。信任也允许加载项目配置、Skills 和扩展；扩展代码可以直接执行，不受工具只读模式限制。Pi RPC 启动无法展示项目信任窗口，因此已信任项目的每次进程启动使用原生 `--approve` 传递本次信任；未信任项目仍禁止连接。扩展交互请求继续按原请求处理。

## 9 工程实现建议与数据边界

建议采用 Electron、React 和 TypeScript。界面渲染放在 renderer；文件读取、Git、配置检查和进程管理放在主进程或独立服务，通过窄接口通信。Pi 以独立子进程运行 RPC，便于处理崩溃和重连。[S2](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)[S9](https://www.electronjs.org/docs/latest/tutorial/process-model)

| 模块 | 职责 | 首版实现约束 |
| --- | --- | --- |
| 桌面界面 | 导航、对话、差异、设置 | 不直接获得文件系统或进程 API |
| 应用服务 | 项目索引、草稿、Git 与文件预览 | 参数校验、路径约束、异步 I/O |
| Pi 适配层 | 版本检测、命令请求、事件归一化 | 独立于 UI；按验证过的版本启用能力 |
| Pi 子进程 | 模型请求、工具执行、会话保存 | 显式 cwd；单会话独立进程生命周期 |
| 本地存储 | 项目索引、偏好、临时差异基线 | 索引原子替换；凭据不进入应用索引 |

### 协议契约

RPC 使用严格 LF 分隔的 JSONL，stdout 持续读取，stderr 单独记录诊断；用唯一请求 ID 匹配响应。采用经过版本校验的 RpcClient 或等价适配，不能解析终端彩色文字。先订阅事件再发送请求，避免遗漏快速完成。[S2](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)

适配层只暴露 startSession、sendPrompt、steer、followUp、stopAll、readState、switchSession 等应用意图。消息用 Pi 返回的身份与最终消息替换增量缓存；队列用完整队列事件覆盖。进程重启后重建状态，旧进程事件不得更新新会话。

### 本地数据与权限

应用索引与草稿放在 userData，Pi 会话和认证沿用所选 Pi 目录。API Key 和 OAuth 内容不得写入项目仓库、URL、命令参数或渲染进程持久化存储。首版复用 auth.json 属于现有 Pi 存储机制，不能描述为系统加密保险库。[S6](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/providers.md)[S11](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/configuration.md)

运行差异基线仅保留最近 7 天且总计不超过 200 MiB，过期自动清理不影响项目文件。模型请求由 Pi 发往已配置服务商；默认不上传应用使用遥测，诊断导出须明确列出将包含的本地信息。

Electron 启用 contextIsolation、关闭 renderer 的 Node 集成，并限制 IPC 能力；模型生成的 Markdown 需过滤主动脚本和危险链接。Pi 进程仍使用启动用户的系统权限，进程分离不等同于文件或网络沙箱。[S8](https://github.com/earendil-works/pi#permissions--containerization)[S10](https://www.electronjs.org/docs/latest/tutorial/security)

## 10 核心功能验收用例

以下用例均为发布前必须执行的验收计划，尚未代表应用已经实现。A01 至 A14 为 P0；每项需要保存结果、关键日志或截图。

| 编号 | 场景与操作 | 通过条件 |
| --- | --- | --- |
| A01 | 全新 GUI 配置启动，指定已安装的 Pi | 正确显示入口与版本；缺失依赖有可执行的修复指引 |
| A02 | 已有 Pi 凭据，选择模型并测试连接 | 请求真实完成后才显示可连接；无效凭据展示明确失败 |
| A03 | 添加带中文及空格路径的 Git 项目 | 正确设定 cwd，读取、修改和执行命令都发生在目标项目 |
| A04 | 完成读取、改代码、运行测试的一轮任务 | 流式内容、工具过程、命令结果和实际文件一致 |
| A05 | 运行中分别发送补充和后续任务 | 队列状态与 Pi 一致；后续任务不会提前被标记执行 |
| A06 | 存在队列时点击停止全部 | 队列文本可恢复；当前任务停稳；不会继续自动运行队列 |
| A07 | agent_end 后紧接自动重试或压缩 | 不提前显示本轮已结束；最终依据稳定结束事件更新 |
| A08 | 引用文件删除、过大、为二进制或链接越界 | 说明被拒原因并保留草稿，不发送未确认或错误文件 |
| A09 | 运行前已有未提交修改，运行中再手动编辑 | 已有修改持续标记，差异不被全部归因给 Pi，无隐式撤销 |
| A10 | 关闭后重开并恢复会话 | 历史与项目关联正确，草稿恢复，不自动重放最后任务 |
| A11 | 切换会话被扩展取消 | 保持原会话，界面明确提示取消，历史内容不串会话 |
| A12 | 扩展提出选择、确认、输入和超时请求 | 回复关联正确 ID，取消可收尾，超时后不能提交过期回复 |
| A13 | 一个会话运行时在另一个会话尝试发送 | 阻止第二次运行并可跳到当前任务，两个草稿分别保存 |
| A14 | 初始无提交仓库和非 Git 目录 | 分别正确显示新增基线或降级提示；对话仍可正常使用 |

## 11 质量目标与产品边界

### 异常与体验验收

| 指标 | 目标与测试条件 |
| --- | --- |
| 启动 | Windows 11、16 GB 内存、SSD；已有配置时冷启动到可交互 p95 ≤ 3 秒，独立记录 Pi 启动耗时 |
| 界面反馈 | 本地点击和输入反馈 p95 ≤ 100 毫秒；收到模型增量到显示 p95 ≤ 100 毫秒 |
| 长会话 | 1,000 条消息可浏览，流式输出时无明显输入阻塞（历史消息按 80 条分页加载） |
| 停止与崩溃 | 停止中持续反馈；子进程被结束后状态正确；异常退出恢复时不重复发送任务 |
| 网络与错误 | 离线、401、429、请求超时与 stderr 输出分别归类，历史内容和未发送草稿不丢失 |
| 可访问性 | 键盘可完成核心流程；200% 字号仍可操作；焦点可见，状态不只用颜色表达 |

性能以发布构建测量，每个本地延迟场景至少 30 次。模型首字延迟、总运行时长及 token 用量单独展示；费用仅在 Pi 返回有效估算数据时显示，并标明估算口径。

### 产品边界

保持连接用户已安装的 Pi、中文界面、单会话运行。不内置 Pi，不做多会话并发、代码提交与推送、远程访问。跨平台安装包已在 v0.6.0 完成（macOS 暂未签名）。

## 12 官方资料与版本依据

核对日期为 2026 年 10 月 11 日。官方仓库现为 earendil-works/pi，包名为 @earendil-works/pi-coding-agent；本方案选取 v1.1.0 作为首版适配基线。版本升级必须重新运行协议和生命周期验收。

接口细节引用 v1.1.0 文档。权限说明与 Electron 文档为核对时在线版本。文件差异、项目导航、窗口布局、数据保留和性能目标属于本产品设计，不是 Pi 已提供的完整桌面功能。

- [S1 Pi v1.1.0 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.1.0)
- [S2 Pi RPC 接入与生命周期](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)
- [S3 Pi RPC 命令参考](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)
- [S4 Pi JSON 事件流](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/json.md)
- [S5 Pi RPC 扩展界面与限制](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-extension-ui.md)
- [S6 Pi 凭据与认证](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/providers.md)
- [S7 Pi Windows 运行环境](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/windows.md)
- [S8 Pi 权限边界](https://github.com/earendil-works/pi#permissions--containerization)
- [S9 Electron 进程模型与 IPC](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [S10 Electron 安全实践](https://www.electronjs.org/docs/latest/tutorial/security)
- [S11 Pi 配置文件与存储位置](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/configuration.md)

### 文档维护

文档维护：仓库 docs/PRD.md 为可版本化正文，docs/assets 保存线框图；Word 版本用于阅读和批注。功能范围或协议基线变化时，两种文档应同步更新。
