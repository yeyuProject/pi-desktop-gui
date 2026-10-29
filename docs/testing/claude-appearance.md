# UI9 Claude 外观验证

2026-10-29，macOS arm64，Electron 44.7.0。范围为 UI9；H1 未纳入本次实现。

## 实现与基线

- `82ce315` 先完成风格表重构，仅包含经典与 Codex。设置标签、主题限制、错误提示和原生色板都从共享风格表读取。之后新增 Claude。
- 经典基线沿用 `tests/fixtures/classic-style.json`，未重录。Codex 基线在修改渲染器前，从 `main@f1eb0cd` 的构建录入 `tests/fixtures/codex-style.json`。
- 两份基线均对比浅色、深色的九组关键元素，每组覆盖文字、背景、边框、阴影和圆角；重构后及加入 Claude 后完全一致。
- Claude 的字体覆盖只作用于该风格。回复正文为 `15px × --font-scale`，代码、表格和思考过程使用各自的界面／等宽字体，经典与 Codex 原有消息字体不变。
- 截图检查发现侧边对话压缩输入区后，模型按钮会超出输入框；Claude 的工具栏增加换行与宽度限制，测试同时检查输入框及工具栏的实际滚动宽度。
- 跨平台截图快捷键按模拟桌面的平台选择；聊天测试先悬停折叠目录的可见刻度，再操作展开后的行按钮，保留真实鼠标命中检查。

基线 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `classic-style.json` | `7f2dbd3892abd54685bc3f22632519318516791610226b461e6bceef6f6a2069` |
| `codex-style.json` | `a12bdd93aa273a1fa79b8f74bec20fafa0d6729e892ffb5c0be4cf31ad2cd197` |

## Electron 实测

`npm run test:style-ui` 分别运行 Codex、Claude，浅色和深色各检查 58 组对比度：55 组文字／语法／按钮文字，以及 3 组填充／焦点。`--primary` 仅作填充色，CSS 测试禁止将其用于文字。

| 风格 | 模式 | 文字最低对比度（要求 ≥ 4.5） | 主色对画布／表面最低对比度（要求 ≥ 3） |
| --- | --- | --- | --- |
| Codex | 浅色 | 4.5043 | 19.4355 |
| Codex | 深色 | 4.8138 | 14.3834 |
| Claude | 浅色 | 4.6113 | 4.4482 |
| Claude | 深色 | 4.5425 | 4.2362 |

- 检查珊瑚主按钮、蓝色交互、绿色完成／新增、选中会话、用户气泡、可访问角色名称、键盘焦点、输入框阴影和运行边框。
- 检查回复衬线字体、代码等宽字体、思考与工具卡界面字体、表格字体，以及设置滑块在 100% 和 200% 下的实际字号。
- 检查长提问折叠／展开、技能、引用、文件、图片、超宽代码、Goal、审批、侧边对话、窄窗口和 Claude 输入框的横向溢出。
- 用媒体模拟验证显式深色与跟随系统深色的全部采样令牌一致；原生主题测试使用 Electron 的实际系统外观，不修改宿主外观。
- 已逐项查看 Claude 浅色／深色的工作区、设置、命令面板、Goal、差异、模型选择器、侧边对话和审批截图，共 16 张；另生成 16 张 Codex 自动验收截图。记录在 `test-results/{codex,claude}-style-ui.json`，截图为 `test-results/{codex,claude}-{light,dark}-*.png`。
- README 的两张 Claude 图片由独立模拟工作区生成，1440 × 900 @2x，保存于 `docs/assets/screenshots/`。

## 验证命令

```sh
npm run build
npm run lint
npm run format:check
npm test
npm run test:integration
npm run test:features
npm run test:style-ui
npm run test:theme-ui
node --import tsx scripts/test-review-ui.mjs
node --import tsx scripts/test-conversation-v014-ui.mjs
node --import tsx scripts/test-chat-ui.mjs
```

最终全量单元测试以并发数 2 运行同一组测试文件，752 项中 750 项通过、2 项按平台跳过：

```sh
node --import tsx --test --test-concurrency=2 --test-timeout=120000 tests/*.test.ts tests/*.test.mjs
```

构建、lint、格式、集成测试、功能测试、风格验收与对话回归已通过。原生外观及 macOS 更新组合测试曾完整通过；后续本机重复运行出现截图超时或原生剪切未执行。完整聊天脚本也遇到模型列表／悬停时序失败，三平台 CI 仍是正式发布前的完整回归门槛。

默认并发运行曾出现未修改的 Diff 耗时测试超时，以及原生文件监听测试漏收首个文件事件；未修改这些模块或放宽断言。限制并发后完整通过。早期 Electron 截图也曾超过 15 秒，完成运行的截图与对比度报告保存在 `test-results/`。macOS 更新验收的文件监听超时经独立重跑后通过，安装、失败回滚和退出不安装均通过；未修改更新代码。

跨平台范围：本机实际执行 macOS 测试；Windows／Linux 原生窗口颜色通过单元测试的跨平台分支验证，实际运行仍由各平台 CI 负责。截图不包含操作系统绘制的原生菜单／窗口按钮，也不作跨平台像素差验收。
