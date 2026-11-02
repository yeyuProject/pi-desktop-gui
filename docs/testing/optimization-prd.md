# 资源占用、交互与文案优化验证

需求来源：本地 `docs/optimization-prd` 分支的 `fa2f199`，代码基线为 v0.14.62（`bd752a7`）。PRD 正文共有 12 项：PF1–PF3、UX1–UX6、CW1–CW3；原简介中的 PF4、PF5 没有对应正文，已更正编号。

环境：Windows x64、Node.js 22.23.1、Electron 44.7.0、Pi 1.4.0。模型测试使用本机 HTTP 服务和未修改的真实 Pi CLI，无远程模型调用。性能结果是本机测量，不作为所有机器的耗时保证。

## 验证结果

- `npm run build`、`npm run lint`、`npm run format:check`、`git diff --check` 通过。
- `npm test`：819 项，811 通过、8 跳过，无失败。Node 测试文件并行限制为四个；大仓库检查点文件的总超时为十分钟，内部业务等待和断言没有放宽。原始基线在默认并行下曾出现文件超时和差异计算超时。
- integration、features、goal 的真实 Pi 测试通过。features 中因文案变化中断的部分更新断言后按脚本继续执行，包含审批、崩溃、检查点、重试和普通计划。
- 原有 UI、features UI、chat UI、Goal UI、图片、滚动和性能测试通过；其中部分套件按脚本分别执行。后续文字剪贴板相关检查使用下文明确说明的测试替身。
- 新增优化界面十组检查通过，包括保存与切换、原生菜单首次编辑、关闭前保存、审批焦点、崩溃重新检查、撤销放行、更新取消、设置保存状态、日志完整读取和三套外观截图。
- 发布复查补充运行 `test:performance-core` 和 `test:style-ui`：三套外观的样式保持检查、Codex 和 Claude 的明暗界面、对比度、布局与无障碍检查通过。素材和样式脚本统一使用“查看项目变更”按钮名称。
- 发布时补充修正外观原生测试的旧预览断言，以及独立 Pi 设置测试缺少的登录回调。`test:pi-settings-ui` 通过；Windows 原生外观、即时保存、字号、菜单和快捷键检查通过，后续原生剪切检查仍受本机系统剪贴板回读为空影响，不能算整套原生主题测试通过。
- Linux 发布检查发现粘贴片段后紧接着打字时，旧的下一帧光标回调会把光标移回前面。光标改为随 React 更新立即设置，并核对会话和草稿修改次数；界面回归同时检查 50 次按键后的文字和光标位置，再检查切换会话后的原文。
- `test-streaming-main.ts`、`test-streaming-ipc.ts`、检查点规模/清理测量、历史派生测量及十二次启动测量完成，数字见下表及原始 JSON。

## 实现和测试位置

| 项目 | 完成内容 | 验证 |
| --- | --- | --- |
| PF1 | 内容块与文字增量；隐藏窗口 500 ms；参数 2,000 字符；工具输出 200 行/64 KiB；运行保存 2 s；去掉 JSON 缩进和重复广播 | `runtime-patch.test.ts`、`live-usage.test.ts`、`test-streaming-main.ts`、`test-streaming-ipc.ts` |
| PF2 | 当前监听项目的脏路径扫描；不确定时全量检查；延后维护；按会话清理；stat 并发 16；三个 LRU 缓存各八项；分块导出缓存 | `checkpoints.test.ts`、`snapshot.test.ts`、`workspace-watch.test.ts`、`test-checkpoint-scale.ts` |
| PF3 | 修复方括号判定；历史和轮次增量计算；草稿防抖；弹层懒加载；工具与思考的渲染上限；去掉遮罩模糊 | `streaming-markdown.test.ts`、`history-derive.test.ts`、性能及滚动界面测试 |
| UX1 | 发送按钮显示具体禁用原因，键盘和鼠标可以到达相应控件 | `test-optimizations-ui.mjs` |
| UX2 | 开始前检查显示真实失败原因；定位 Node 输入框；复制安装命令；登录后刷新模型并选择或打开列表 | 优化界面、功能界面和模型入口测试 |
| UX3 | 离屏审批持续显示提醒；跳转后聚焦允许按钮；提问与审批分别标记 | 优化界面、审批界面和提问界面测试 |
| UX4 | 完成、失败、停止分别标记；项目失败红点；待处理菜单访问后台会话 | 优化界面、会话界面测试 |
| UX5 | 崩溃详情折叠；单个主按钮；重新检查残留命令；设置保存状态；危险操作分组；取消清理不提示已执行 | 恢复界面、优化界面、placeholder 生命周期测试 |
| UX6 | 项目审批方式；撤销放行；运行时补充/排队说明及会话记忆；恢复前副本与逆向恢复；任务后自动更新倒计时 | 检查点、审批、恢复及优化界面测试 |
| CW1 | 系统错误映射；用户提示和原始诊断分开；参数错误分类；连接测试分类；扩展文件名和停用入口 | `errors.test.ts`、模型目录、更新及功能测试 |
| CW2 | 会话、检查点、变更面板、推理级别等统一用词 | [术语表](../glossary.md)、三套外观截图、lint |
| CW3 | 高频提示改写；新增 `pi-desktop/user-copy` 检查 | `user-copy.test.mjs`、lint 和受影响的界面测试 |

## 性能记录

| 测量 | 改前 | 改后 |
| --- | ---: | ---: |
| 首屏 JS（未压缩） | 727.05 KB | 649.08 KB |
| 进程冷启动 rendererReady P95（交替重启，各 5 次） | 750.5 ms | 745.3 ms |
| 2 万文件、100 次 echo，命令前后检查合计 P95 | 1,983.3 ms | 71.8 ms |
| 同一场景每次命令前后 `lstat` 次数 | 40,001 | 1 |
| 关闭监听后的全量检查耗时 | 1,696.4 ms | 983.9 ms |
| 50 会话 × 20 轮 × 5,000 文件，启动前十秒 RSS 增量 | 240.9 MiB | 0.2 MiB |
| 同一场景启动前十秒最长事件循环延迟 | 1,986.9 ms | 13.3 ms |
| 200 次工具调用 Goal 的 state 广播 | 31 | 4 |
| 参数准备阶段 IPC 字节/秒（真实 Pi，200 KB write） | 2,056,529 | 49,789 |
| 同一场景 flush P95 | 2.880 ms | 0.304 ms |
| 1,000 条消息派生 P95（不含 React/DOM） | 1.152 ms | 0.061 ms |
| 10 KB 方括号 Markdown，IPC 到下一帧 P95 | 34.2 ms | 16.2 ms |
| 同一 Markdown 场景记录到的长任务 | 1 次，76 ms | 0 次 |
| 50 KB 文字的 200 次增量 patch 合计 | 未测 | 92,355 字节 |
| 100 KB 粘贴片段后连续输入 50 键，草稿保存请求 | 51 次 | 2 次 |
| 同一输入场景草稿 IPC 字节 | 5,209,548 | 102,236 |
| ANSI 日志尾部更新提交 P95（含测试分发 IPC） | 未测 | 8.3 ms |

参数准备阶段 IPC 下降 97.6%。整轮还包括最终完整工具参数和结果，因此整轮 IPC 从 6,782,797 字节变为 770,223 字节，不能把准备阶段的比例套到整轮。运行期保存间隔超过 2 s；任务开始前必须完成的保存和结束时立即保存单独保留，原始 JSON 的 writes 记录了时间和状态。

state 去重保留了模型、推理级别、审批方式和 `draftGoal` 的变化。它们虽不全是侧栏字段，却被当前输入框使用；忽略 `draftGoal` 会让保存目标后仍停在编辑模式。显式保存目标的结果还会强制刷新一次输入框，即使上次广播中的该字段恰好也是空值。专门的单测及真实 Goal 界面测试覆盖了这一点。

渲染测量包含测试分发 IPC、React 提交及下一帧，不等于纯解析耗时。性能大脚本的首屏可输入单次为 751.7 ms → 802.6 ms，不能据此判断冷启动。另用 `test-startup-ui.mjs` 交替启动新 Electron 进程，直接截取实际 `rendererReady` IPC：各记录六次，首轮另存，后五次的中位数为 713.6 ms → 720.5 ms，P95 如表；未清空操作系统磁盘缓存。展开 500 条消息和 5,000 条消息的普通更新 P95 接近改前，具体数字均保留，未把这些场景宣称为更快。

检查点启动测量在独立 Node 进程生成真实的增量检查点文件，按主进程触发时机模拟清理；实际主窗口的 60 s 延迟及任务运行时推迟由 `placeholder-lifecycle.test.ts` 执行生产回调验证。测量代码不启动模型或窗口。完整清理按会话进行，清理阶段的峰值和延迟另外记录在 JSON 中，不能与前十秒混用。

原始结果位于忽略的 `test-results/`：`streaming-main{,-before}.json`、`streaming-ipc{,-before}.json`、`checkpoint-scale{,-before}.json`、`checkpoint-cleanup{,-before}.json`、`history-derive.json`、`performance-ui{,-before}.json`。三套外观截图为 `optimizations-{classic,codex,claude}.png`。

启动明细为 `startup-ui.json`，含全部十二次记录；重复测量存在波动，结论是未观察到明显变慢。草稿对比为 `draft-ipc.json`，初次编辑的立即保存也计入次数。

## 复现

```powershell
npm run build
npm test
npm run lint
npm run test:integration
npm run test:features
npm run test:ui
npm run test:features-ui
$env:PI_DESKTOP_TEST_CLIPBOARD = 'memory' # Only when the OS clipboard is unavailable; see below.
npm run test:chat-ui
npm run test:optimizations-ui
npm run test:performance-ipc
npm run test:checkpoint-scale
$env:PI_SCALE_PHASE = 'cleanup'
node --expose-gc --import tsx scripts/test-checkpoint-scale.ts
Remove-Item Env:PI_SCALE_PHASE
node --import tsx scripts/test-history-derive-benchmark.ts
npm run test:performance-ui
node --import tsx scripts/test-startup-ui.mjs
Remove-Item Env:PI_DESKTOP_TEST_CLIPBOARD
```

基线测量使用系统临时目录中的独立 worktree，固定到 `fa2f199`。`PI_CHECKPOINT_SOURCE` 和 `PI_STREAMING_SOURCE` 指向基线；`PI_SCALE_RESULT`、`PI_STREAMING_RESULT` 指定输出文件。所有生成的大仓库位于系统临时目录，结束时删除。

渲染基线用 `PI_PERF_APP_ROOT` 指向旧版已构建应用，测试数据仍生成在当前仓库的忽略目录，避免 Windows 的 Git 路径长度限制。

测量后的基线 worktree 清理被自动审批以 `blocked by policy` 拒绝，非递归删除依赖目录链接也被拒绝。该 worktree 暂时保留在系统临时目录 `pi-prd-baseline-25562e8ae888471094562bbffcb2fb22`；主项目依赖及其他 worktree 未删除。

## 保存与恢复的检查

- 草稿覆盖文字、图片、引用、100 KB 粘贴片段；包括 Ctrl+N、外部 IPC 选中变化、正常退出、磁盘写失败后保留窗口。
- 首次编辑立即送到主进程，其后才防抖。快速输入再清空仍使临时会话转为永久会话；原生“新建会话”和系统通知跳转先等待当前草稿。原生菜单的首条草稿与“清空后再切换仍可找到会话”均有界面测试。
- 导航快照序号、旧回调不能修改新会话、检查点 revision、人工修改归属、重命名、目录 junction、大小写、缺失文件和压缩后历史均保留测试。
- 恢复前副本只在当前应用运行期间有效。还原前再次核对当前文件和分支；恢复后新编辑的内容不会被覆盖。正常退出删除本次运行创建的副本。
- 工具卡按需读取的是 Pi 实际保存的输出；Pi 自身已截断的内容不会被伪装成完整日志，原有日志路径仍可使用。
- 系统错误、英文异常和退出码留在诊断中；更新准备、模型目录读取和切换进程失败均检查了用户提示与原始错误分别保留。

macOS、Linux 的原生窗口和系统通知没有在本机运行。平台相关测试的跳过不能算作这些平台的运行证明。

本机系统剪贴板回读为空：在改前、改后的 Electron，以及 PowerShell 的 `Set-Clipboard` / `Get-Clipboard` 都能复现。后续聊天、渲染界面测试显式设置 `PI_DESKTOP_TEST_CLIPBOARD=memory`，只替换测试进程的文字剪贴板，检查复制请求传递的实际文本；不修改产品代码，正常测试默认仍使用系统剪贴板。这里的通过结果不能当作系统剪贴板回读的证明。
