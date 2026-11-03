# 资源占用、交互与文案优化验证

需求来源：本地 `docs/optimization-prd` 分支的 `fa2f199`，代码基线为 v0.14.62（`bd752a7`）。PRD 正文共有 12 项：PF1–PF3、UX1–UX6、CW1–CW3；原简介中的 PF4、PF5 没有对应正文，已更正编号。

环境：Windows x64、Node.js 22.23.1、Electron 44.7.0、Pi 1.4.0。模型测试使用本机 HTTP 服务和未修改的真实 Pi CLI，无远程模型调用。性能结果是本机测量，不作为所有机器的耗时保证。

## 2026-11-03 复查修正（未发布）

修复分支：`codex/prd-review-fixes`，基于 `origin/main` 的 `c6cc979`。本次未实现命令进程记录，未放宽意外退出后的任何重连或文件恢复检查。

| 复查问题 | 本次处理 | 检查位置 |
| --- | --- | --- |
| 崩溃卡重新检查无效 | 按确认的方案 2 删除按钮、方法和 IPC；提示先手动结束命令，再重启应用；明确仅重启不会结束旧命令 | `test-optimizations-ui.mjs` 检查按钮不存在、重连和撤销禁用；`rpc-close.test.ts` 检查真实根进程退出后仍禁止连接、恢复 |
| 设置保存失败仍报成功 | `saveSettings` 返回保存结果；保存请求失败时不显示“已保存” | 优化界面测试在没有未保存改动时拒绝保存，确认错误和保存提示不会同时出现 |
| 空闲时勾选自动更新就重启 | 只在勾选后从忙转为空闲时启动倒计时 | 优化界面测试等待超过五秒，确认空闲勾选不安装；下一次任务结束后才安装 |
| 发送按钮说错原因 | 分别说明切换会话、存储不可写、命令未确认和项目未启用；定位存储入口或崩溃卡 | 优化界面测试检查只读存储、未确认命令的文案及焦点 |
| 完整日志停止刷新 | 运行时直接显示最新已收到的输出，不缓存点击时的内容、不增加轮询；结束后读取会话里的完整结果 | 优化界面测试检查点击后的追加内容、最终内容和完整复制；运行期间说明完整结果尚未保存 |
| 外部编辑读到旧草稿 | 快捷键先等待 `flushDraft`，再打开编辑器；会话改变时不继续打开旧会话 | 优化界面测试在最后一次输入的 200 ms 防抖结束前按快捷键，检查主进程收到最新草稿 |
| 历史默认标题不再自动改名 | 恢复对“新对话”和“新会话”两个历史默认标题的判断 | `session-activity.test.ts` 通过真实 Store 和 AgentService 首次发送路径检查两个标题 |
| 崩溃后恢复副本残留 | 空闲清理移除旧运行留下的 UUID 备份目录，保留本次运行仍可还原的副本；不跟随目录链接 | `checkpoints.test.ts` 检查旧副本清理、当前副本仍可还原、目录重定向不会删除目标文件 |
| 运行中的文件刷新过快 | 最小间隔改为两秒，统一 PRD 方案和验收标准 | `workspace-watch.test.ts` 连续事件和精确计时检查 |
| 工具位置仍全量计算 | 复用已有位置；仅文本更新时不重新检查已结束的消息 | `tool-order.test.ts` 对照完整计算，并检查文本更新不读取前 5,000 条消息 |
| 消息缓存保留旧数组 | 变更提示改用弱引用，避免每次更新把所有旧版本数组串在一起 | `history-memory.test.ts` 在启用真实 GC 的独立 Node 进程里连续更新 200 次，检查原始和派生旧数组可释放，当前结果保持正确 |
| 英文错误和旧提示 | 共用用户提示映射；原始错误保留在诊断；重试提示使用原因分类；项目启用、停止及退出说明统一 | `errors.test.ts`、`retry-notices.test.ts`、lint、优化界面测试 |

性能复测使用同一个 `test-performance-ui.mjs`，原始基线为 `fa2f199`。5,000 条消息场景预热五次后连续测 200 个 patch；除原有“分发 IPC 到下一帧”外，新增 CDP `ScriptDuration` 差值，直接记录渲染进程 JS 时间。测量时暂停测试自身遍历 React Fiber 的组件计数；功能检查时重新开启。两种时间不能混用。

| 5,000 条普通消息场景 | 原始基线 | 本次修正后 | 结论 |
| --- | ---: | ---: | --- |
| 渲染进程 JS 时间 P95 | 18.34 ms | 18.59 ms | **未达到降至 1/3 的要求**；目标小于 6.11 ms |
| IPC 到下一帧 P95 | 29.30 ms | 44.30 ms | 本轮结果有波动，不能宣称更快 |
| 强制 GC 后渲染堆内存 | 11.22 MiB | 10.63 MiB | 当前旧数组已可释放；修弱引用前的本轮记录为 18.85 MiB |
| 超过 50 ms 的长任务 | 2 次（70、52 ms） | 2 次（69、65 ms） | 仍存在长任务，不能宣称已消除 |

原始记录在忽略的 `test-results/performance-ui-review-{before,after}.json`；弱引用修正前的记录为 `performance-ui-review-before-weakref.json`。这些新数字不替换下方发布时使用不同样本数的历史数字。当前主 JS 为 649.27 KB（未 gzip），仍低于 650 KB。

**仍未完成：** PF3 的 JS 时间和长任务目标，命令进程记录（已明确推迟，单独设计）。命令结束时监听事件可能尚未到达、系统审批通知早于卡片渲染、`npm ci` 引起全量扫描三项仍属未复现风险，不算验证通过。CW1 本次检查的是上述主要错误出口，不能据此宣称所有扩展和所有错误都已逐一覆盖。

本轮验证：

- `npm run build`、`npm run lint`、`npm run format:check`、`git diff --check` 通过。
- 最终源码的全量 Node 测试共 828 项：819 通过、8 跳过，一项仍匹配旧的“信任”文案而失败。将该项改为匹配“请先启用项目”后，单项补跑通过；未改禁止执行 Git 配置、文件标记不存在及启用后可执行的检查。合计 820 项通过、8 项平台跳过；不是一次全量运行全绿。
- `test-optimizations-ui.mjs` 的 11 组检查通过。ANSI 更新提交 P95 为 9.7 ms；100 KB 粘贴片段后连续输入 50 键产生两次草稿保存。文字剪贴板使用下文说明的测试替身。
- `test-recovery-ui.mjs` 通过真实 Pi 崩溃、刷新后仍禁止重连/撤销、明确恢复、真实磁盘写失败拒绝发送，以及索引损坏/缺失恢复等六组检查；残留命令的确认结果没有替换为成功。
- `history-memory.test.ts` 在独立进程启用真实垃圾回收，验证旧消息数组可以释放；历史派生、工具位置、运行补丁共 20 项针对性测试通过。`rpc-close`、IPC 策略及会话相关 45 项检查通过。
- `test-performance-ui.mjs` 的界面功能检查通过，**性能验收没有通过**，见上表；不把脚本退出码为零当作 PF3 已完成。新增计时只记录结果，没有悄悄放宽性能要求。

## 2026-11-03 测试连接错误分类修正（未发布）

`e15958e` 将抛出的 IPC 错误统一转换为用户提示，使设置页无法再从英文原始原因识别模型错误。本次在 `testConnection` 的 IPC 处理函数内完成分类：成功返回 `{ ok: true, elapsed, text }`，失败返回 `{ ok: false, error, details }`；`error` 沿用现有标题、说明和错误分类，`details` 为经过 `redact` 的原始原因。失败日志包含会话 ID 和经隐藏密钥处理的堆栈。设置页直接使用返回的标题和说明，不再对统一提示重新分类；普通参数验证仍由原 IPC 错误处理完成。

新增 `npm run test:connection-ui` 并加入 Linux CI，使用真实 Electron IPC、未修改的 Pi 和临时本地 HTTP 模型服务，未替换连接测试的结果。覆盖：

- `401 invalid x-api-key` → “供应商拒绝了凭据”。
- 模型服务返回 `Request timed out` → “无法连接模型服务”。
- `429 rate limit` → “请求过多或服务繁忙”。
- 未知模型错误 → “模型请求失败”，复制详情仍保留原始原因。
- 四种失败均检查 IPC 分类、界面说明、复制内容和诊断日志；复制结果与日志不能含测试密钥。
- 失败后再次成功连接，显示耗时与 `OK`，清除旧错误详情；错误参数仍由原 IPC 验证拒绝。

本机该项测试通过（五次本地模型请求，无界面异常）；构建、lint、项目格式检查及错误分类、Pi 兼容、会话保存/取消和 IPC 策略相关的 77 项测试通过。文字剪贴板仍使用明确启用的测试替身，只证明复制内容经过真实 IPC 传递，不当作本机系统剪贴板回读证明。Linux CI 已增加该检查，本轮尚未在 CI 中运行。

## 验证结果

**2026-11-03 复查更正：以下是 v0.14.64 发布时的历史结果，不代表本节全部验收通过。** 原优化界面测试把 `recheckCrash` 替换为直接返回 `confirmed`，只能验证界面表现，不能证明残留命令已退出。保存设置只测了成功路径；更新测试错误地认可了空闲时立即倒计时；完整日志只测了结束后的单次读取；外部编辑快捷键和旧标题没有覆盖。PF3 的 5,000 条消息普通更新也没有达到降至原来三分之一的目标。此前“已实现”的标记过早。

- `npm run build`、`npm run lint`、`npm run format:check`、`git diff --check` 通过。
- `npm test`：819 项，811 通过、8 跳过，无失败。Node 测试文件并行限制为四个；大仓库检查点文件的总超时为十分钟，内部业务等待和断言没有放宽。原始基线在默认并行下曾出现文件超时和差异计算超时。
- integration、features、goal 的真实 Pi 测试通过。features 中因文案变化中断的部分更新断言后按脚本继续执行，包含审批、崩溃、检查点、重试和普通计划。
- 原有 UI、features UI、chat UI、Goal UI、图片、滚动和性能测试通过；其中部分套件按脚本分别执行。后续文字剪贴板相关检查使用下文明确说明的测试替身。
- 新增优化界面十组检查通过，包括保存与切换、原生菜单首次编辑、关闭前保存、审批焦点、崩溃卡界面（残留命令确认被替换，不能算真实检查）、撤销放行、更新取消、设置保存成功状态、已结束日志的完整读取和三套外观截图。
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
| UX5 | 崩溃详情折叠；单个主按钮；设置保存状态；危险操作分组；取消清理不提示已执行。11-03 修订：移除无效重新检查入口，未确认时继续禁止重连和撤销 | 恢复界面、优化界面、placeholder 生命周期、`rpc-close.test.ts` |
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
