import { build, Platform } from 'electron-builder';
// Level 5 keeps rebuilds practical without changing application contents.
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '5';
// macOS uses explicit ad-hoc signing; do not select an unrelated keychain certificate.
process.env.CSC_IDENTITY_AUTO_DISCOVERY ??= 'false';
const dir = process.argv.includes('--dir');
const platform = { win32: Platform.WINDOWS, darwin: Platform.MAC, linux: Platform.LINUX }[process.platform];
if (!platform) throw new Error(`不支持在 ${process.platform} 上打包`);
const target = dir ? 'dir' : undefined;
await build({ targets: target ? platform.createTarget(target) : platform.createTarget(), publish: 'never' });
