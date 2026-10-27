<div align="center">

<img src="build/icon-mac.png" width="128" height="128" alt="Pi Desktop 图标" />

# Pi Desktop

**为 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 打造的本地桌面工作台。**<br />
终端的自由，桌面的直觉。

[![Release](https://img.shields.io/github/v/release/yeyuProject/pi-desktop-gui?style=flat-square&color=386e5a)](https://github.com/yeyuProject/pi-desktop-gui/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/yeyuProject/pi-desktop-gui/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/yeyuProject/pi-desktop-gui/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/yeyuProject/pi-desktop-gui/total?style=flat-square)](https://github.com/yeyuProject/pi-desktop-gui/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0f172a?style=flat-square)](#安装)
[![License](https://img.shields.io/github/license/yeyuProject/pi-desktop-gui?style=flat-square)](LICENSE)

[English](README.md) · **简体中文**

[特性](#特性) · [安装](#安装) · [使用](#使用) · [常见问题](#常见问题) · [参与贡献](#参与贡献)

<br />

<img src="docs/assets/screenshots/demo.gif" width="100%" alt="演示：用 @ 引用文件并发送任务，Pi 修改两个文件并运行测试，在工作区查看 Diff，最后撤销整轮修改" />

</div>

## 为什么需要 Pi Desktop？

命令行编程智能体效率高、可组合，但在审查大段 Diff、并行探索多种方案、粘贴截图，或配置 MCP 与 Skills 时，纯终端界面往往显得局促。Pi Desktop 在你已经安装的 Pi CLI 之上提供桌面界面：

- **在本机运行。** 通过本地 `stdio` 上的 RPC（按行传输 JSON，即 JSONL）驱动你机器上的 `pi`，桌面与智能体之间没有额外的中转服务。
- **与终端共用一切。** 会话、模型凭据和扩展都与 Pi 相同。通过「在 Pi 终端继续」把会话交给终端，也可以在桌面打开终端创建的会话。
- **对话优先，审查随行。** 保持简洁的对话流；需要时展开工作区查看变更与 Diff，并可撤销文件修改。

会话与工作区保存在本机；模型请求沿用 Pi 的供应商配置，远程 MCP 也可能联网。「本地工作台」不代表所有推理都在本机完成。

## 特性

- **更流畅的长对话**：流式回复及结束后都复用已完成的 Markdown 段落，历史跳转和查找按页显示；输入时不重渲染对话区，草稿图片内容只在选中会话后读取。环境准备和快照清理在窗口打开后执行，空闲会话停止计时更新。
- **紧凑的对话历史**：同一用户轮次的思考过程合并为一个折叠区域，完成后默认收起（也可在设置中开启「默认展开思考过程」）；搜索可定位完整原文，也可一次收起所有思考过程。
- **可视化智能体工作流**：实时显示思考过程、工具调用参数与退出状态，每次修改都有内联 Diff，并区分当前上下文/窗口容量与会话累计 Token，提供输入、输出、缓存明细和估算费用。Pi 提供输出 Token 数和耗时时，完整回复下方以带底色的“平均输出速度”标识显示 TPS；包含等待模型响应的时间，不包含工具执行时间。
- **图片附件**：粘贴和拖入图片时自动识别格式，系统未提供文件类型也可使用；通过 `@` 选择项目图片会添加为图片附件。支持 PNG、JPEG、WebP、GIF，每条消息最多 8 张，单张 8 MiB、总计 16 MiB。
- **按轮次撤销**：在 Git 项目中，每次运行前建立快照（存放在应用数据目录，不改动项目的 `.git`），支持将仓库根目录或其子目录作为项目打开；反复刷新本轮变更时复用未变化文件的哈希，可撤销整轮修改或单独回滚文件。命令产生的外部副作用不在撤销范围内。
- **工具审批**：每个会话可选「全自动」「确认修改」或「只读」。可以允许一次、本会话总是允许，或填写原因拒绝。
- **分支对话**：编辑并重发任意消息、Fork 新分支，或克隆当前分支，围绕同一问题尝试不同方案。
- **生态控制中心**：图形化管理模型供应商（API Key / OAuth / 任意 OpenAI 兼容接口）、MCP 服务器、Skills、扩展和提示词模板，无需手写配置文件。未连接的会话反复打开模型选择器时会复用自己的目录，相关配置变化后自动失效；已连接或未连接的会话都可点模型搜索旁的「刷新」。已连接会话的供应商刷新超过 15 秒自动取消，避免长时间占用会话。
- **随手提问或深度工程**：无需打开仓库即可开始独立对话；打开项目则自动挂载文件树、Git 变更与快照。
- **多会话并发**：每个已连接会话使用独立的 Pi 进程。切换会话不影响任务；运行中修改模型和推理级别，下次发送新任务时生效，工具继续推理和运行中补充仍沿用本轮设置。连按两次 <kbd>Esc</kbd> 只停止当前会话。
- **运行中补充要求**：在会话运行途中补充要求（Steer）或追加该会话的后续队列。
- **清晰的重试进度**：显示重试倒计时和等待响应时间，可取消已经发出的重试请求；运行记录会区分恢复、失败和取消。连续的空正文错误默认显示最新一条，前序失败记录可展开查看。
- **键盘优先**：跨会话全局搜索、会话内查找，各个面板都有快捷键。
- **统一外观与清晰设置状态**：浅色、深色、跟随系统，以及护眼米黄、豆沙绿、深蓝背景主题，覆盖标题栏与确认框，保留原生窗口按钮。Pi 运行时仍可编辑本地配置，待可安全保存时再应用；已保存但尚未应用会单独提示。

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/approval.png" width="100%" alt="确认模式：Pi 执行命令前请求批准" /></td>
    <td width="50%"><img src="docs/assets/screenshots/workspace-dark.png" width="100%" alt="深色主题下的同一工作区" /></td>
  </tr>
  <tr>
    <td align="center"><sub>执行命令和修改文件前先确认</sub></td>
    <td align="center"><sub>浅色与深色主题</sub></td>
  </tr>
</table>

各版本的变化见 [发布说明](docs/releases/)。

## 安装

### 1. 安装 Pi

Pi Desktop 依赖 Node.js（`>= 22.19`）与 Pi Coding Agent CLI：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

完整回归基准为 Pi **1.1.0**。其他可识别的版本也能正常连接，不显示版本提示。Pi Desktop 不会自动安装或升级 Pi。

> [!IMPORTANT]
> Windows 用户请先安装 [Git for Windows](https://git-scm.com/download/win)，Pi 需要用其中的 Git Bash 执行命令。

### 2. 下载 Pi Desktop

前往 [最新版本](https://github.com/yeyuProject/pi-desktop-gui/releases/latest) 下载对应系统的安装包。每个版本都提供 `SHA256SUMS.txt`，用于核对下载文件。

| 平台        | 架构                  | 格式                                                     |
| :---------- | :-------------------- | :------------------------------------------------------- |
| **Windows** | x64                   | `-setup.exe` 安装版（推荐，支持自动更新）· `.exe` 便携版 |
| **macOS**   | Apple Silicon · Intel | `.dmg` · `.zip`                                          |
| **Linux**   | x86_64                | `.AppImage`（支持自动更新）· `.deb`                      |

Windows 安装版、macOS 和 Linux AppImage 支持应用内更新（默认手动下载，可在 **设置 → 关于与更新** 开启自动下载；仅点击“立即重启”才安装）；其他格式在有新版本时提示手动下载。Mac 请从可写目录运行应用，推荐放入“应用程序”；v0.14.30 及更早版本需先手动安装一次 v0.14.31 或更新版本，之后可直接在应用内升级。任务或审批未结束时不会重启更新。

### 3. 连接模型并开始

1. 启动 Pi Desktop，应用会在 `PATH` 以及常见的 `nvm` / Homebrew 路径中查找 `pi`。
2. 打开 **Pi 功能 → 供应商与登录** 配置模型服务商。若终端中已配置过 `~/.pi`，会自动识别。
3. 在输入框中选择模型与推理深度，即可开始对话或打开本地项目。

供应商列表会显示凭据来源。退出登录只移除保存的登录凭据；环境变量、`models.json` 和扩展仍可提供凭据，列表会分别标明。

新建后尚未使用的空白对话是临时入口：离开后会隐藏，也不会写入索引或备份。同一项目或独立对话范围内重复新建时会复用这个临时入口。输入内容、添加附件、改名或置顶、选择会话设置、连接对话或发送任务后，会话就会正式保留；之后清空内容或操作失败也不会变回临时入口。仅浏览模型目录并完成读取仍是临时入口；若读取尚在进行时新建另一对话，则保守保留正在使用的原会话。已有的空会话继续保留，可在 **设置 → 诊断与数据 → 清理空会话** 中确认后手动清理。

打开或切换对话时，只恢复历史和草稿，不启动 Pi。模型菜单通过一次短时 Pi 查询读取当前项目的实际模型和推理级别，不加载桌面适配扩展，也不建立聊天连接。发送任务或主动连接时才会连接对话；已有连接和后台任务仍归各自对话所有。发送时沿用已保存的模型偏好，未保存时使用 Pi 的实际默认配置（含项目设置）。项目仍需先信任并启用，才会启动 Pi。

新建或切换尚未完成时，模型入口会显示“会话切换中…”并暂时禁用，旧模型菜单同时关闭。目标会话就绪后再点击即可；之前的点击不会转交给另一会话或自动连接。未启用的项目会显示“请先启用项目”。

新会话日志使用 Pi 的原生目录（默认 `~/.pi/agent/sessions/<工作目录编码>/`），CC Switch 等工具可据此扫描用量。Pi 的 `sessionDir` 设置及环境变量覆盖继续生效；已有桌面版会话文件仍可从原位置继续打开。

删除会话时，提示会区分文件已移到回收站、空会话已移除，以及会话文件已不存在而仅移除记录。已保存会话的文件缺失时，仍可通过一次性探测读取模型目录；其他文件访问错误会正常报告。

## 使用

### 输入框指令

| 前缀 | 作用                                                    | 示例                              |
| :--: | :------------------------------------------------------ | :-------------------------------- |
| `@`  | 引用项目文件（也可以直接把文件或图片拖进输入框）        | `@src/App.tsx 优化这里的渲染性能` |
| `/`  | 打开命令菜单，调用 Skills、提示词模板与扩展命令         | `/commit`                         |
| `//` | 绕过桌面同名命令，直接调用 Pi 原生斜杠命令              | `//compact`                       |
| `!`  | 在工作目录执行 Shell 命令，并把输出加入对话上下文       | `!npm test`                       |
| `!!` | 执行 Shell 命令，仅在本地显示结果，**不占用**模型上下文 | `!!git status`                    |

### 快捷键

| 功能                         |             Windows / Linux              |                 macOS                  |
| :--------------------------- | :--------------------------------------: | :------------------------------------: |
| 新建对话                     |       <kbd>Ctrl</kbd> <kbd>N</kbd>       |       <kbd>⌘</kbd> <kbd>N</kbd>        |
| 搜索会话与历史消息           |       <kbd>Ctrl</kbd> <kbd>K</kbd>       |       <kbd>⌘</kbd> <kbd>K</kbd>        |
| 在当前会话中查找             |       <kbd>Ctrl</kbd> <kbd>F</kbd>       |       <kbd>⌘</kbd> <kbd>F</kbd>        |
| 展开 / 收起侧栏              |       <kbd>Ctrl</kbd> <kbd>B</kbd>       |       <kbd>⌘</kbd> <kbd>B</kbd>        |
| 展开 / 收起工作区            |       <kbd>Ctrl</kbd> <kbd>J</kbd>       |       <kbd>⌘</kbd> <kbd>J</kbd>        |
| 切换变更 / 文件 / 输出页签   | <kbd>Alt</kbd> <kbd>1</kbd>–<kbd>3</kbd> | <kbd>⌥</kbd> <kbd>1</kbd>–<kbd>3</kbd> |
| 打开设置                     |       <kbd>Ctrl</kbd> <kbd>,</kbd>       |       <kbd>⌘</kbd> <kbd>,</kbd>        |
| 快捷键速查                   |       <kbd>Ctrl</kbd> <kbd>/</kbd>       |       <kbd>⌘</kbd> <kbd>/</kbd>        |
| 翻阅发送历史（输入框为空时） |       <kbd>↑</kbd> / <kbd>↓</kbd>        |      <kbd>↑</kbd> / <kbd>↓</kbd>       |
| 关闭面板并聚焦输入框         |              <kbd>Esc</kbd>              |             <kbd>Esc</kbd>             |
| **停止当前会话的任务**       |      <kbd>Esc</kbd> <kbd>Esc</kbd>       |     <kbd>Esc</kbd> <kbd>Esc</kbd>      |

## 工作原理

<img src="docs/assets/architecture-bridge.png" width="100%" alt="架构图：Pi Desktop GUI 通过本机 stdio RPC（JSONL）连接 Pi CLI，Pi 使用 Skills、扩展与本地 Git 工作区，并连接模型服务和 MCP" />

Electron 主进程以 RPC 模式启动 `pi`，并注入一个小型桥接扩展，补充 RPC 未覆盖的能力（工具审批、会话树导航、登录等）。React 渲染进程只通过带类型的 IPC 接口与主进程通信。模块边界与恢复机制见 [架构说明](docs/architecture.md)。

## 常见问题

<details>
<summary><b>macOS 提示「无法验证开发者」或「已损坏」？</b></summary>

macOS 版本采用 ad-hoc 签名，并在打包时校验签名完整性。目前尚无 Apple Developer ID 签名或公证，Gatekeeper 仍可能阻止首次运行。按住 <kbd>Control</kbd> 点击应用并选择「打开」，或在终端解除隔离属性：

```bash
xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"
```

Windows 安装包目前也未签名，首次运行可能出现 SmartScreen 提示。更新先验证内置公钥对应的 Ed25519 发布者签名，再校验安装包 SHA-512。更新代理和 HTTPS 镜像可在 **设置 → 外观与编辑器 → 更新网络** 配置。发布签名流程见 [更新签名](docs/update-signing.md)。
</details>

<details>
<summary><b>只读模式是沙箱吗？</b></summary>

不是。审批模式控制的是通过 Pi 发起的工具调用：只读模式仅放行当前项目内可验证路径的内置读取与搜索工具，也会拦截手动 `!` / `!!` 命令。确认模式对项目外或无法验证的读取每次单独询问；记住的命令授权只匹配完整命令文本。「允许修改项目内文件」不覆盖 `.git`、`.pi`、`.gitattributes` 和 `.gitmodules`。这些控制不能限制已安装扩展自身运行的代码。安装或更新资源包会单独确认来源、影响范围及安装脚本风险。脱离 Pi 进程树的后台服务可能在停止任务或退出后继续运行，需要到终端单独停止。
</details>

<details>
<summary><b>撤销能恢复什么？</b></summary>

Git 项目中的文件内容（包括二进制文件、原始换行符和 POSIX 文件权限），受文件数量、单文件 50 MiB 和快照总容量限制。撤销本轮新建的文件会移入回收站。预览会列出因扫描上限等原因未覆盖的路径和子目录；仅改文件名大小写时会保留原文件并恢复名称。中途失败会说明已恢复的文件并刷新文件列表。命令造成的外部副作用（网络请求、数据库、安装的依赖等）无法撤销。
</details>

<details>
<summary><b>数据存在哪里？崩溃后会怎样？</b></summary>

对话就是 Pi 自己的 JSONL 会话文件。桌面端的索引（项目、草稿、设置）保存在应用数据目录，轮换保留三份备份，每次升级前另存一份旧索引。Pi 崩溃后不会自动重发提问，尚未执行的队列会把原始模板命令、附件引用和图片恢复到草稿。配置文件支持 BOM；损坏的 JSON 可在编辑器里修复，界面显示路径及原文提示，保存前会备份原文件。
</details>

<details>
<summary><b>Windows 安装版和便携版可以互相切换吗？</b></summary>

可以。两者使用同一个数据目录，会话、草稿和设置都会保留。v0.7.0 及更早版本需要先手动安装一次当前版本，之后才能使用应用内更新。

Windows 打包（包括 `win-unpacked` 目录）会按 `package.json` → `build.publish` 中的仓库自动生成更新配置，无需手动填写。旧包如果提示缺少自动更新配置，请下载并运行当前版本的 Windows `-setup.exe` 安装包。
</details>

## 参与贡献

欢迎提交 Issue 与 Pull Request！开发环境、测试命令和发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；报告安全漏洞请见 [SECURITY.md](SECURITY.md)。

```bash
git clone https://github.com/yeyuProject/pi-desktop-gui.git
cd pi-desktop-gui
npm ci
npm run dev
```

## 致谢

- 核心智能体引擎基于 [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)。
- 应用图标角色形象参考了上善无形 / [ZipZipPipe](https://www.pixiv.net/artworks/148186519) 创作的 DeepSeek、Claude 与 ChatGPT 社区同人设定（来源说明与非商用署名条款见 [build/icon-source-v2.prompt.txt](build/icon-source-v2.prompt.txt)）。
- 本项目为社区驱动的独立桌面客户端，并非 Pi 官方发行版本。

## 许可证

[MIT](LICENSE) © yeyuProject
