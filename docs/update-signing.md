# 独立更新签名

客户端用 `shared/update-trust.ts` 中的 Ed25519 公钥校验清单的原始字节。签名载荷为 UTF-8 `Pi Desktop update v1\n<清单文件名>\n` 后接原始文件；文件名也被签名，不能在平台之间调换。通过签名后才解析清单，再由下载器验证每个安装包的 SHA-512。缺失签名、错误签名、越界文件名、额外 web-installer 载荷均拒绝下载或安装。客户端不接受配置或服务器返回的新公钥。

三份文件分别为 `latest.yml`、`latest-mac.yml`、`latest-linux.yml`，对应的 `.sig` 是 64 字节签名的 Base64 文本。镜像需保持这六份文件和安装包的字节一致。更新检查不使用 GitHub API；代理设置只影响 electron-updater 的独立网络会话。

## 发布操作

手动运行发布工作流时，可以选择 `skip_tests` 跳过本次测试，以加快迭代；默认仍会运行测试。这个选项不会跳过三平台打包、更新文件校验和独立签名。

CI 只创建草稿 Release，永远不持有签名私钥。维护者需独立确认源代码、构建记录和下载的最终安装包，再在保管私钥的环境中运行：

```sh
node --import tsx scripts/sign-updates.ts /path/to/reviewed-release 0.x.y /offline/path/private.pem
```

脚本再次检查三平台清单、版本、文件大小和安装包散列，并验证私钥是否对应应用内置公钥，随后生成三份 `.sig`。请把签名上传到同一草稿 Release，核对六份清单/签名和安装包一致后，才将该 Release 公开。私钥不可进入 Git、构建产物、日志、Actions secrets 或镜像服务器。散列一致不等于代码可信，不能自动签署尚未审查的 CI 产物。

本次实现生成的私钥位于本机 `~/.config/pi-desktop-release-signing/2026-10-24/private.pem`，目录权限 0700、文件权限 0600；仓库只含公钥。该位置是本机保管，不代表已离线。正式发布前应备份到受控离线介质并迁走本机副本。丢失私钥会使现有客户端无法验证后续版本，不能直接替换公钥来修复。

旧客户端尚未内置此公钥，因此必须先安装包含验签逻辑的可信版本。未签名的旧版清单会在新客户端中被拒绝。操作系统的 Developer ID / Authenticode 签名和公证仍是独立事项；此签名不会消除 Gatekeeper / SmartScreen 首次运行提示。

## 校验与故障测试

`tests/review-security-data.test.ts` 验证正确签名、内容篡改、错误公钥、平台调换、签名缺失和文件路径越界。`scripts/test-update.ts` 在隔离身份和数据目录中生成临时签名密钥，通过真实安装包验证端到端更新；回环 HTTP 和临时公钥仅由测试构建替换，不存在生产环境开关。macOS 还测试新版本未到达工作界面就退出时自动回滚。此流程不改动用户已安装的 Pi Desktop。

Node 的 [Ed25519 验签接口](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback) 和 Electron 的 [独立会话代理接口](https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig) 是这里使用的底层接口。
