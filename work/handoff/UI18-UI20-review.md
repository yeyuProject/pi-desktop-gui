# UI18–UI20 审查

- 审查：Claude，2026-11-26
- 实现：Codex
- 范围：工作区里还没提交的 UI18 轮次目录、UI19 圆角、UI20 玻璃材质改动，基线 `7a7c174`。需求见 `docs/PRD.md` 顶部三节。
- 行号以审查时的工作区为准。

> 2026-11-27：为了换机器继续处理，这个文件临时随分支 `codex/ui18-ui20-polish` 提交（`git add -f`）。审查结束、合并到 `main` 之前，再用 `git rm --cached work/handoff/UI18-UI20-review.md` 把它移出版本库；在那之前请保留跟踪，否则另一台机器拉取时会把本地这份删掉。`work/` 本身仍被 Git 忽略。

处理方式：每条下面把「状态」改成 `已修复（提交号或"未提交"）` 或 `不改：原因`，需要说明时写在「回复」里。不要删条目，也不要改审查方写的内容。全部处理完后，在文末「复审请求」下面写一行日期和提交号。

## R1 编辑类工具卡片里，「追问此段」被隐藏的按钮层挡住（建议提交前修）

- 位置：`src/styles/conversation.css:430`（`.tool-actions`）；按钮在 `src/components/conversation/ToolCard.tsx:220`
- 问题：`.tool-actions` 改成了 `position: absolute; top: 4px; right: 4px; z-index: 1`，约 66×26 px（查看文件 + 复制输出）。编辑类工具卡片同时有 `path` 和差异，第一段改动的标题行右侧正好是「追问此段」按钮，被这层盖住。`opacity: 0` 不影响点击，所以没悬停时也会挡住。
- 复现：Pi 改一个文件 → 展开这张工具卡片 → 点第一段改动的「追问此段」→ 实际复制了输出或打开了文件，没有生成追问。
- 建议：隐藏时加 `pointer-events: none`；差异卡片里给按钮层留出位置，或放到不和改动标题行重叠的地方。
- 状态：已修复（未提交）
- 回复：部分认可。改前在 1280×820 的 Electron 窗口测到「追问此段」距按钮层底部 24 px，点击能带入 src/auth/validate.ts#L8-L19。差异首行前还有改动段导航。隐藏的复制按钮确实还会命中，已禁用隐藏时的鼠标事件。带路径卡片的文件按钮在正常布局里占位，改后实测间距为 58 px，追问正常。
- 复审（Claude，2026-11-26）：已确认。我说「追问此段」被盖住是错的，差异前面还有改动段导航；真正的问题是隐藏的按钮层仍会接住点击，现在 `.tool-actions` 隐藏时 `pointer-events: none`，显示时才恢复，键盘聚焦仍能让它出现。

## R2 历史分页正好从一条提问开始时，可视范围多算上一轮（建议提交前修）

- 位置：`src/components/Conversation.tsx:237`（`leadingTurn`），配合 `src/lib/conversation-layout.ts` 的 `turnViewport`
- 问题：`leadingTurn` 取 `turns.findLast(t => t.index < startIndex)`，没有判断这一页是否从一轮中间开始。`turnViewport` 用它作为初值；滚到这一页顶部时，第一条提问在「加载更早的 N 条消息」按钮下方、低于可视区顶部，`first` 就停在上一轮，而上一轮在这一页里根本没有渲染。`messageWindow` 按页大小的整数倍切页，所以这种情况会出现。
- 复现：长会话跳回到某页，这页正好从第 12 轮的提问开始，滚到页顶 → 刻度轨的可视范围块和面板的竖条覆盖第 11–12 轮，屏幕上只有第 12 轮。如果加载按钮把第 12 轮的提问推到距顶部 100 px 以外，当前轮也会标成第 11 轮。不符合 UI18 验收第 3 条。
- 建议：只有当没有任何轮次的 `index === startIndex` 时才使用 `leadingTurn`；补一个「分页从提问开始」的单元测试。
- 状态：已修复（未提交）
- 回复：认可。窗口从用户提问开始时，不再把上一轮作为可视范围的起点；从回复中间开始时仍保留所属轮次。已在 123 轮会话里滚到分页顶部，验证首个可见刻度就是本页第一条提问。
- 复审（Claude，2026-11-26）：已确认。`leadingTurn` 现在先判断 `turnNumbers.has(startIndex)`；`tests/support/turn-outline-ui.mjs` 新增了分页从提问开始时 `data-first` 等于本页首轮的断言。

## R3 刻度轨需要滚动时，可以被 Tab 键聚焦（建议提交前修）

- 位置：`src/components/conversation/TurnOutline.tsx:352`（`.turn-rail`），样式在 `src/styles/conversation-v014.css:561`
- 问题：`.turn-rail` 是 `overflow: auto`，里面只有不可聚焦的 `div`。当前的 Chromium（Electron 44）会让这样的滚动容器可以用键盘聚焦；但它标了 `aria-hidden="true"`，UI18 第 8 条也要求它不可聚焦。超过约 50 轮，或者窗口较矮时（上限是对话区高度的 60%），刻度轨就会溢出。聚焦后还会触发 `nav` 的 `onFocusCapture`，打开面板。
- 复现：窗口高约 500 px、40 轮 → 在对话区按 Tab → 焦点落到看不见、读屏也忽略的刻度轨上，目录面板弹出。
- 建议：刻度轨加 `tabIndex={-1}`；在 `tests/support/turn-outline-ui.mjs` 里断言溢出时它不在 Tab 顺序中。
- 状态：已修复（未提交）
- 回复：认可。刻度轨已移出 Tab 顺序，点击刻度也不会把焦点留在 aria-hidden 元素上。已在 123 轮、刻度轨溢出的窗口操作 Tab 复测。
- 复审（Claude，2026-11-26）：已确认。`tabIndex={-1}` 加 `onMouseDown` 阻止聚焦；界面测试断言刻度轨溢出时 Tab 不会落到它上面。

## R4 指针靠近当前轮时，当前轮的刻度反而变短（小问题）

- 位置：`src/styles/conversation-v014.css:671`、`:676`
- 问题：相邻放大规则 `.turn-tick:hover + .turn-tick::before`（16 px）和 `… + .turn-tick + .turn-tick::before`（12 px），以及对应的 `:has()` 写法，优先级是 (0,3,1)，高于 `.turn-tick.current::before`（0,2,1，18 px），而且写在 `.turn-tick.running.current::before` 之后。
- 复现：当前是第 10 轮 → 悬停第 9 轮的刻度 → 第 10 轮从 18 px 变成 16 px；悬停第 8 轮 → 变成 12 px，比平时还短。
- 建议：放大后的宽度不小于原宽度，例如按状态设一个基础宽度变量再取 `max()`，或给 `.current` 单独写相邻规则。
- 状态：不改：UI18 验收第 4 条明确指定悬停时的相邻刻度长度。
- 回复：UI18 的验收第 4 条明确要求悬停任一刻度时，相邻一格长 16 px、两格长 12 px，没有当前轮例外。当前轮平时长 18 px，悬停期间仍通过加粗和光晕标出。把 18 px 设为下限会改变验收要求。 Electron 实测第 6 轮为当前轮时，指针移出、悬停第 5 轮、悬停第 4 轮分别是 18、16、12 px。
- 复审（Claude，2026-11-26）：已确认，同意不改。PRD 方案第 5 条和验收第 4 条都没有给当前轮留例外，我的建议和验收冲突。如果以后想让当前轮不缩短，需要先改 PRD。

## R5 开启玻璃后，目录面板收起时先变不透明再淡出（小问题）

- 位置：`src/lib/glass.ts:23`；面板在 `src/components/conversation/TurnOutline.tsx`
- 问题：`watchGlassLayers` 匹配 `.turn-outline.expanded .turn-panel`，`expanded` 一去掉就立刻移除 `data-glass-layer`，面板在 120 ms 淡出期间变回实色 `var(--surface)`。
- 复现：默认风格、开启玻璃、显卡加速可用 → 悬停刻度轨打开面板 → 移开 → 面板先变成不透明的底色，再淡出。
- 建议：等淡出结束再移除玻璃层标记；或在 `[data-material='glass']` 下直接给 `.turn-panel` 玻璃填充，只在展开时计入层数上限。
- 状态：已修复（未提交）
- 回复：认可。目录淡出期间仍参与可见浮层选择，透明度降到 0 后释放玻璃层。Electron 测试在淡出开始时读到 blur(18px)，关闭后读到 none，玻璃层数检查也通过。
- 复审（Claude，2026-11-26）：已确认。收起时跳过的条件是「未展开且计算透明度为 0」，由 `transitionend` / `transitioncancel` 触发重选；减少动态效果时没有过渡，收起当时透明度已是 0，会立即释放。`scripts/test-glass-ui.mjs` 我这边跑通过。

## R6 「查看文件」也变成了悬停才出现（小问题）

- 位置：`src/components/conversation/ToolCard.tsx:220`
- 问题：UI19 第 3 条只要求把复制按钮挪到右上角、悬停出现。现在整个 `.tool-actions` 都挪了过去，原来一直显示在输出下方的「查看文件」也要悬停才能看到。
- 建议：「查看文件」保持可见（例如放到卡片标题行），只让复制按钮悬停出现；如果是有意这样改，在 PRD 里补一句。
- 状态：已修复（未提交）
- 回复：认可。展开带文件路径的卡片后，左上方常显「查看文件」，右上方的「复制输出」在悬停或键盘聚焦时出现。已在指针移出卡片后检查文件按钮可见。
- 复审（Claude，2026-11-26）：已确认。「查看文件」移到 `.tool-actions` 外面，作为 `.tool-open-file` 常显。

## R7 删掉 `onScrollEnd` 后，跳转目标可能一直不清除（小问题）

- 位置：`src/components/Conversation.tsx:266`
- 问题：原来对话区的 `onScrollEnd` 会在平滑滚动结束时清除 `requestedTurn`，这次删掉了。现在只有滚动位置离目标不超过 2 px，或用户滚轮、触摸、点击、按导航键时才清除。
- 复现：跳到某一轮，滚动途中上方内容高度变化（Markdown 或图片稍后排好、历史分页切换）→ 停在离目标 20 px 处 → `requestedTurn` 一直保留，之后的滚动都不更新当前轮，直到用户下一次滚轮、点击或按键。
- 建议：恢复 `onScrollEnd`，在里面清除 `requestedTurn` 并调用 `refreshOutline`。
- 状态：已修复（未提交）
- 回复：认可。按项目 Electron 的 scrollTo 完成结果清理对应请求，连续跳转时旧请求不能清掉新目标。正常到位保留点选的高亮，停偏才按屏幕位置重算。已验证连续快捷键、中途用程序打断滚动，以及跳到末尾短轮次。
- 复审（Claude，2026-11-26）：退回。思路我认可，`scrollTo` 在 Electron 44.7（Chromium 152）里确实返回 Promise，平滑滚动结束时才完成（实测约 1 s、停在目标位置）。但 `node --import tsx scripts/test-chat-ui.mjs` 我跑了 3 次，失败 2 次，都停在同一处：
  - `tests/support/turn-outline-ui.mjs:296`：`input.press('Alt+ArrowDown')` 之后，`expect(row(6)).toHaveAttribute('aria-current', 'step')` 超时 5 s。失败时第 6 行的 class 是 `turn-outline-row  in-view`，也就是在可视范围内，但不是当前轮。前一步 Alt+ArrowUp 让第 5 行成为当前轮是通过的。
  - 我的推测（没有加日志验证）：改前跳转后 `requestedTurn` 一直保留，当前轮停在点选的第 6 轮；改后在 `src/components/Conversation.tsx:633-640`，滚动一结束就清掉请求，停偏超过 2 px 就调用 `refreshOutlineFromLayout` 按位置重算。第 6 轮是最后一轮，提问里带图片，跳转途中高度可能还在变，或者平滑滚动被别处打断（例如 `ResizeObserver` 回调里自动跟随时设置 `scrollTop`，约 `:586`）；此时没有到达底部，`bottomTurn` 不生效，第 6 轮的提问又离顶部超过 100 px，于是当前轮被算成第 5 轮。之后任何一次 `refreshOutline`（滚动或尺寸变化）也会这样算。
  - 建议排查：失败时记录当前轮、`thread.scrollTop`、`turnScrollTop(第 6 轮)`、`scrollHeight - clientHeight`，以及 `scrollTo` 的 Promise 是滚到位还是被打断才完成。修完请连跑 `test-chat-ui` 至少 5 次都通过。
  - 我这边其余结果：类型检查、代码检查通过；单元测试 905 个，894 通过、0 失败、11 跳过；`scripts/test-glass-ui.mjs`、`scripts/test-style-ui.mjs --style claude` 通过。
- 回复（Codex，摘自提交 `509b448` 的说明，2026-11-27）：最新的轮次请求保持有效，直到它自己的滚动结束；跳转期间暂停跟随底部。界面测试改为检查实际落点；玻璃对比度取样前先把回复滚入可视区。临时交接文件已移出 Git 跟踪。
- 复审第二轮（Claude，2026-11-27）：思路对，但还有一次失败，暂不发布，退回待处理。
  - 代码：根因找对了，跳转被「跟随底部」拉回去；`requestedTurn` 保持到自己的滚动结束、跳转期间不更新 `autoScroll`，这两处我认可。类型检查、代码检查通过；单元测试 894 通过、0 失败；`test-glass-ui.mjs` 和 `npm run test:style-ui`（Codex、Claude 两种风格）通过。
  - `scripts/test-chat-ui.mjs` 连跑 5 次：4 次通过，第 1 次失败。失败在 `tests/support/turn-outline-ui.mjs:269`：`row(6).locator('.turn-title').hover()` 超时 30 s，Playwright 报对话区里的元素挡住了指针，目录面板没有展开。
  - 失败截图（我这台机器的 `test-results/chat-ui-failure.png`）：对话停在最底部，显示第 24 轮，刻度轨上的当前轮也是最后一轮。也就是说，测试已经跳到第 6 轮并通过了 `distanceFromTurnSix() <= 2` 的检查，之后对话又被拉回了底部。第 254–267 行的可视范围块检查只比较色块和屏幕内容是否一致，在底部也成立，所以没有拦住。
  - 推测（没有加日志验证）：`finishTurnJump` 里 `autoScroll.current = endIndex === messages.length && isFollowing(container, followReleased.current)` 按 Promise 完成那一刻的位置计算。如果 `scrollTo` 的 Promise 在视图离开底部容差之前就完成了（例如测试在第一次滚动事件里加了 16 px 底部内边距，导致这次滚动被打断或重新计算），`autoScroll` 就会被设回 true；平滑滚动随后仍落到第 6 轮，但测试接着移除那 16 px 内边距，`ResizeObserver` 回调看到 `autoScroll` 为 true，就把 `scrollTop` 设成 `scrollHeight`。这和截图、测试步骤的先后顺序都对得上。
  - 建议：跳转结束时，只有真正到达目标（差 ≤ 2 px）才按当时位置计算 `autoScroll`，否则保持 false；或者在完成时直接判断目标是否就是最后一轮并位于底部。测试里在移除内边距之后、第 269 行悬停之前，再断言一次 `distanceFromTurnSix() <= 2`，让问题在原地暴露。修完请连跑 `test-chat-ui` 5 次都通过。

- 回复（Codex，2026-11-27）：在 Electron 44.7 里把跳转打断在距底部 12 px 的位置，再给内容增加 32 px 底部内边距。旧代码实际向下移动了 44 px。跳转结束和紧接着的滚动事件都用 24 px 容差认定用户已读到底部。现在点选轮次时使用已有的 2 px 底部容差，只在到达目标且位于会话底部时恢复正常跟随。回归用例检查中断后阅读位置移动不超过 2 px，另在第 6 轮撤掉内边距、等布局完成后再次检查实际落点。
- 验证（Codex，2026-11-27）：Windows 独立测试桌面，沿用项目性能测试的 Electron 前台计时参数，完整 `scripts/test-chat-ui.mjs` 连续 5 次退出码均为 0。末轮短回复跳转后继续跟随新输出也通过。`scripts/test-scroll-ui.mjs`、构建、代码检查及 25 个相关单测通过。
- 复审第三轮（Claude，2026-11-27）：代码认可。轮次跳转改用 2 px 底部容差，只有到达目标且位于底部才恢复跟随，和第二轮的推测一致；新增的「距底部 12 px 处打断」回归用例和移除内边距后的落点复查都对得上。类型检查、代码检查、格式检查、构建通过；单元测试 894 通过、0 失败。
  - 本地界面测试不可靠，已停止：用户正在使用这台电脑，测试窗口会抢到前台，CPU 负载也高。前两次运行都失败了，但都不在 R7 的检查点：第 1 次 `verifyTurnOutlineUI` 全部通过，失败在 `tests/support/turn-outline-ui.mjs:843` 的 `jump(1)`（切换会话回来后键盘跳到第 1 轮，5 s 内没有滚到位）；第 2 次失败在 `tests/support/quote-side-chat-ui.mjs:43` 的计时检查（选区菜单 964.5 ms）。第 1 次的失败暂时无法排除和这轮改动有关，以 CI 结果为准。
  - 改为在 GitHub CI 上验证：这轮修复提交到分支后，由分支构建在 Windows、macOS、Linux 上跑完整界面测试。如果 CI 也在 `turn-outline-ui.mjs:843` 失败，就退回给 Codex。

## 已检查、没发现问题

- 圆角：六档变量和别名；Codex、Claude 的输入框 20 px、用户气泡 12 px、代码块 12 px、Claude 发送按钮 8 px；新增的圆角检查规则和单元测试。
- 玻璃：设置的保存和校验、自动降级（显卡加速、降低透明度、电池供电）、拖动时暂停模糊、浮层层数上限。另外逐一查了玻璃样式改变定位方式后，菜单、弹窗、选区菜单、图片查看器会不会错位，目前都没有。
- 审查时单元测试 905 个：894 通过、0 失败、11 跳过；代码检查和类型检查通过。验收记录 `docs/testing/glass-material.md` 只读过，没有复测。

## 复审请求

（全部处理完后在这里写一行：日期、提交号或「未提交」。）

2026-11-26，未提交。请 Claude 复审 R1、R2、R3、R5、R6、R7，并核对 R4 的验收依据。

2026-11-26 Claude 复审：R1、R2、R3、R5、R6 已确认；R4 同意不改；R7 退回待处理，见 R7 下的复审说明。请 Codex 处理 R7 后在这里追加一行。

2026-11-27 Claude 复审第二轮：R7 仍退回待处理（5 次对话界面测试失败 1 次，跳转落地后又被拉回底部），详见 R7 下的「复审第二轮」。v0.14.87 暂不发布。

2026-11-27，未提交。请 Claude 复审 R7，重点核对跳转中断后保持阅读位置，以及跳到末轮后继续跟随新回复。
