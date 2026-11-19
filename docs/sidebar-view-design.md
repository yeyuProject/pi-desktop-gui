# UI17 侧栏代码设计

需求见 [PRD 的 UI17](PRD.md#ui17-侧栏顶部的显示方式菜单分组排序显示选项自定义分区)。基线是 `v0.14.84`（`c8f6315`）。[设计 review](#设计-review) 记录了两处会影响实际操作的需求冲突。

## 改动范围

| 工作 | 文件 | 估计改动 |
| --- | --- | --- |
| 数据、读档、写入 | `shared/types.ts`、新增 `shared/sidebar-view.ts`、`electron/store-state.ts`、`electron/store.ts`、`electron/main.ts`、`electron/ipc/{handler-context,settings-handlers,session-handlers,session-move,policy}.ts`、`electron/session-lifecycle.ts` | 250–350 行 |
| 侧栏展示和拖动 | `src/components/Sidebar.tsx`、新增 `SidebarViewMenu.tsx`、`Submenu.tsx`、`SidebarSessionRow.tsx`、`src/lib/sidebar-groups.ts`、`src/hooks/useSessionDrag.ts`、`src/styles/shell.css` | 500–750 行，含侧栏原有代码搬移 |
| 命名、设置回写与术语 | `src/App.tsx`、`src/hooks/useWorkbench.ts`、`src/components/WorkbenchDialogs.tsx`、`docs/glossary.md` | 80–130 行 |
| 验收 | 新增 `tests/sidebar-groups.test.ts`、`scripts/test-sidebar-view-ui.mjs`，扩展现有 Store 用例和 `package.json` 的 `test:features-ui` | 300–450 行 |

## 读档和 IPC

- 在 [共享类型](../shared/types.ts) 增加 PRD 定义的 `SidebarView`、`SidebarSection` 和四个可选字段。默认显示方式由 `shared/sidebar-view.ts` 提供，供读取、菜单和测试使用。保持现有索引版本，v1 和 v2 都由 [Store 读档](../electron/store.ts#L285) 进入同一个解析流程。
- [`parseState`](../electron/store-state.ts#L63) 先读取分区，再解析会话。分区按保存顺序保留，重复 ID 取第一条有效记录，坏记录丢弃。名称去首尾空白，长度按字符计算（Unicode 码点，1–40）。会话只保留能找到分区的 `sectionId`，成员行清掉该字段。显示设置逐字段补默认，其他有效字段照常保留；旧索引没有该字段时由渲染端取默认。UI17 字段修正留在内存等下一次正常保存。现有 `repairedSettings` 会触发 [Store 移走 state.json](../electron/store.ts#L184)，这些可直接修正的显示字段不走该分支。
- `Store.createSession` 一次取当前时间，同时写入 `createdAt` 和 `updatedAt`。复制、分支和派发团队成员都用这个创建时间。导入和从 Pi 历史打开新记录走 [`adoptSessionFile`](../electron/main.ts#L768)，优先从文件名取时间；再次打开已经收录的记录时，保留原值。旧会话在读档时优先用合法的 `createdAt`，否则解析文件名 `YYYY-MM-DDTHH-mm-ss-SSSZ_<id>.jsonl`，恢复成 UTC ISO 时间后检查日期有效性，再失败才取 `updatedAt`。跨项目移动只改位置相关字段，原创建时间跟随会话。
- 新 IPC 加入 `ApiMap` 和 [`IPC_POLICIES`](../electron/ipc/policy.ts#L11)，均用 `write`。Preload 已按 `ApiMap` 转发 [`desktop:invoke`](../electron/preload.ts#L3)。主进程校验运行时参数，渲染端用 IPC 结果和已有的 `state` 事件更新页面。

| IPC | 实际写入 |
| --- | --- |
| `setSidebarView(view)` → `StateSnapshot` | 在设置 handler 校验两个枚举和三个布尔值，只改 `settings.sidebarView`。用现有 `stateSnapshot` 生成一次快照，将同一份 revision 用于状态事件和 IPC 返回。现有 [`saveSettings`](../electron/ipc/settings-handlers.ts#L21) 继续处理主题、更新源和代理。 |
| `createSection(name, sessionId?)` → `SidebarSection` | 分区 ID 用 `randomUUID()`，末尾追加。会话菜单传 `sessionId`，校验会话存在且为普通会话或负责人，创建和归入一起写盘。分区达到 20 个时提示「最多可以建 20 个分区」。 |
| `renameSection(id, name)` | 校验分区存在。新建、重命名都用同一套名称规则，与其他分区同名时忽略大小写并提示「已有同名分区」。 |
| `deleteSection(id)` → `{ name, sessionCount }` | 一次保存删除分区并清除所有相关会话的 `sectionId`。界面用返回值提示「已删除分区“{名称}”，{N} 个会话回到原来的分组」。 |
| `setSessionSection(sessionId, sectionId \| null)` | 校验会话存在且为普通会话或负责人，检查目标分区存在。传 `null` 删除字段。写入只涉及侧栏位置，保留项目、工作目录、更新时间和 Pi 连接。 |

保存沿用 [`Store.commitSessionMove`](../electron/store.ts#L422) 的做法。复用现有暂存写入和 `Store.save` 的文件写入队列，侧栏写入和 UI14 的位置提交串行。IPC 先校验输入格式，提交轮到执行时用最新数据校验名称、引用和会话归属，计算这次要改的字段。普通保存如果在暂存期间到达，等该次提交结束后再取快照。落盘成功后只合入当前记录的受影响字段，已经删除的会话不再加入内存，再发状态事件。写入主文件失败时丢掉暂存修改，已有的草稿自动重试继续使用上一次提交的侧栏值。主文件已经写入而备份失败时，沿用 UI14 的成功认定并记日志。测试覆盖同名并发、分区删除与移入交错、写失败与后续草稿保存。

当前选中的空白会话可以出现在 `Store.visibleState` 中，但 [`persistentState`](../electron/store.ts#L552) 会过滤临时会话。显式放入分区时把该会话纳入本次写入，若仍是选中会话，快照也保留其选中 ID。写入成功后从临时集合移除；在 [`hasSessionData`](../electron/session-lifecycle.ts#L4) 把 `sectionId` 计为用户已保存的数据，保护已归入分区的空白会话。创建时间本身不算会话内容。

设置以 `state.settings.sidebarView` 为准，`useWorkbench` 暂存本地尚未完成的选择，界面先显示。快速连续操作按顺序提交，每次把某个字段的变更应用到上次保存成功的值，「恢复默认」作为整组替换。保存成功时把返回的快照交给已有的 `useRuntime.receiveState`。收到相同或更旧 revision 的状态事件时按现有规则忽略。更新已保存的基准时一并移除该次本地变更，避免选项闪回。请求失败后去掉该次变更，保留其他待提交选择，并提示「没能保存侧栏显示方式：{原因}」。设置页仍用自己的表单草稿。

## 计算侧栏列表

`src/lib/sidebar-groups.ts` 提供纯函数 `buildSidebarGroups(sessions, activities, view, sections, now)`。返回置顶组、创建顺序排列的分区、主列表各组及其「更早的会话」。项目区和无会话的项目由 `Sidebar` 继续按 `state.projects` 渲染。

1. 扫描会话，建立会话 ID 到行数据、负责人 ID 到成员列表的索引。成员按现有派发顺序跟随负责人。若原负责人已被删除，保留 [现有侧栏](../src/components/Sidebar.tsx#L384) 的可见行为，该成员仍可打开，仍不能单独放进分区。成员的待确认数和运行状态从同一份索引汇总。
2. 每个会话只进一个顶层位置，优先顺序为置顶组、分区、主列表。全局置顶开启时保留原 `sectionId`，取消置顶或关闭该选项时回到原分区。分区计数按实际显示的负责人和普通会话计数；删除提示则按实际清除的 `sectionId` 数量计数。按此优先级，全局置顶开启时，把置顶会话放入分区只改所属分区，行仍显示在置顶组。该组合的拖放规则见 review。
3. 主列表按项目、时间、状态或不分组渲染。时间排序取相应字段，名称排序按更新时间分天。时间组按本地日历计算天数差（用年月日生成日序号），以 0、1、2–6、7–29、30 天及以上分桶。只在时间模式挂下一个本地午夜的定时器，跨午夜后重算并安排下一次。测试包含跨月和夏令时时钟跳变。
4. 状态顺序为待处理、运行中、未查看、其他。待处理包括本人或成员的待确认，以及 `unread` 且 `lastStatus` 为 `error` 或 `interrupted` 的会话。运行状态用 `busy(activities[id]?.status ?? session.lastStatus)`，负责人包括成员。点击或从搜索进入时，[主进程选中会话](../electron/store.ts#L630) 会清掉 `unread`。Sidebar 对比上一个已显示快照与新的选中会话，仅当此次切换清掉未读且状态分组源于未读时，临时保留该行分组。切走或该会话有真实的状态、待确认变化时撤销保留；未读圆点仍随数据立即消失。若选中成员，展开并定位到其负责人的位置。
5. 组内先排置顶，再按 `updatedAt` 降序、`createdAt` 降序或中文名称自然顺序。名称相同按 `updatedAt` 降序，最终并列沿用输入顺序。中英文混排按 review 中确认的规则实现。项目列表保持添加顺序。旧会话用 [`isOlderSession`](../shared/usage.ts#L122) 的更新时间规则，只用于项目、未分组或状态「其他」。时间组、分区和置顶组直接展示。

`Sidebar` 用 `useMemo` 缓存列表。状态模式依赖 `status` 和 `pending` 的活动索引，`waitingFor` 单独变化时复用原索引引用。列表之外的行徽标也用该活动索引，所以任何模式都能显示待确认和运行状态。现有 [`RuntimeStore`](../src/lib/runtime-store.ts#L36) 已按活动变化发通知，流式文字不改活动索引；全局的 `waitingFor` 供工作区入口继续使用。列表推导按一次扫描加组内排序实现，去掉逐行查全体成员的 `pendingFor` 调用方式。行组件按原有结构搬出，使用已经算好的状态和项目标签；保持 [`App.tsx`](../src/App.tsx#L23) 的 `memo(Sidebar)`，沿用 `useStableCallbacks` 传递新增回调。

## 菜单、折叠与拖动

- `SidebarViewMenu` 由品牌栏按钮打开。按钮用 `ArrowDownUp` 17 px 和 `aria-haspopup="menu"`，设置任一字段偏离默认值时显示 6 px 圆点。主菜单宽 220 px，按按钮右边缘计算位置并限制在窗口内。品牌栏将两个按钮放在同一个操作容器内，容器使用原来的自动左间距，品牌文字在 180 px 下可以收缩省略。保留现有 [会话菜单的定位](../src/components/Sidebar.tsx#L158)；品牌栏没有 `.project-list`。
- `Submenu` 供显示菜单和会话的「放入分区」复用。子菜单固定定位，放在不受父菜单滚动裁剪的容器，优先右侧，空间不足时向左展开，顶部与入口对齐并限制高度。用单个菜单层接管 Esc，子菜单先关闭并把焦点放回该菜单项，第二次 Esc 关闭主菜单并回到触发按钮。鼠标停留 120 ms、点击、→、Enter 都能打开；跨越菜单间隙时允许进入子菜单，离开两者或点击外部时清理定时器。↑、↓ 在当前菜单移动焦点，← 返回上级。单选和分区选择后关闭，多选保持打开。时间模式的旧会话选项保留禁用说明。
- 默认项目布局保留 v0.14.84 的会话区顺序、标签、折叠行为和 `data-drop-target`；新增的显示菜单位于品牌栏。非项目分组在主列表后复用项目操作，项目名行本身不可点击，无折叠箭头和状态徽标，首行「对话」。项目会话的标签优先给标题和操作留空间，最大宽度 40%，标题悬停提示用「标题 · 项目名」。默认团队显示仍用原来的成员折叠行为；关闭时，负责人汇总成员待确认和运行状态，当前选中成员时临时显示成员列表。
- 时间组、状态组和分区把折叠键存到 `pi-desktop-collapsed-groups`，项目沿用 `pi-desktop-expanded-projects`，「更早的会话」沿用当前窗口内的状态。切换选中会话或它的实际分组位置变化时，展开对应的组和内层旧会话；主动点「全部收起」后可以收起当前行，直到下一次选中或位置变化。「全部」枚举当前视图里的项目、时间组、状态组、分区及旧会话组，包含折叠项目内的旧会话组。无可折叠组时禁用该项。成员折叠、独立对话主组、置顶组和不分组的「会话」标题不参与。
- [`WorkbenchDialogs`](../src/components/WorkbenchDialogs.tsx#L70) 复用命名弹窗，由 `rename.kind` 区分 `section` 和 `new-section`，后者可携带会话 ID。失败时保留输入和对话框。分区用 `Layers`、折叠箭头、计数和操作菜单，空时展示 PRD 给定的拖放提示。会话菜单在置顶后提供放入和移出入口，成员菜单省略这两项。

[`useSessionDrag`](../src/hooks/useSessionDrag.ts#L3) 先识别目标及会话当前归属，再选操作。用同一套判断驱动高亮与松手，保留滚动、悬停展开和 Esc 取消。分区目标键为 `section:{id}`，项目和对话保留现有键。

| 松手位置 | 操作 |
| --- | --- |
| 新分区 | 普通会话或负责人直接调用 `setSessionSection`，允许运行和待确认。提示「放进分区」。 |
| 当前分区 | 取消。 |
| 原项目或对话，且会话在分区 | 传 `null` 移出分区，允许运行和待确认。 |
| 原项目或对话，且会话未归入分区 | 取消。 |
| 其他项目或对话 | 走 UI14 的预检和确认。起点有分区时，把当时的分区 ID 一起交给移动提交，成功时随项目变化一并清除 `sectionId`。 |

只有跨项目拖放调用 `sessionMoveStatus`，从项目目标移开就停止轮询，过期结果不能改变分区目标。分区拖放检查成员、目标是否还存在、存储是否可写及是否已有实际位置提交在进行。成员显示「团队成员跟随负责人显示」。非项目分组下的跨项目拖动和从分区拖出都显示 UI14 确认；默认布局中，未归入分区的无历史会话保留 UI14 的直接移动行为。通过「移动到…」菜单的调用沿用预览令牌并保留 `sectionId`。拖动通过 `moveSession` 的第四个可选参数传入是否需要确认和起始分区 ID，原有三个参数调用继续使用。起始分区纳入 [`moveSession`](../electron/ipc/session-move.ts#L127) 的确认条件，并在 `commitSessionMove` 取得写入顺序后再跟最新归属比较，变化则要求重新确认。清除字段和新位置进入同一次保存。取消确认、复制失败或写盘失败时，分区归属保留。现有 UI14 限制团队负责人和成员跨项目移动，负责人仍可通过分区操作整理侧栏。

## 验收

| PRD 验收项 | 验证方式 |
| --- | --- |
| 1、12 | 缺少 `sidebarView` 且无分区的夹具，对照基线的会话区 DOM 顺序和内容，运行 `npm run test:session-ui` 及 `node --import tsx scripts/test-session-move-ui.mjs`。有分区时恢复默认，单独验分区及其归属保留、圆点消失、菜单项禁用。 |
| 2、16 | 新增 UI 脚本从键盘打开，逐项检查角色、焦点返回和单选、多选行为。180 px 下分别验证经典、Codex、Claude 的浅色和深色截图及元素边界，运行现有 `npm run test:style-ui`。 |
| 3、5、6、7、8、9 | 单元测本地日界线、状态优先级、团队索引、自然排序、置顶去重及文件名解析。UI 用假时钟过午夜，用真实 Pi 配本地模型服务触发运行和待确认（沿用 `test-approval-ui` 的服务夹具），验证状态切换、选中后延迟移组、导入时间、置顶及成员显示。 |
| 4、10、11 | 测项目新建和操作菜单、分区新建空态、重命名与重名、菜单归入和移出、删除后的提示、重启保留设置与归属。再测拖入、拖出、取消跨项目确认、移动后文件及创建时间、菜单移动保留分区。运行中或待确认时拖入分区，检查未调用 `sessionMoveStatus`、无移动确认，Pi PID 和连接记录保持一致，原任务能继续。 |
| 13、14 | 已选会话下执行全部收起和展开，检查真实展开状态与菜单文字；重启读取损坏的分区和设置字段，检查有效数据保留。Store 测试覆盖真实写失败、后续重试及备份异常；UI 测连续改两个选项、其中一次保存失败时的提示和回退。 |
| 15 | 同机用 v0.14.84 与本次构建测试 500 会话、30 项目。记录菜单操作至目标列表 DOM 提交后的下一帧，单次上限 100 ms；用 [现有性能脚本](../scripts/test-performance-ui.mjs#L47) 的 React 提交计数方式比较相同流式任务期间的 Sidebar 更新次数。 |

UI 脚本使用 [`launchApp`](../tests/support/desktop-app.mjs#L9) 的隔离数据目录，加入 `test:features-ui`。打包版 macOS 验收按 [AGENTS.md](../AGENTS.md) 使用 `.noindex` 目录，以 `unregisterMacTestApp` 清理测试应用自己的注册记录。

## 设计 review

对照 UI17 的 16 条验收要求检查了设计，并回读了会话选择、UI14 移动、Store 和活动订阅的实现。以下两处需要确定产品规则。

1. **P1 · 名称排序的实现与验收冲突。** 本地 Electron 44.7.0 上，PRD 指定的 `zh-CN` 加 `numeric: true`、`sensitivity: 'base'` 得到「任务 2、任务 10、A、b」。验收 6 指定「A、b、任务 2、任务 10」。建议按验收顺序实现，先让拉丁字母开头的标题排在前面，再在各自组内按 `zh-CN` 自然排序。若决定按原比较器，则需改验收 6 的预期顺序。
2. **P1 · 全局置顶和拖入分区的显示位置冲突。** PRD 要求置顶会话只出现在置顶组，也要求会话显示在松手处。开启全局置顶后，置顶会话拖入分区无法同时满足这两条。建议置顶优先，照常保存分区归属，并在拖放反馈里说明该会话仍显示在置顶组。关闭全局置顶或取消该会话的置顶后，才显示在分区里。

Review 已把以下处理写入设计。旧数据只修正显示字段，避免误走损坏索引恢复。分区收录空白会话时一并保存会话记录。跨项目拖出分区与 UI14 共用一次提交，提交时核对原分区，旧的保存请求写不回已经变更的位置。默认布局保留 UI14 对无历史会话直接拖动的行为，以及团队会话的跨项目移动限制。

现有 `session-move-store`、`placeholder-store`、`store` 测试合计 56 项通过，验证了设计所依赖的保存、空白会话和移动行为。UI17 验收表中的新增用例随功能实现执行。
