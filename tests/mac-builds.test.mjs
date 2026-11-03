import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import {
  macBuildOutput,
  macTestApp,
  packagedExecutable,
  unregisterMacTestApp,
} from '../scripts/mac-builds.mjs';

const project = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const { default: beforePack } = await import(new URL('../' + project.build.beforePack, import.meta.url));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-build-isolation-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('the configured packaging hook rejects indexed Mac outputs before creating an app', async (t) => {
  const root = await fixture(t);
  for (const relative of ['release/mac-arm64', 'almost.noindex-backup/mac']) {
    const appOutDir = path.join(root, relative);
    await assert.rejects(beforePack({ electronPlatformName: 'darwin', appOutDir }), /\.noindex/);
    assert.deepEqual(await fs.readdir(appOutDir), []);
  }
  await beforePack({
    electronPlatformName: 'darwin',
    appOutDir: path.join(root, 'mac-builds.noindex', 'mac-arm64'),
  });
  for (const platform of ['win32', 'linux']) {
    const appOutDir = path.join(root, platform);
    await beforePack({ electronPlatformName: platform, appOutDir });
    await assert.rejects(fs.access(appOutDir), { code: 'ENOENT' });
  }
});

test('a noindex symlink cannot redirect a Mac build into an indexed folder', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix symlink permissions');
  const root = await fixture(t);
  const indexed = path.join(root, 'indexed');
  await fs.mkdir(indexed);
  await fs.symlink(indexed, path.join(root, 'fake.noindex'));
  await assert.rejects(
    beforePack({ electronPlatformName: 'darwin', appOutDir: path.join(root, 'fake.noindex', 'mac') }),
    /\.noindex/,
  );
});

test('test cleanup only selects real apps inside excluded build directories', async (t) => {
  const root = await fixture(t);
  const executable = async (directory) => {
    const file = path.join(directory, 'Pi Desktop.app/Contents/MacOS/Pi Desktop');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'test executable');
    return file;
  };
  const protectedApp = path.join(root, 'test-builds.noindex');
  assert.equal(
    await macTestApp(await executable(protectedApp), protectedApp),
    path.join(protectedApp, 'Pi Desktop.app'),
  );
  const installed = await executable(path.join(root, 'Applications'));
  assert.equal(await macTestApp(installed, protectedApp), undefined);
  assert.equal(
    await macTestApp(await executable(path.join(root, 'unrelated.noindex')), protectedApp),
    undefined,
  );
  assert.equal(await macTestApp(path.join(root, 'missing.app/Contents/MacOS/Pi'), protectedApp), undefined);
  assert.equal(await macTestApp(undefined), undefined);
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'alias.noindex');
    await fs.symlink(path.dirname(path.dirname(path.dirname(installed))), alias);
    assert.equal(await macTestApp(path.join(alias, 'Contents/MacOS/Pi Desktop'), alias), undefined);
  }
});

test('packaged acceptance uses protected Mac output and retains the Windows location', () => {
  for (const arch of ['arm64', 'x64', 'universal']) {
    assert.equal(
      packagedExecutable('darwin', arch),
      path.resolve(
        'release/mac-builds.noindex',
        arch === 'x64' ? 'mac' : 'mac-' + arch,
        'Pi Desktop.app/Contents/MacOS/Pi Desktop',
      ),
    );
  }
  assert.equal(packagedExecutable('win32'), path.resolve('release/win-unpacked/Pi Desktop.exe'));
});

test('native Mac test registration is removed and repeated cleanup is harmless', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS Launch Services');
  const exec = promisify(execFile);
  const registry =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-registration-test-')));
  const buildRoot = path.join(root, 'apps.noindex');
  const app = path.join(buildRoot, 'Pi Registration Test.app');
  const executable = path.join(app, 'Contents/MacOS/fixture');
  try {
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.copyFile('/usr/bin/true', executable);
    await fs.writeFile(
      path.join(app, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.yeyuproject.registration-test.${randomUUID()}</string>
<key>CFBundleName</key><string>Pi Registration Test</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
    await exec(registry, ['-f', app]);
    const dump = async () => (await exec(registry, ['-dump'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
    assert.ok((await dump()).includes(app), 'the fixture must be registered before testing cleanup');
    await unregisterMacTestApp(executable, buildRoot);
    await unregisterMacTestApp(executable, buildRoot);
    assert.ok(!(await dump()).includes(app), 'test app registration must be removed');
  } finally {
    await unregisterMacTestApp(executable, buildRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release upload paths follow each platform output without uploading unpacked apps', async () => {
  const workflow = yaml.load(
    await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  const job = workflow.jobs.package;
  const expression = job.env.PACKAGE_OUTPUT.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const output = new Function('matrix', `return (${expression})`);
  for (const os of job.strategy.matrix.os)
    assert.equal(
      output({ os }),
      os === 'macos-latest' ? macBuildOutput.split(path.sep).join('/') : 'release',
    );
  const upload = job.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  for (const pattern of upload.with.path.trim().split('\n'))
    assert.match(
      pattern,
      /^\$\{\{ env\.PACKAGE_OUTPUT \}\}\/(?:\*\.(?:exe|dmg|zip|AppImage|deb|blockmap)|latest\*\.yml)$/,
    );
});
