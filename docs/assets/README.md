# README 视觉素材

README 使用两类素材：`screenshots/` 中的真实界面截图，以及 2026-10-14 使用 Codex 内置 `image_gen` 工具生成的概念插图（统一使用森林绿 `#386e5a`、深灰和米白 `#fafbf9`）。

| 文件 | 用途 | 构图 |
| --- | --- | --- |
| [screenshots/demo.gif](screenshots/demo.gif) | README 首屏演示：@ 引用文件 → 发送 → 工具调用与 Diff → 撤销本轮 | 1280 × 800，15 fps，约 27 秒 |
| [screenshots/workspace-light.png](screenshots/workspace-light.png) | 对话、工具调用与内联 Diff（静态） | 1440 × 900 @2x |
| [screenshots/workspace-dark.png](screenshots/workspace-dark.png) | 深色主题 | 1440 × 900 @2x |
| [screenshots/workspace-codex-light.png](screenshots/workspace-codex-light.png) | Codex 白天风格 | 1440 × 900 @2x |
| [screenshots/workspace-codex-dark.png](screenshots/workspace-codex-dark.png) | Codex 夜晚风格 | 1440 × 900 @2x |
| [screenshots/workspace-claude-light.png](screenshots/workspace-claude-light.png) | Claude 浅色风格 | 1440 × 900 @2x |
| [screenshots/workspace-claude-dark.png](screenshots/workspace-claude-dark.png) | Claude 深色风格 | 1440 × 900 @2x |
| [screenshots/approval.png](screenshots/approval.png) | 确认模式下的命令审批卡片 | 1440 × 900 @2x |
| [hero-banner.png](hero-banner.png) | 早期首屏品牌海报，README 已改用真实截图，保留为历史素材 | 约 16:9 横版 |
| [architecture-bridge.png](architecture-bridge.png) | 本机 GUI 与 Pi CLI 通信关系 | 约 16:9 横版 |
| [features-bento.png](features-bento.png) | 早期六项能力概览，保留为历史素材 | 约 16:9 横版 |
| [logo.png](logo.png) | 早期 README π 图标，保留为历史素材 | 1:1，图标外透明 |

## 使用说明

- 首次生成素材前运行 `npx playwright install chromium --only-shell` 安装无头浏览器；Linux 可加 `--with-deps` 安装系统依赖。两个脚本只在 `127.0.0.1` 提供 `dist` 内的构建文件。
- 截图由 `npm run screenshots`（`scripts/readme-screenshots.mjs`）生成：用模拟的 `window.desktop` 渲染构建后的真实界面，数据为虚构的示例项目，不含真实会话、路径或凭据。界面改动后先 `npm run build` 再重新生成。
- 演示 GIF 由 `npm run demo-gif`（`scripts/readme-demo.mjs`）录制：同样使用模拟数据，脚本按时间线推送运行事件，并用 Playwright 驱动真实的输入、点击和滚动；无头浏览器不绘制鼠标，脚本在页面内画了一个跟随指针。需要本机安装 `ffmpeg`。
- 海报、架构图与能力概览为 AI 生成的概念插图，海报中的界面是示意。README 目前只使用其中的架构图。
- E2E 验收截图由测试脚本写入 Git 忽略的 `test-results/`。README 展示素材单独维护，避免混入测试会话、临时路径和验收模型名称。
- 架构图省略了 Electron 内部 IPC 和桌面适配扩展，重点表示 GUI 通过本机 stdio 上的 Pi RPC（JSONL）驱动 CLI。它不表示标准 JSON-RPC 2.0。
- 图中的模型服务、MCP 服务表示可连接的资源；模型和 MCP 可以部署在本机或远程，联网情况取决于用户配置。“Local Workspace”不表示离线推理或系统沙箱。
- 图中的 Undo 指受运行基线支持的文件撤销，不表示撤销命令造成的外部操作。
- v0.6.1 起 README 顶部与应用统一使用 `build/` 内的新图标；原图及生成提示词见 `build/icon-source-v2.png` 和 `build/icon-source-v2.prompt.txt`。`logo.png` 保留为历史素材。
- 修改能力标签时，同步更新 `README.md` 与 `README.zh-CN.md` 的文字说明与图片 alt，确保图片无法显示时仍能了解产品。

## 生成提示词

以下是实际提交给内置工具的完整提示词。前三张设置 `transparent_background: false`，Logo 设置 `transparent_background: true`。

### 首屏品牌海报（hero-banner.png）

```text
Use case: ads-marketing. Asset: GitHub README hero banner, landscape exactly 16:9, preferably 2048x1152 pixels. Art direction for Pi Desktop README: high-end minimalist developer tool editorial artwork inspired by Raycast, Zed and Linear; restrained forest green #386e5a, muted mint and warm ivory #fafbf9, very dark charcoal and slate. Precise typography, generous negative space, subtle depth, no rainbow, no stock photos, no watermark, no extra invented logos. This is a conceptual illustration, never an actual application screenshot.
Create a polished launch hero for "Pi Desktop". Composition: very large clean title near upper left or upper center, with subtitle directly beneath, generous margins. A floating desktop application window occupies the lower two thirds in a slightly elevated almost-front-on view; on its left a narrow session sidebar with 3 connected branching conversation nodes, center a streaming chat and an inline green/red code diff card, bottom a calm command bar with "@file" and "/skill" pills. A smaller translucent terminal window sits offset to its right, linked via one subtle green light line. Sophisticated matte surfaces with extremely restrained glass edge lighting, no excessive bloom or dramatic perspective. Use understated short English UI labels only, abstract line segments for other prose, never dense fake text.
Text (verbatim, exact): main title "Pi Desktop"; subtitle "The Native Desktop Workspace for Pi Coding Agent"; small terminal text "> pi"; optional small UI labels "Sessions", "Review changes", "@file", "/skill". Keep all elements safely within the canvas. Let the polished app composition be the focus below the headline. Render a single finished banner, no mockup of a page or device bezel.
```

### CLI 与 GUI 架构概念图（architecture-bridge.png）

```text
Use case: infographic-diagram. Asset: technical concept illustration for GitHub README, landscape exactly 16:9, preferably 2048x1152 pixels. Art direction for Pi Desktop README: high-end minimalist developer tool editorial artwork inspired by Raycast, Zed and Linear; restrained forest green #386e5a, muted mint and warm ivory #fafbf9, very dark charcoal and slate. Precise typography, generous negative space, subtle depth, no rainbow, no stock photos, no watermark, no extra invented logos. This is a conceptual illustration, never an actual application screenshot.
Design an exceptionally clear, elegant 2D architecture diagram on dark slate #0f172a. Title at top left "CLI freedom. Desktop intuition." A large thin rounded frame marks the local device area, with small label "YOUR DEVICE". In its upper left, a rounded desktop card titled "Pi Desktop GUI" with three short stacked rows "Chat", "Diff Review", "Session Tree", each a simple outline icon. In its upper right a matching agent-engine card titled "Pi Coding Agent CLI" with a small terminal glyph. Between these two cards draw one bidirectional horizontal green connector with exact two-line label "Local stdio RPC" and "(JSONL)". In the lower part of the local-device frame place two modular cards, "Skills & Extensions" and "Local Git Workspace", joined to the CLI card with clean orthogonal lines. A subtle connector from GUI to Local Git Workspace also indicates desktop review. Beneath the device frame place two optional external cards "Model Provider" and "MCP Servers" with dashed connections routed clearly from the CLI; do NOT enclose these external cards inside YOUR DEVICE. Put a concise explanatory footer on the bottom, exact: "Models and remote MCP may use the network."
Use just the exact labels specified, all clearly legible at README width, no JSON-RPC label, no cloud-free or fully offline claim. Diagram should clearly show the local GUI-to-CLI link while allowing remote models and MCP. Forest green accents, warm ivory typography, very limited soft shadows, crisp thin lines, generous separation. Single finished diagram, not an image of a webpage.
```

### 六项核心能力概览（features-bento.png）

```text
Use case: infographic-diagram. Asset: GitHub README feature showcase, exactly 16:9 landscape, preferably 2048x1152 pixels. Art direction for Pi Desktop README: high-end minimalist developer tool editorial artwork inspired by Raycast, Zed and Linear; restrained forest green #386e5a, muted mint and warm ivory #fafbf9, very dark charcoal and slate. Precise typography, generous negative space, subtle depth, no rainbow, no stock photos, no watermark, no extra invented logos. This is a conceptual illustration, never an actual application screenshot.
Create a beautifully composed Apple / Linear style bento grid of six dark matte cards with thin understated borders and consistent rounded corners. Top margin includes small brand line "Pi Desktop" and a large heading "Your workflow. In one place." Use an attractive balanced modular grid with six cards total; all feature labels large and legible, plenty of breathing room. Each card has one sophisticated minimal illustration and one exact feature heading:
1. "Inline Diff & Undo" — a compact code diff with muted red deletion, mint green addition, a rewind arrow badge.
2. "Branching Sessions" — precise connected conversation nodes branching like a git tree.
3. "MCP & Skills" — three connected modular plugin blocks.
4. "CLI ↔ GUI Handoff" — terminal and desktop window icons linked by two directional arrows.
5. "Local Workspace" — a folder and local CPU outline. Do not use a privacy shield and do not claim 100% local, fully private, offline, or sandboxing.
6. "Keyboard First" — realistic matte keycaps reading "⌘ K", "@", "/", and "Esc".
No additional body text is necessary. Green #386e5a and soft mint highlights, warm ivory text, charcoal background. Premium uncluttered product infographic; restrained tactile depth in icons, no noisy gradients. Single finished artwork.
```

### README 品牌图标（logo.png）

```text
Use case: logo-brand. Asset: README brand icon, 1:1 square, 1024x1024 pixels. Art direction for Pi Desktop README: high-end minimalist developer tool editorial artwork inspired by Raycast, Zed and Linear; restrained forest green #386e5a, muted mint and warm ivory #fafbf9, very dark charcoal and slate. Precise typography, generous negative space, subtle depth, no rainbow, no stock photos, no watermark, no extra invented logos. This is a conceptual illustration, never an actual application screenshot.
Design a high-end macOS Big Sur / Raycast style rounded squircle app icon for Pi Desktop. Deep forest green #386e5a matte-glass squircle with subtle darker emerald gradient, precision inner rim lighting, very soft dimensional bevel. In the center one bold geometric Greek lowercase letter "π" rendered in warm ivory #fafbf9, with a very gentle three-dimensional bevel and soft short shadow. Integrate a small terminal underscore cursor subtly into the lower-right of the symbol composition, without obscuring the unmistakable pi shape; avoid any additional text. Icon upright, perfectly front-facing, optical balance, generous negative space. Fill most of the square canvas with the icon while leaving approximately 8 percent transparent padding around its outside edges. Actual transparent background outside the squircle, not white, not checkerboard, no scene or pedestal. Crisp silhouette that reads beautifully at 88px and 128px. Render a single icon, no variants or presentation board.
```

