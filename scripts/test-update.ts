import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { updateSigningPayload } from '../shared/update-signature';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { build as packageApp, Platform } from 'electron-builder';
import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from 'playwright';
import { extractFile } from '@electron/asar';
import { Store } from '../electron/store';
import writeWindowsUpdateFileChecks from './after-sign.mjs';
import { completeExpectedExit } from './expected-exit.ts';
import { testMacUpdateSafety } from './mac-update-safety';

// Build two copies of the production app. Only identity, data directory and update transport differ.
// The fixture has its own installer GUID and never installs or removes the user's Pi Desktop.
if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error('Unsupported update platform');
const exec = promisify(execFile);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-update-roundtrip-')));
const name = 'pi-desktop-update-fixture-' + randomUUID().slice(0, 8);
const guid = randomUUID();
const productName = 'Pi Update Fixture ' + name.slice(-8);
const installDir = path.join(root, 'installed');
const oldVersion = '0.9.0',
  nextVersion = '0.9.1';
const assets = new Map<string, string>();
const fixtureKeys = generateKeyPairSync('ed25519');
const fixturePublicKey = fixtureKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let badChecksum = false;
const requests: string[] = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname.startsWith('/releases/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: 'v' + nextVersion,
          body: '# 本地更新验证\n\n保留草稿、会话和审批模式。',
          draft: false,
          prerelease: false,
        }),
      );
      return;
    }
    const file = assets.get(decodeURIComponent(url.pathname.slice(1)));
    if (!file) {
      res.writeHead(404);
      res.end('fixture asset not found');
      return;
    }
    if (file.endsWith('.yml') && badChecksum) {
      const text = (await fs.readFile(file, 'utf8')).replace(
        /sha512: .+/g,
        'sha512: ' + Buffer.alloc(64).toString('base64'),
      );
      res.end(text);
      return;
    }
    const size = (await fs.stat(file)).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]),
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(file).pipe(res);
    }
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;
const feed = `http://127.0.0.1:${port}/`;
const config = JSON.parse(await fs.readFile('package.json', 'utf8'));
// Electron 44 downloads its binary lazily when required; a fresh npm ci has no dist directory yet.
const electronExecutable = createRequire(import.meta.url)('electron') as string;
const electronDist =
  process.platform === 'darwin'
    ? path.resolve(path.dirname(electronExecutable), '../../..')
    : path.dirname(electronExecutable);
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const previousFixtureSigning = process.env.CSC_FOR_PULL_REQUEST;
if (process.platform === 'darwin') process.env.CSC_FOR_PULL_REQUEST = 'true';
env.PI_OFFLINE = '1';
env.APPIMAGE_EXTRACT_AND_RUN = '1';
delete env.PI_DESKTOP_DATA_DIR;
const startMenuShortcut =
  process.platform === 'win32'
    ? path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs', productName + '.lnk')
    : '';
const fixtureWindowsState = async (target = '') => {
  const { stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
if (-not (Test-Path -LiteralPath $env:PI_UPDATE_LINK)) { throw 'Fixture shortcut is missing' }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($env:PI_UPDATE_LINK)
if ($env:PI_UPDATE_TARGET) {
  $link.TargetPath = $env:PI_UPDATE_TARGET
  $link.WorkingDirectory = [System.IO.Path]::GetDirectoryName($env:PI_UPDATE_TARGET)
  $link.Save()
}
[pscustomobject]@{
  shortcut = $shell.CreateShortcut($env:PI_UPDATE_LINK).TargetPath
  registeredDirectory = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CURRENT_USER\\Software\\' + $env:PI_UPDATE_GUID) -Name InstallLocation).InstallLocation
} | ConvertTo-Json -Compress`,
    ],
    {
      env: { ...env, PI_UPDATE_LINK: startMenuShortcut, PI_UPDATE_TARGET: target, PI_UPDATE_GUID: guid },
      windowsHide: true,
      timeout: 10000,
    },
  );
  return JSON.parse(stdout) as { shortcut: string; registeredDirectory: string };
};
const directorySnapshot = async (directory: string) => {
  const hashes: [string, string][] = [];
  for (const file of (await fs.readdir(directory, { recursive: true })).sort()) {
    const absolute = path.join(directory, file);
    if (!(await fs.stat(absolute)).isFile()) continue;
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    hashes.push([file, hash.digest('hex')]);
  }
  return hashes;
};
let app: ElectronApplication | undefined;
let portableBrowser: Browser | undefined;
let portableProcess: ChildProcess | undefined;
const until = async <T>(check: () => Promise<T>, timeout = 120000): Promise<NonNullable<T>> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check().catch(() => undefined);
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out; inspect fixture ${root}`);
};
const readBoot = (dir: string) =>
  until(async () => JSON.parse(await fs.readFile(path.join(dir, `boot-${nextVersion}.json`), 'utf8')));
const instrument = `
process.env.PI_OFFLINE = '1';
if (process.platform === 'darwin') process.env.DEVELOPER_DIR = '/pi-update-no-xcode-installed';
const fixtureFs = require('node:fs'), fixturePath = require('node:path');
const fixtureRoot = ${JSON.stringify(root)};
const fixtureCase = JSON.parse(fixtureFs.readFileSync(fixturePath.join(fixtureRoot, 'active-case.json'), 'utf8'));
const fixtureElectron = require('electron');
if (fixtureCase.mode === 'startup-failure' && fixtureElectron.app.getVersion() === '${nextVersion}')
  fixtureElectron.app.whenReady().then(() => fixtureElectron.app.exit(9));
const fixtureDefaultDataDir = fixtureElectron.app.getPath('userData');
fixtureElectron.app.setPath('userData', fixtureCase.dataDir);
fixtureElectron.app.on('session-created', session => session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details, callback) => {
  const u = new URL(details.url); const allowed = u.hostname === '127.0.0.1' && u.port === '${port}';
  if (!allowed) fixtureFs.appendFileSync(fixturePath.join(fixtureRoot, 'external-requests.txt'), details.url + '\\n');
  callback({cancel: !allowed});
}));
fixtureElectron.app.on('browser-window-created', (_, window) => window.webContents.once('did-finish-load', async () => {
  try {
    const bootstrap = await window.webContents.executeJavaScript('window.desktop.invoke("bootstrap")');
    fixtureFs.writeFileSync(fixturePath.join(fixtureCase.dataDir, 'boot-' + fixtureElectron.app.getVersion() + '.json'), JSON.stringify({version:fixtureElectron.app.getVersion(),executable:process.execPath,bootstrap,pid:process.pid,defaultDataDir:fixtureDefaultDataDir}));
    if (fixtureElectron.app.getVersion() === '${nextVersion}' || fixtureCase.awaitingRollback) setTimeout(() => fixtureElectron.app.quit(), 2500);
  } catch (error) { fixtureFs.writeFileSync(fixturePath.join(fixtureRoot, 'boot-error.txt'), String(error)); }
}));
`;
try {
  for (const version of [oldVersion, nextVersion]) {
    const stage = path.join(root, version, 'app'),
      out = path.join(root, version, 'out');
    await fs.mkdir(path.join(stage, 'build'), { recursive: true });
    await fs.mkdir(path.join(stage, 'dist-electron'), { recursive: true });
    for (const file of ['icon.png', 'icon-mac.png', 'icon.ico', 'installer.nsh'])
      await fs.copyFile(path.resolve('build', file), path.join(stage, 'build', file));
    if (process.platform === 'win32' && version === nextVersion) {
      const include = path.join(stage, 'build/installer.nsh');
      const source = await fs.readFile(include, 'utf8');
      const marker = '      # Verify every extracted file before copying.';
      assert.ok(source.includes(marker));
      await fs.writeFile(
        include,
        source.replace(
          marker,
          [
            '      ReadEnvStr $R0 PI_UPDATE_FIXTURE_BAD_EXTRACTION',
            '      ${if} $R0 == "1"',
            '        FileOpen $R0 "$OUTDIR\\resources\\app.asar" w',
            '        FileWrite $R0 "truncated fixture file"',
            '        FileClose $R0',
            '      ${endif}',
            marker,
          ].join('\n'),
        ),
      );
    }
    await buildRenderer({
      define: { __APP_VERSION__: JSON.stringify(version) },
      build: { outDir: path.join(stage, 'dist'), emptyOutDir: true },
    });
    await bundle({
      entryPoints: ['electron/main.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(stage, 'dist-electron/main.cjs'),
      external: ['electron'],
      banner: { js: instrument },
      plugins: [
        {
          name: 'loopback-update-feed',
          setup(build) {
            build.onLoad({ filter: /shared[\\/]update-trust\.ts$/ }, async () => ({
              loader: 'ts',
              contents: `export const UPDATE_PUBLIC_KEY = ${JSON.stringify(fixturePublicKey)};`,
            }));
            build.onLoad({ filter: /electron[\\/]update-network\.ts$/ }, async (args) => ({
              loader: 'ts',
              contents: (await fs.readFile(args.path, 'utf8'))
                .replace('https://github.com/yeyuProject/pi-desktop-gui/releases/latest/download/', feed)
                .replace(
                  "url.protocol !== 'https:'",
                  "(url.protocol !== 'https:' && url.hostname !== '127.0.0.1')",
                )
                .replace('env: NodeJS.ProcessEnv = process.env', 'env: NodeJS.ProcessEnv = {}'),
            }));
          },
        },
      ],
    });
    for (const file of [
      'preload.cjs',
      'pi-bridge.mjs',
      ...(process.platform === 'darwin' ? ['mac-update-helper.cjs', 'mac-update-swap'] : []),
    ])
      await fs.copyFile(path.resolve('dist-electron', file), path.join(stage, 'dist-electron', file));
    await fs.writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify({
        name,
        version,
        private: true,
        description: 'Isolated Pi Desktop update test',
        author: 'Pi Desktop tests',
        type: 'module',
        main: 'dist-electron/main.cjs',
      }),
    );
    const platform =
      process.platform === 'win32'
        ? Platform.WINDOWS
        : process.platform === 'darwin'
          ? Platform.MAC
          : Platform.LINUX;
    await packageApp({
      projectDir: stage,
      targets: platform.createTarget(
        process.platform === 'win32'
          ? version === oldVersion
            ? ['nsis', 'portable']
            : 'nsis'
          : process.platform === 'darwin'
            ? 'zip'
            : 'AppImage',
      ),
      publish: 'never',
      config: {
        appId: 'io.yeyuproject.update-test.' + name.slice(-8),
        productName,
        electronVersion: config.devDependencies.electron,
        electronDist,
        directories: { output: out },
        afterSign: writeWindowsUpdateFileChecks,
        files: [...config.build.files],
        compression: 'store',
        win: {
          icon: path.resolve('build/icon.ico'),
          extraResources: config.build.win.extraResources,
          signExecutable: false,
        },
        nsis: {
          ...config.build.nsis,
          guid,
          runAfterFinish: false,
          createDesktopShortcut: false,
          createStartMenuShortcut: true,
        },
        portable: { artifactName: 'Pi-Desktop-${version}-win-x64.exe' },
        mac: { ...config.build.mac, target: 'zip', notarize: false },
        linux: {
          icon: path.resolve('build/icon-mac.png'),
          category: 'Development',
          artifactName: 'Pi-Desktop-${version}-linux-x64.${ext}',
        },
        publish: { provider: 'generic', url: feed },
      },
    });
    if (process.platform === 'win32') {
      const checks = await fs.readFile(path.join(stage, 'build/update-files-x64.nsh'), 'utf8');
      const files = await directorySnapshot(path.join(out, 'win-unpacked'));
      assert.equal(checks.split('${StdUtils.HashFile}').length - 1, files.length);
      for (const [file, hash] of files) {
        const escaped = file.replaceAll('$', () => '$$');
        assert.ok(
          checks.includes('"${DIRECTORY}\\' + escaped + '"\n  ${if} $R0 != "' + hash.toUpperCase() + '"'),
          `${file} must be checked with its final packaged contents`,
        );
      }
    }
    for (const file of await fs.readdir(out))
      if (/\.(?:exe|AppImage|zip|blockmap|yml)$/.test(file)) assets.set(file, path.join(out, file));
  }
  for (const [name, file] of [...assets]) {
    if (!/^latest(?:-mac|-linux)?\.yml$/.test(name)) continue;
    const bytes = await fs.readFile(file);
    const signature = sign(null, updateSigningPayload(name, bytes), fixtureKeys.privateKey).toString(
      'base64',
    );
    await fs.writeFile(file + '.sig', signature);
    assets.set(name + '.sig', file + '.sig');
  }
  if (process.platform === 'darwin') {
    const previousDeveloperDirectory = process.env.DEVELOPER_DIR;
    process.env.DEVELOPER_DIR = '/pi-update-no-xcode-installed';
    try {
      await testMacUpdateSafety(
        root,
        path.join(
          root,
          oldVersion,
          'out',
          process.arch === 'arm64' ? 'mac-arm64' : 'mac',
          productName + '.app',
        ),
        assets.get(`Pi-Desktop-${nextVersion}-mac-${process.arch}.zip`)!,
      );
    } finally {
      if (previousDeveloperDirectory === undefined) delete process.env.DEVELOPER_DIR;
      else process.env.DEVELOPER_DIR = previousDeveloperDirectory;
    }
  }
  const modes =
    process.platform === 'win32'
      ? ['restart', 'stale-shortcut', 'unpacked-restart', 'portable-to-installer', 'on-quit']
      : process.platform === 'darwin'
        ? ['restart', 'startup-failure', 'on-quit']
        : ['restart', 'on-quit'];
  for (const mode of modes) {
    const portable = mode === 'portable-to-installer';
    const unpacked = mode === 'unpacked-restart';
    const restart = mode === 'restart' || mode === 'stale-shortcut' || mode === 'startup-failure' || unpacked;
    const runningDirectory = unpacked ? path.join(root, mode, 'unpacked with spaces') : installDir;
    let otherCopyFiles: [string, string][] | undefined;
    const executable =
      process.platform === 'win32'
        ? path.join(runningDirectory, productName + '.exe')
        : process.platform === 'darwin'
          ? path.join(installDir, productName + '.app/Contents/MacOS', productName)
          : path.join(root, 'current.AppImage');
    const dataDir = path.join(root, mode, 'data');
    const store = new Store(dataDir, oldVersion);
    await store.load();
    const project =
      mode === 'restart'
        ? {
            id: randomUUID(),
            name: '更新失败恢复验证',
            path: path.join(root, mode, 'project'),
            trusted: true,
            createdAt: Date.now(),
          }
        : undefined;
    if (project) {
      await fs.mkdir(project.path, { recursive: true });
      store.state.projects.push(project);
    }
    const session = store.createSession(project?.id);
    session.title = '升级保留测试';
    session.draft = '升级前草稿';
    session.approvalMode = 'confirm';
    Object.assign(store.state.settings, {
      piPath: path.resolve('tests/support/fixture-pi.mjs'),
      nodePath: process.execPath,
      agentDir: dataDir,
      provider: 'fixture',
      modelId: 'test',
      theme: 'dark',
      onboardingDone: true,
      autoDownloadUpdates: true,
    });
    await store.save();
    await fs.writeFile(path.join(root, 'active-case.json'), JSON.stringify({ dataDir, mode }));
    if (process.platform === 'win32' && !portable) {
      await exec(assets.get(`Pi-Desktop-${oldVersion}-win-x64-setup.exe`)!, ['/S', `/D=${installDir}`], {
        windowsHide: true,
        timeout: 180000,
      });
      if (unpacked) {
        const before = await fixtureWindowsState();
        assert.equal(before.shortcut, path.join(installDir, productName + '.exe'));
        assert.equal(before.registeredDirectory, installDir);
        await fs.cp(path.join(root, oldVersion, 'out/win-unpacked'), runningDirectory, { recursive: true });
        otherCopyFiles = await directorySnapshot(installDir);
        const runningFiles = await directorySnapshot(runningDirectory);
        await assert.rejects(
          exec(
            assets.get(`Pi-Desktop-${nextVersion}-win-x64-setup.exe`)!,
            ['/S', '--updated', `/D=${runningDirectory}`],
            {
              env: { ...env, PI_UPDATE_FIXTURE_BAD_EXTRACTION: '1' },
              windowsHide: true,
              timeout: 180000,
            },
          ),
          { code: 1 },
        );
        assert.deepEqual(await directorySnapshot(installDir), otherCopyFiles);
        assert.deepEqual(await directorySnapshot(runningDirectory), runningFiles);
        assert.deepEqual(await fixtureWindowsState(), before);
        console.log('PASS incomplete extraction rejects the update before modifying either directory');
      }
    } else if (process.platform === 'linux') {
      await fs.copyFile(assets.get(`Pi-Desktop-${oldVersion}-linux-x64.AppImage`)!, executable);
      await fs.chmod(executable, 0o755);
    } else if (process.platform === 'darwin') {
      await fs.mkdir(installDir, { recursive: true });
      const app = path.join(installDir, productName + '.app');
      await fs.rm(app, { recursive: true, force: true });
      await exec('/usr/bin/ditto', [
        path.join(
          root,
          oldVersion,
          'out',
          process.arch === 'arm64' ? 'mac-arm64' : 'mac',
          productName + '.app',
        ),
        app,
      ]);
      await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    }
    badChecksum = mode === 'restart';
    let page: Page;
    if (portable) {
      // The NSIS portable launcher hides the child's stderr, which Electron.launch needs.
      // Connect to its real renderer over a local debugging port instead.
      portableProcess = spawn(
        assets.get(`Pi-Desktop-${oldVersion}-win-x64.exe`)!,
        ['--remote-debugging-port=0'],
        { env, windowsHide: true, stdio: 'ignore' },
      );
      const debugPort = await until(
        async () => (await fs.readFile(path.join(dataDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
      );
      portableBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const context = portableBrowser.contexts()[0];
      page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 60000 }));
    } else {
      app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
      app.process().stderr?.on('data', (chunk) => {
        void fs.appendFile(path.join(root, mode + '-stderr.log'), chunk);
      });
      page = await app.firstWindow();
    }
    page.setDefaultTimeout(60000);
    await page.getByRole('textbox', { name: '任务输入' }).waitFor();
    await page.evaluate(() => {
      (window as any).updateStates = [];
      (window as any).updateWorkspaceEvents = [];
      window.desktop.onEvent((event) => {
        if (event.type === 'update') (window as any).updateStates.push(event.update);
        if (event.type === 'workspaceChanged') (window as any).updateWorkspaceEvents.push(event);
      });
    });
    await page.evaluate(() => window.desktop.invoke('checkUpdate'));
    if (badChecksum) {
      await page.waitForFunction(() => (window as any).updateStates.at(-1)?.state === 'error');
      assert.match(await page.evaluate(() => (window as any).updateStates.at(-1).error), /发布者签名/);
      badChecksum = false;
      await page.evaluate(() => window.desktop.invoke('checkUpdate'));
      console.log(
        'PASS changed metadata fails publisher verification before any installer download and permits a clean retry',
      );
    }
    await page.waitForFunction(
      (portable) => (window as any).updateStates.at(-1)?.state === (portable ? 'available' : 'ready'),
      portable,
    );
    if (!portable) {
      await page.evaluate((id) => window.desktop.invoke('send', id, 'hold', [], 'steer'), session.id);
      await assert.rejects(
        page.evaluate(() => window.desktop.invoke('installUpdate')),
        /当前任务或审批/,
      );
      await page.evaluate((id) => window.desktop.invoke('stop', id), session.id);
    }
    const draft = `保留 ${mode} 更新前的新草稿`;
    await page.getByRole('textbox', { name: '任务输入' }).fill(draft);
    if (mode === 'stale-shortcut') {
      const staleExecutable = path.join(root, oldVersion, 'out/win-unpacked', productName + '.exe');
      await fs.access(staleExecutable);
      assert.equal((await fixtureWindowsState(staleExecutable)).shortcut, staleExecutable);
    }
    if (process.platform === 'win32' && mode === 'on-quit') await fs.unlink(startMenuShortcut);
    await page
      .getByRole('button', { name: portable ? 'v0.9.1 可用' : '重启以更新到 v0.9.1', exact: true })
      .click();
    if (mode === 'restart') {
      // Exercise the real main-process recovery path, not just an UpdateService stub.
      // Rename onto a directory fails deterministically on both Windows and Linux.
      const blockedReceipt = path.join(dataDir, 'update-install.json');
      await fs.mkdir(blockedReceipt);
      await page.getByRole('button', { name: '立即重启', exact: true }).click();
      await page.waitForFunction(() => {
        const state = (window as any).updateStates.at(-1);
        return state?.state === 'ready' && !state.installing && !!state.error;
      });
      assert.equal(
        (await page.evaluate(() => window.desktop.invoke('bootstrap'))).update.currentVersion,
        oldVersion,
      );
      await page.evaluate(() => {
        (window as any).updateWorkspaceEvents = [];
      });
      await fs.writeFile(
        path.join(project!.path, 'receipt-recovery.txt'),
        'watcher survives failed update preparation',
      );
      await page.waitForFunction(() =>
        (window as any).updateWorkspaceEvents.some(
          (event: any) =>
            event.changedPaths === undefined || event.changedPaths?.includes('receipt-recovery.txt'),
        ),
      );
      await fs.rmdir(blockedReceipt);
      console.log(
        'PASS real receipt write failure cancels installation, restores workspace notifications and allows retry',
      );
    }
    if (mode === 'startup-failure') {
      await fs.rm(path.join(dataDir, `boot-${oldVersion}.json`), { force: true });
      await fs.writeFile(
        path.join(root, 'active-case.json'),
        JSON.stringify({ dataDir, mode, awaitingRollback: true }),
      );
    }
    const closed = portable
      ? new Promise<void>((resolve) => portableBrowser!.once('disconnected', () => resolve()))
      : app!.waitForEvent('close', { timeout: 120000 });
    const exitingProcess = portable ? portableProcess! : app!.process();
    const exit = await completeExpectedExit(
      async () => {
        if (restart) await page.getByRole('button', { name: '立即重启', exact: true }).click();
        else {
          await page.getByRole('button', { name: '稍后', exact: true }).click();
          await page.evaluate(() => window.desktop.invoke('quit'));
        }
      },
      closed,
      exitingProcess,
      120000,
    );
    console.log(`Exit evidence ${mode}: ${JSON.stringify(exit)}`);
    app = undefined;
    portableBrowser = undefined;
    if (mode === 'startup-failure') {
      const restored = await until(async () =>
        JSON.parse(await fs.readFile(path.join(dataDir, `boot-${oldVersion}.json`), 'utf8')),
      );
      assert.equal(restored.version, oldVersion);
      assert.equal(restored.bootstrap.update.lastInstall.outcome, 'failed');
      assert.equal(
        restored.bootstrap.state.sessions.find((item: any) => item.id === session.id).draft,
        draft,
      );
      assert.equal(
        JSON.parse(
          extractFile(
            path.join(installDir, productName + '.app/Contents/Resources/app.asar'),
            'package.json',
          ).toString(),
        ).version,
        oldVersion,
      );
      await until(async () => {
        try {
          process.kill(restored.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      console.log(
        'PASS new application exits before renderer readiness; old bundle and saved draft are restored automatically',
      );
      continue;
    }
    if (portable)
      await exec(assets.get(`Pi-Desktop-${nextVersion}-win-x64-setup.exe`)!, ['/S', `/D=${installDir}`], {
        windowsHide: true,
        timeout: 180000,
      });
    if (mode === 'on-quit') {
      if (process.platform === 'linux')
        assert.deepEqual(
          await fs.readFile(executable),
          await fs.readFile(assets.get(`Pi-Desktop-${oldVersion}-linux-x64.AppImage`)!),
        );
      else {
        const asar =
          process.platform === 'win32'
            ? path.join(installDir, 'resources/app.asar')
            : path.join(installDir, productName + '.app/Contents/Resources/app.asar');
        assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).version, oldVersion);
      }
      assert.equal(
        JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')).sessions.find(
          (item: any) => item.id === session.id,
        ).draft,
        draft,
      );
      await assert.rejects(fs.access(path.join(dataDir, `boot-${nextVersion}.json`)));
      console.log(
        'PASS normal quit preserves the installed version and saved draft; installation requires an explicit restart',
      );
      continue;
    }
    if (!restart) {
      if (process.platform === 'win32')
        await until(
          async () =>
            JSON.parse(extractFile(path.join(installDir, 'resources/app.asar'), 'package.json').toString())
              .version === nextVersion,
        );
      else if (process.platform === 'linux')
        await until(
          async () =>
            (await fs.stat(executable)).size ===
            (await fs.stat(assets.get(`Pi-Desktop-${nextVersion}-linux-x64.AppImage`)!)).size,
        );
      else
        await until(
          async () =>
            JSON.parse(
              extractFile(
                path.join(installDir, productName + '.app/Contents/Resources/app.asar'),
                'package.json',
              ).toString(),
            ).version === nextVersion,
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const next = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' });
      next.on('error', (error) => console.error(error));
    }
    const boot = await readBoot(dataDir);
    assert.equal(boot.version, nextVersion);
    if (restart) {
      assert.equal(boot.bootstrap.update.lastInstall.outcome, 'completed');
      assert.equal(boot.bootstrap.update.lastInstall.targetVersion, nextVersion);
    }
    if (process.platform === 'win32') {
      assert.equal(boot.executable, executable, 'restart must use the directory that initiated the update');
      assert.equal(
        JSON.parse(extractFile(path.join(runningDirectory, 'resources/app.asar'), 'package.json').toString())
          .version,
        nextVersion,
      );
      if (mode === 'on-quit') await assert.rejects(fs.access(startMenuShortcut), { code: 'ENOENT' });
      else {
        const after = await fixtureWindowsState();
        assert.equal(after.shortcut, path.join(installDir, productName + '.exe'));
        assert.equal(after.registeredDirectory, installDir, 'another copy must retain its installation');
      }
      if (unpacked) {
        assert.deepEqual(await directorySnapshot(installDir), otherCopyFiles);
        assert.equal(
          JSON.parse(extractFile(path.join(installDir, 'resources/app.asar'), 'package.json').toString())
            .version,
          oldVersion,
          'updating an unpacked directory must preserve the other installed copy',
        );
        await assert.rejects(fs.access(path.join(runningDirectory, `Uninstall ${productName}.exe`)), {
          code: 'ENOENT',
        });
      }
    } else if (process.platform === 'darwin') {
      assert.equal(boot.executable, executable);
      await exec('/usr/bin/codesign', [
        '--verify',
        '--deep',
        '--strict',
        path.join(installDir, productName + '.app'),
      ]);
      const backups = (await fs.readdir(installDir)).filter((name) => name.startsWith('.pi-desktop-update-'));
      assert.ok(backups.length > 0, 'an atomic exchange preserves the previous application');
      const versions = await Promise.all(
        backups.map(async (backup) => {
          const previous = path.join(installDir, backup, 'payload', productName + '.app');
          return JSON.parse(
            extractFile(path.join(previous, 'Contents/Resources/app.asar'), 'package.json').toString(),
          ).version;
        }),
      );
      assert.ok(versions.includes(oldVersion));
    }
    const oldBoot = JSON.parse(await fs.readFile(path.join(dataDir, `boot-${oldVersion}.json`), 'utf8'));
    assert.equal(
      boot.defaultDataDir,
      oldBoot.defaultDataDir,
      'package identity must preserve the default data directory',
    );
    const restored = boot.bootstrap.state.sessions.find((item: any) => item.id === session.id);
    assert.equal(restored.draft, draft);
    assert.equal(restored.title, session.title);
    assert.equal(restored.approvalMode, 'confirm');
    assert.equal(boot.bootstrap.state.settings.theme, 'dark');
    assert.equal(boot.bootstrap.state.appVersion, nextVersion);
    await fs.access(path.join(dataDir, `state.pre-${oldVersion}.json`));
    await until(async () => {
      try {
        process.kill(boot.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    console.log(
      `PASS ${process.platform} ${mode}: production app ${oldVersion} -> ${nextVersion}, data and approvals preserved`,
    );
  }
  await assert.rejects(fs.access(path.join(root, 'external-requests.txt')));
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    'test-results/update-roundtrip.json',
    JSON.stringify({ passed: true, platform: process.platform, root, modes, requests }, null, 2),
  );
} catch (error) {
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    'test-results/update-roundtrip.json',
    JSON.stringify(
      { passed: false, platform: process.platform, root, requests, error: String(error) },
      null,
      2,
    ),
  );
  if (app) {
    const page = app.windows()[0];
    if (page && !page.isClosed())
      console.error(
        'Update states:',
        await page.evaluate(() => (window as any).updateStates).catch(() => []),
      );
    if (page && !page.isClosed())
      await page.screenshot({ path: 'test-results/update-roundtrip-failure.png' }).catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  if (portableBrowser) await portableBrowser.close().catch(() => {});
  if (portableProcess && portableProcess.exitCode === null) portableProcess.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.platform === 'win32') {
    const uninstaller = path.join(installDir, `Uninstall ${productName}.exe`);
    if (await fs.stat(uninstaller).catch(() => undefined))
      await exec(uninstaller, ['/S'], { windowsHide: true, timeout: 120000 }).catch((error) =>
        console.error('Fixture uninstall failed:', error.message),
      );
  }
  if (previousFixtureSigning === undefined) delete process.env.CSC_FOR_PULL_REQUEST;
  else process.env.CSC_FOR_PULL_REQUEST = previousFixtureSigning;
  console.log(`Update fixture artifacts: ${root}`);
}
