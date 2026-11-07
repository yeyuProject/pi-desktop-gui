# T1 团队协作实现与验收

范围：`docs/PRD.md` 的 T1，基线 v0.14.71（`c12a2b4`）。不包含 T2、worktree、成员间通信、递归分派、无人值守调度或自动合并。保留原 PRD 草案，新增实现状态与本记录；没有发布版本或更改版本号。

## 实现入口

- 共享契约：`shared/team.ts`；角色文件：`electron/team-roles.ts`。
- 调度：`electron/team.ts`，进程继续由 `SessionAgents` / `AgentService` 管理。
- 模型工具与成员限制：`electron/pi-team.ts`；配套扩展协议 5。
- 团队卡、团队条、成员横幅与角色管理：`TeamCard.tsx`、`TeamStrip.tsx`、`TeamBanner.tsx`、`RolesTab.tsx`。
- 成员审批只订阅 `dialogs` 引用：`useTeamApprovals.ts`。未完成调用的离线占位：`src/lib/team-transcript.ts`。
- 测试：`tests/team*.test.ts`、`scripts/test-team.ts`、`scripts/test-team-ui.mjs`、`scripts/test-team-performance.mjs`。

## 逐项验收（PRD 1–22）

| # | 结果与证据 |
| --- | --- |
| 1 | 真实 Pi `resources` 与 provider tools：默认隐藏；开启后出现团队工具；成员不含团队/Goal/提问。命令查询不请求模型。 |
| 2 | 三只读成员、上限二：第三个排队后自动启动；两可写成员串行。调度单测另覆盖两个负责人共享槽位、未结束检查点不释放槽位。 |
| 3 | 三个独立正式成员与原生 JSONL 文件；UI 从审批“在成员中查看”进入真实成员历史，再返回负责人。侧栏按负责人分组。 |
| 4 | 同回合汇总，负责人仅一条用户消息，原计划 `turnId` 和内容不变；UTF-8 50 KiB 截断在真实 Pi 与单测均验证，全文保留成员文件。 |
| 5 | UI 两页处理同一审批后均消失；通知标题和操作说明断言通过，点击跳转仍沿用负责人入口。 |
| 6 | 只读负责人分派 worker 返回错误且不创建成员；只读成员伪造 bash 调用被拒绝，目标文件不存在；审批策略与角色白名单双层限制。 |
| 7 | 停止负责人返回 cancelled 并保留已完成成员汇报；全部停止后负责人继续；UI 单个停止不取消其他结果；排队取消不启动。强制停止、退出等待检查点清理另有单测。 |
| 8 | 单成员预算收尾、额外三次请求硬限、成员后续独立追问、Goal 合计用量和 Goal 暂停传播通过真实 Pi。零剩余额度不启动成员有单测，并通过真实 Pi 验证负责人本次回复已经耗尽 Goal 额度时不再启动成员请求。 |
| 9 | 成员 write 与 bash 修改均出现在负责人检查点；负责人恢复两文件后，旧成员预览的再次恢复被 revision 保护拒绝。团队结果含两文件、+2 行。 |
| 10 | 真实负责人进程退出会停止成员并标记 interrupted；UI 用真实原生历史构造“调用已写入、结果未写入”的中断切点，重启显示已中断且不连接 Pi、不续跑。非整机掉电测试。 |
| 11 | 角色信任/优先级/revision/路径保护单测；真实项目角色首次和内容变化后二次确认；冻结原定义，模型不可用回退并返回提示。 |
| 12 | UI 删除成员后仍显示汇报、打开禁用；删除负责人提供两种选项，级联删除不影响克隆会话。 |
| 13 | 真实同一回合第四次分派返回上限错误，会话数不增加。 |
| 14 | 运行成员纳入 `hasPendingWork` / `requiresStopConfirmation` / 项目 busy；退出等待清理有调度单测；现有更新 UI 的任务/审批安装阻塞回归通过。 |
| 15 | 每行图标与文字、排队原因和等待确认动作有 UI 断言；动作取审批、进行中计划、运行工具、撰写汇报；团队条排队数不算运行数。 |
| 16 | 行展开显示任务与最近八项动作；真实 UI 切换/重启保留行展开；Space/Enter 展开收起。 |
| 17 | 正常和“全部停止”均自动折叠；汇报默认收起、40 行折叠；凭据错误转换为中文错误，失败行默认展开且可手动收起；截断标识由共享结果校验保证。 |
| 18 | 团队条存在、状态“等待成员 0/3”、等待确认优先、“查看”滚动并展开、结束后消失均有 UI 断言；普通计划保留另有真实 Pi 测试。 |
| 19 | “此成员总是允许”在成员 runtime 新增一个授权，负责人 runtime 仍零授权；成员详情和负责人页面均消失，放行提示保留来源与撤销路由。 |
| 20 | 成员审批发一次带来源通知；完成不新增通知有 UI 断言。成员失败通知在主进程同一成员分支直接抑制；负责人继续使用原完成/失败通知规则。 |
| 21 | 历史汇报 UI 查找与离线任务/成员名索引单测；成员失败结果不标负责人轮次失败，成员增删行数不加负责人轮次计数。 |
| 22 | 3/6 个成员持续流式输出，负责人消息节点数不变；摘要最多 1 Hz。三种风格、窄窗口与 150% 缩放无卡片横向溢出；主题边框使用现有 `--line` 变量并有 1px 断言。 |

其他边界：成员创建保存失败不启动；结束保存失败返回可恢复结果而不是挂起负责人；残留命令未确认结束时仍占写槽位；旧 toolCallId 的取消不作用于新分派；用量只接受单调非负整数；排队成员不能提前连接，收尾中的成员不能抢先开始下一任务；角色编辑/删除的外部 revision 冲突与链接目录保护；成员不启用 Goal；角色 CRUD 和默认设置真实 UI 通过。

## 执行记录

环境：macOS arm64，Pi 1.4.0（仓库锁定依赖），未修改 Pi CLI，本地 OpenAI-compatible provider，`PI_OFFLINE=1`，独立测试数据与项目。不是云供应商账单或线上模型质量测试。

通过入口：

```sh
npm run build
npm run lint
npm run format:check
npm test
npm run test:integration
npm run test:goal
npm run test:features
npm run test:team-ui
npm run test:team-performance
node --import tsx scripts/test-plan-ui.mjs
node --import tsx scripts/test-approval-ui.mjs
node --import tsx scripts/test-update-ui.mjs
npm run package:dir
```

- 完整单测：865 项，863 通过，2 项按平台跳过，无失败。
- `test:integration` 已接入团队真实 Pi 脚本；`test:chat-ui` 已接入团队 UI 脚本。可分别使用 `test:team` / `test:team-ui`；性能入口 `test:team-performance` 单独执行。
- Mac 目录包位于 `release/mac-builds.noindex/mac-arm64/Pi Desktop.app`，构建签名完整性检查通过。指定 `PI_DESKTOP_EXE` 对目录包运行同一团队 UI 套件，使用 fixture 的 `PI_DESKTOP_DATA_DIR`，退出后调用 `unregisterMacTestApp`。未运行或替换 `/Applications/Pi Desktop.app`。
- 本轮没有执行 Windows/Linux 的团队 UI；新增入口会在既有 CI 套件运行。不能将本地 Mac 通过表述为三平台已验收。
- 截图：`test-results/team-{running,expanded,done,strip,approval,narrow}-{classic,codex,claude}.png`。原始性能数据：`test-results/team-performance.json`。这些是本地忽略的测试产物，不作为发布资产。

## 性能采样

每组约 4.11 秒：每个成员 75 次流式片段、间隔 40 ms，然后观察一秒。测量发生在全部成员已启动之后，不包含 Pi 冷启动峰值。CPU 为主进程单核占比，内存为主进程 RSS，不包含各 Pi 子进程；renderer Task 是 Chromium 累计任务时间，不是 React 单次 commit。参数固定，数字仅为本机采样，不是跨设备性能保证。

| 成员数 | 主进程 CPU | 主进程 RSS | renderer Task | Layout | Style | 帧间隔 P95 | >50ms 长任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 2.39% | 168.78 MiB | 299.56 ms | 3.89 ms | 52.04 ms | 17.6 ms | 0 |
| 6 | 3.06% | 174.44 MiB | 316.78 ms | 4.05 ms | 52.02 ms | 17.7 ms | 0 |

两个阶段负责人挂载消息节点分别固定为 3 和 6（第二阶段包含前一轮），没有随成员内容增加。纯文字流期间摘要字段不变，实际发送的 team 补丁为 0；这验证了摘要去重，不代表没有执行主进程的 1 Hz 聚合计时器。状态和动作变化由功能/UI 测试覆盖。

## 已修正的问题与限制

回归暴露并已修正：bridge fixture 非成员钩子覆盖、forceStop 取消代次时序、dispose 关闭时机、ChatMessage memo 遗漏团队依赖、设置对象引用导致误报未保存、无结果历史卡缺失、保存失败挂起、强制停止未传播、shell 变更统计遗漏、未确认命令清理前释放槽位、团队卡主题变量错误、排队被计作运行、失败行不能收起、Goal 已耗尽额度仍可能启动成员、收尾成员被空闲回收或抢先开始新任务。

只承诺现有桌面安全边界：不是 OS 沙箱，不自动处理脱离进程树的服务；文本增删统计受现有 Diff 的二进制/大小限制；非 Git 工作目录仍能协作但没有 Git 检查点级统计。中断不自动续跑，独立成员后续对话不自动同步负责人。T2 仍待后续需求。
