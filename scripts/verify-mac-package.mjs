import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function verifyMacApp(app) {
  try {
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  } catch (cause) {
    throw new Error(`macOS 应用签名完整性校验失败：${app}`, { cause });
  }
  console.log(`PASS macOS signature integrity: ${app}`);
}

// Run even if signing was accidentally disabled; afterSign is skipped in that case.
export default async function verifyMacPackages(result) {
  if (![...result.platformToTargets.keys()].some((platform) => platform.nodeName === 'darwin')) return [];
  let checked = 0;
  for (const directory of await fs.readdir(result.outDir, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^mac(?:-(?:arm64|universal))?$/.test(directory.name)) continue;
    const output = path.join(result.outDir, directory.name);
    for (const entry of await fs.readdir(output, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      await verifyMacApp(path.join(output, entry.name));
      checked++;
    }
  }
  if (!checked) throw new Error('macOS 打包没有生成可校验的应用。');
  return [];
}
