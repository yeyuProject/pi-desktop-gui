# P1 普通任务计划验收

实现版本：v0.14.58。使用仓库固定的 Pi 1.4.0 和本地 OpenAI 兼容模型桩，不调用远程模型。

## 本地验证

- `npm run build`、`npm run lint`、`npm run format:check`。
- `node --import tsx --test --test-concurrency=2 --test-timeout=120000 tests/*.test.ts tests/*.test.mjs`：760 项通过、2 项跳过。
- `npm run test:integration`、`npm run test:features`（包含 `scripts/test-plan.ts`）、`npm run test:goal`。
- `npm run test:goal-ui`：原有 Goal 计划、完成与续跑行为通过。
- `npm run test:chat-ui`：普通对话、工具与搜索、视图恢复及 P1 界面通过。可单独执行 `node --import tsx scripts/test-plan-ui.mjs`。

计划用例验证真实工具注册与系统提示词、确认模式放行、更新推送、插话保留原任务标识、新任务清除、当前分支存储、离线读取、重启恢复、无计划分支、Goal 互斥，以及失败写入不发布未保存状态。

界面覆盖展开、Esc/按钮收起、跨会话保存展开状态、关闭后相同内容的新更新重新显示、运行结束后的未完成提示、完成后八秒收起及圆点重开。对话流与会话内查找不显示计划工具记录。12 个步骤各 4000 字时，摘要省略且保留完整标题，详情可滚动且不超过 40vh，对话区无横向溢出；窄窗口和字号缩放通过。

## Electron 实测文字对比度

以下为计划摘要、编号清单、状态标记及剩余步数中的最低值，采用最终计算颜色和背景叠加后的 WCAG 公式，门槛为 4.5:1。

| 风格 | 浅色 | 深色 |
| --- | ---: | ---: |
| 经典 | 5.65:1 | 6.39:1 |
| Codex | 6.58:1 | 5.72:1 |
| Claude | 5.85:1 | 5.29:1 |

每次界面验收生成 `test-results/plan-ui-result.json` 和 `test-results/plan-{style}-{theme}.png` 六张截图。README 展示截图由同一脚本在独立新会话中生成，使用本地模型桩。

## 发布验证

发布工作流仍需运行 Windows、macOS、Linux 全量检查及打包。草稿安装包经源码/构建记录复核、三平台清单与散列校验后，按 `docs/update-signing.md` 生成独立更新签名，再公开发布。

计划是否创建和及时更新取决于模型对工具指引的遵守程度。此实现保证已有计划的显示与生命周期，不强制模型列计划或自动续跑。
