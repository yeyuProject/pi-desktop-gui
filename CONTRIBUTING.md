# Contributing to Pi Desktop

Thanks for your interest in improving Pi Desktop! Bug reports, feature ideas, documentation fixes and pull requests are all welcome.

[简体中文说明](#简体中文)

## Before you start

- Search [existing issues](https://github.com/yeyuProject/pi-desktop-gui/issues) first. For larger changes, open an issue to discuss the approach before writing code.
- Security problems should **not** be reported in public issues — see [SECURITY.md](SECURITY.md).
- Pi Desktop is a GUI for the [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Problems with model behavior, tools or the Pi CLI itself usually belong upstream.

## Development setup

Requirements: Node.js `>= 22.19`, Git, and on Windows [Git for Windows](https://git-scm.com/download/win). The pinned Pi version is installed as a dev dependency, so no global Pi is needed for development.

```bash
git clone https://github.com/yeyuProject/pi-desktop-gui.git
cd pi-desktop-gui
npm ci
npm run dev
```

### Useful scripts

| Command                    | What it does                                                                      |
| :------------------------- | :-------------------------------------------------------------------------------- |
| `npm run dev`              | Start Vite + Electron with hot reload                                             |
| `npm run build`            | Type-check and build renderer and main process                                    |
| `npm test`                 | Unit tests                                                                        |
| `npm run test:integration` | Pi RPC and tool-chain integration tests against a local fake model provider       |
| `npm run test:features`    | Feature-level tests (sessions, approval, checkpoints, recovery…) with real Pi     |
| `npm run test:ui`          | Playwright + Electron end-to-end tests                                            |
| `npm run test:update`      | Upgrade regression for real Windows/Linux installers, using a local update server |
| `npm run screenshots`      | Regenerate README screenshots from the built UI (`npm run build` first)           |
| `npm run demo-gif`         | Re-record the README demo GIF (`npm run build` first, needs `ffmpeg`)             |
| `npm run icons`            | Re-export platform icons from the 1024 × 1024 source (needs a desktop session)    |
| `npm run package`          | Build installers for the current OS into `release/`                               |
| `npm run format`           | Format the code with Prettier                                                     |

No test ever talks to a real model provider or reads your own Pi credentials. Setting `PI_DESKTOP_DATA_DIR` isolates app data and disables update checks.

README captures also need Playwright's headless Chromium. Install it once with `npx playwright install chromium --only-shell` (on Linux, use `npx playwright install --with-deps chromium --only-shell`). Run `npm run build` before capturing; the GIF additionally requires `ffmpeg` on `PATH`. These scripts use mock data and a loopback-only server, not your Pi sessions or credentials.

## Project layout

```text
electron/   Main process: windows, IPC, Pi RPC (JSONL over stdio), workspace snapshots, updater
src/        React 19 renderer: components, hooks, features, pure helpers
shared/     Types and policies shared by both processes (IPC contract, approval rules)
scripts/    Build, packaging and end-to-end test scripts
tests/      Unit tests
docs/       Architecture, PRD, release notes and validation records
```

See [docs/architecture.md](docs/architecture.md) for module boundaries, how Pi upgrades are handled, and the recovery model.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep changes focused; one topic per pull request.
3. Add or update tests for behavior changes. Run at least `npm run build`, `npm test` and `npm run test:integration` locally.
4. Run `npm run format`, `npm run format:check` and `npm run lint`.
5. If the change is user-visible, update the README (both [English](README.md) and [中文](README.zh-CN.md)) and, for UI changes, regenerate screenshots with `npm run screenshots` (and `npm run demo-gif` if the demo flow changed).
6. Use a concise commit message in the [Conventional Commits](https://www.conventionalcommits.org/) style, e.g. `fix: keep draft when switching sessions`.

CI checks lint and formatting, and builds/tests on Windows, macOS and Linux. New branch/PR runs cancel superseded checks; release runs are serialized without cancellation. A weekly job also runs the test suite against the latest Pi release.

The `tools/lint` workspace isolates the TypeScript version supported by the ESLint parser. Application builds continue to use the root TypeScript compiler; linting does not replace type checking.

### Line endings

Text files use LF, enforced by `.gitattributes` and Prettier on every platform. Keep LF endings when editing.

## Releasing (maintainers)

1. Bump `version` in `package.json` and the lock file.
2. Add release notes at `docs/releases/v<version>.md`.
3. Push the tag `v<version>`. The tag must match the package version.

The **Build, test and release** workflow then runs the three-platform tests, the Windows/Linux upgrade regression and packaging. On success it creates a **draft** GitHub Release with installers, three platform manifests, blockmaps and SHA-256 checksums. Before publication, independently review the artifacts, sign the manifests outside CI and upload their `.sig` files. Regenerate the checksums to include the signatures, verify the uploaded files, then publish the draft. Follow [independent release signing](docs/update-signing.md); never put the signing private key in GitHub Actions.

You can also run the workflow manually from the Actions tab and download installers from that run's artifacts without publishing.

### Icons

The source icon is `build/icon-source-v2.png` (its generation prompt is in the matching `.prompt.txt`). After `npm run icons`, commit `icon.png`, `icon-mac.png` and `icon.ico`; CI packages these files as-is.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

## 简体中文

欢迎提交 Issue 和 Pull Request。

- 提交前先搜索[已有 Issue](https://github.com/yeyuProject/pi-desktop-gui/issues)；较大的改动请先开 Issue 讨论方案。
- 安全问题请不要公开提交，按 [SECURITY.md](SECURITY.md) 私下报告。
- 本地开发：`npm ci` 后运行 `npm run dev`。开发依赖已锁定 Pi 版本，无需全局安装。
- 提交 PR 前至少运行 `npm run build`、`npm test`、`npm run test:integration` 、`npm run format:check` 和 `npm run lint`。
- 用户可见的改动请同步更新 [README.md](README.md) 与 [README.zh-CN.md](README.zh-CN.md)；界面改动用 `npm run screenshots` 重新生成截图，演示流程有变化时用 `npm run demo-gif` 重录 GIF。
- 首次生成素材前运行 `npx playwright install chromium --only-shell` 安装无头浏览器（Linux 加上 `--with-deps`），再运行 `npm run build`；GIF 还需要 PATH 中有 `ffmpeg`。素材脚本只使用示例数据和本机临时服务器。
- 文本文件统一使用 LF，由 `.gitattributes` 与 Prettier 约束；请保留 LF 换行。
- 模块边界与恢复机制见 [架构说明](docs/architecture.md)，需求与版本记录见 [PRD](docs/PRD.md)。
- 提交即表示同意以 [MIT 许可证](LICENSE) 授权你的贡献。
