import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { _electron as electron } from 'playwright';
import { launchApp } from './support/desktop-app.mjs';

const script = fs.readFileSync(new URL('../scripts/test-theme-ui.mjs', import.meta.url), 'utf8');
const start = script.indexOf('async function launch() {');
const end = script.indexOf('\nasync function checkTheme(', start);
assert.ok(start >= 0 && end > start);

test('every native appearance launch leaves color scheme to Electron, including restart and packaged mode', async (t) => {
  for (const executablePath of [undefined, '/fixture/Pi Desktop']) {
    const calls = [];
    const stop = new Error('Launch options captured without starting Electron');
    const mock = t.mock.method(electron, 'launch', async (options) => {
      calls.push(options);
      throw stop;
    });
    // Execute the actual launch function only as far as the public Playwright call.
    const launch = new Function(
      'launchApp',
      'path',
      'process',
      'dir',
      'errors',
      `let app, page; ${script.slice(start, end)}; return launch;`,
    )(launchApp, path, { env: { PI_DESKTOP_EXE: executablePath } }, '/isolated-theme-fixture', []);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(launch, (error) => error === stop);
    for (const options of calls) {
      assert.equal(options.colorScheme, null, 'Omitting this option silently emulates light');
      assert.equal(options.executablePath, executablePath);
      assert.deepEqual(options.args, executablePath ? [] : [path.resolve('.')]);
      assert.equal(options.env.PI_DESKTOP_DATA_DIR, '/isolated-theme-fixture');
      assert.equal(options.env.PI_OFFLINE, '1');
      assert.equal(Object.hasOwn(options, 'viewport'), false);
      assert.equal(Object.hasOwn(options, 'headless'), false);
    }
    mock.mock.restore();
  }
});

test('native appearance still checks actual media against nativeTheme without per-page color emulation', () => {
  assert.equal((script.match(/launchApp\(/g) ?? []).length, 1);
  // Suppressing entrance animations is safe; emulating the color scheme would hide native regressions.
  const motionOnly = /\.emulateMedia\(\{\s*reducedMotion: 'reduce'\s*\}\)/g;
  assert.doesNotMatch(script.replace(motionOnly, ''), /\.emulateMedia\(|setEmulatedMedia/);
  assert.match(
    script,
    /\(dark\) => matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches === dark,\s*native\.dark/,
  );
  assert.match(script, /assert\.equal\(native\.source, nativeSource,/);
  assert.match(script, /assert\.equal\(native\.dark, nativeSource === 'dark'\)/);
});

test('native appearance screenshots finish finite entrance animations before capture', async () => {
  const begin = script.indexOf('const screenshot = async (name) => {');
  const end = script.indexOf('\nasync function launch()', begin);
  assert.ok(begin >= 0 && end > begin);
  const captures = [];
  const report = { screenshots: [] };
  const screenshot = new Function(
    'page',
    'path',
    'output',
    'process',
    'report',
    `${script.slice(begin, end)}; return screenshot;`,
  )(
    { screenshot: async (options) => captures.push(options) },
    path,
    '/screenshots',
    { platform: 'darwin' },
    report,
  );
  await screenshot('dark-delete');
  assert.deepEqual(captures, [
    { path: path.join('/screenshots', 'theme-darwin-dark-delete.png'), animations: 'disabled' },
  ]);
  assert.deepEqual(report.screenshots, ['theme-darwin-dark-delete.png']);
});

test('actual recycle stub moves only fixture files without a VM import callback or global require', async () => {
  const begin = script.indexOf('    shell.trashItem = async (file) => {');
  const end = script.indexOf('\n    ipcMain.removeHandler(', begin);
  assert.ok(begin >= 0 && end > begin);
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-theme-recycle-test-'));
  try {
    const dataDir = path.join(root, 'data');
    await fs.promises.mkdir(dataDir);
    const file = path.join(dataDir, '中文 fixture.jsonl');
    const outside = path.join(root, 'outside.jsonl');
    await fs.promises.writeFile(file, 'session fixture\n');
    await fs.promises.writeFile(outside, 'untouched\n');
    const fixture = { trash: [] };
    // The CDP-evaluated closure has process, but no ESM loader or ambient require.
    const context = vm.createContext({ process, shell: {}, fixture, dataDir });
    assert.equal(vm.runInContext('typeof require', context), 'undefined');
    const trashItem = vm.runInContext(`${script.slice(begin, end)}; shell.trashItem`, context);
    await assert.rejects(trashItem(outside), /Refusing to trash outside isolated fixture/);
    assert.equal(await fs.promises.readFile(outside, 'utf8'), 'untouched\n');
    assert.deepEqual(fixture.trash, []);
    await trashItem(file);
    await assert.rejects(fs.promises.access(file), { code: 'ENOENT' });
    assert.equal(
      await fs.promises.readFile(path.join(dataDir, 'recycle-bin', path.basename(file)), 'utf8'),
      'session fixture\n',
    );
    assert.deepEqual(fixture.trash, [file]);
    await assert.rejects(trashItem(file), { code: 'ENOENT' });
    assert.deepEqual(fixture.trash, [file], 'Failed moves must not be recorded as successful disposal');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
