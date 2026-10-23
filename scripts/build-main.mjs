import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
await build({
  entryPoints: ['electron/pi-bridge.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-electron/pi-bridge.mjs',
  external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai/compat'],
});
await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/main.cjs',
  external: ['electron'],
  sourcemap: true,
  // Worker URLs resolve relative to this bundle in packaged and development launches.
  define: { 'import.meta.url': '__bundleUrl' },
  banner: { js: "const __bundleUrl = require('node:url').pathToFileURL(__filename).href;" },
});
await build({
  entryPoints: ['electron/diff-worker.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-electron/diff-worker.mjs',
});
await build({
  entryPoints: ['electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/preload.cjs',
  external: ['electron'],
  sourcemap: true,
});
await build({
  entryPoints: ['electron/mac-update-helper.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/mac-update-helper.cjs',
});
if (process.platform === 'darwin') {
  const exec = promisify(execFile);
  // A tiny universal helper uses the kernel's atomic directory exchange. No compiler is needed at runtime.
  await exec('/usr/bin/xcrun', [
    'clang',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-Os',
    '-mmacosx-version-min=12.0',
    'build/mac-update-swap.c',
    '-o',
    'dist-electron/mac-update-swap',
  ]);
  await exec('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--timestamp=none',
    'dist-electron/mac-update-swap',
  ]);
}
