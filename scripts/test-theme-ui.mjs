// Real Electron regression: run after `npm run build` with `node --import tsx`.
// Linux needs Xvfb plus a window manager for minimize/maximize assertions.
// Renderer screenshots do NOT include native popup menus or OS window controls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.ts';
import { busy } from '../shared/types.ts';
import { hexColor } from './theme-colors.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-theme-ui-'));
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
const store = new Store(dir);
await store.load();
const initial = store.createSession();
const disposable = store.createSession();
disposable.title = '主题回归：可恢复文件';
disposable.file = path.join(dir, 'delete-me.jsonl');
const fileContents = JSON.stringify({ type: 'session', version: 3, id: 'theme-fixture', cwd: dir }) + '\n';
await fs.writeFile(disposable.file, fileContents);
store.selectSession(initial.id);
Object.assign(store.state.settings, {
  piPath: path.resolve('tests/support/fixture-pi.mjs'),
  nodePath: process.execPath,
  agentDir: dir,
  provider: 'fixture',
  modelId: 'test',
  onboardingDone: true,
  theme: 'light',
  notifyOnFinish: false,
});
await store.save();

const palette = {
  light: { background: '#ffffff', color: '#f5f7f6', symbolColor: '#18221f', height: 36 },
  dark: { background: '#121816', color: '#141b18', symbolColor: '#e4ebe8', height: 36 },
  sepia: { background: '#f7f1e3', color: '#efe6d2', symbolColor: '#3a3125', height: 36 },
  green: { background: '#dcebdc', color: '#cfe2d0', symbolColor: '#1c2b20', height: 36 },
  navy: { background: '#0f1828', color: '#0c1422', symbolColor: '#e2e9f3', height: 36 },
  'codex-light': { background: '#ffffff', color: '#f9f9f9', symbolColor: '#0d0d0d', height: 36 },
  'codex-dark': { background: '#181818', color: '#131313', symbolColor: '#dddddd', height: 36 },
};
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const errors = [];
const report = {
  platform: process.platform,
  screenshots: [],
  checks: [],
  skips: [],
  limitations: [
    'Renderer screenshots exclude native popup menus and OS-drawn window buttons.',
    'Window API state assertions do not establish mouse hit targets or OS-drawn pixel colors.',
    'System theme is checked against the runner’s current native appearance; host OS settings are not changed.',
  ],
};
let app, page;
const pass = (description) => {
  report.checks.push(description);
  console.log(`PASS ${description}`);
};
const skip = (description) => {
  report.skips.push(description);
  console.log(`SKIP ${description}`);
};
const focused = (locator) =>
  eventually(
    () => locator.evaluate((node) => document.activeElement === node),
    Boolean,
    'Expected element did not gain focus',
  );
const bootstrap = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
const mainWindowState = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { visible: win.isVisible(), minimized: win.isMinimized(), maximized: win.isMaximized() };
  });
const eventually = async (read, predicate, message, timeout = 15000) => {
  const until = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
};
const screenshot = async (name) => {
  const filename = `theme-${process.platform}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), animations: 'disabled' });
  report.screenshots.push(filename);
};
const connectModel = async () => {
  await page.evaluate(async () => {
    const { state } = await window.desktop.invoke('bootstrap');
    await window.desktop.invoke('connect', state.selectedSessionId);
  });
  await eventually(
    bootstrap,
    ({ state, runtime }) =>
      runtime.sessionId === state.selectedSessionId && runtime.connected && !busy(runtime.status),
    'Explicit model connection did not settle',
  );
  await page.waitForFunction(() => !!document.querySelector('.run-meta .status.idle'));
};

async function launch() {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    // Playwright defaults to light emulation; nativeTheme must own this media query.
    colorScheme: null,
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '任务输入', exact: true }).waitFor();
  await eventually(mainWindowState, (state) => state.visible, 'Application window did not become visible');
  // Preserve production handlers, validation, dialog broker, storage, and native theme.
  // Capture popup dispatch, disposal, and the emergency native-dialog fallback.
  await app.evaluate(({ BrowserWindow, Menu, ipcMain, shell, dialog }, dataDir) => {
    const win = BrowserWindow.getAllWindows()[0];
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    const fixture = (globalThis.themeUi = {
      win,
      handler,
      calls: [],
      events: [],
      overlays: [],
      popups: [],
      trash: [],
      nativeDialogs: [],
      popupMode: 'stub',
      originalPopup: Menu.prototype.popup,
    });
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
      if (channel === 'desktop:event' && ['appDialog', 'appDialogsCancelled'].includes(args[0]?.type))
        fixture.events.push(args[0]);
      return send(channel, ...args);
    };
    if (process.platform !== 'darwin') {
      const setOverlay = win.setTitleBarOverlay.bind(win);
      win.setTitleBarOverlay = (value) => {
        fixture.overlays.push(value);
        return setOverlay(value);
      };
    }
    Menu.prototype.popup = function (options) {
      const root = Menu.getApplicationMenu()?.items.find((item) => item.submenu === this);
      fixture.popups.push({ id: root?.id, x: options.x, y: options.y, windowId: options.window?.id });
      if (fixture.popupMode === 'native') {
        // Exercise the actual OS popup. Close through Electron, not a fake renderer Escape.
        const timer = setTimeout(() => this.closePopup(options.window), 250);
        return fixture.originalPopup.call(this, {
          ...options,
          callback: () => {
            clearTimeout(timer);
            options.callback?.();
          },
        });
      }
      queueMicrotask(() => options.callback?.());
    };
    // Healthy business/quit dialogs must never use this native fallback. Lifecycle tests
    // inject unavailable-renderer events below; their OS fallback is captured and canceled.
    dialog.showMessageBox = async (parent, options) => {
      fixture.nativeDialogs.push({ windowId: parent?.id, ...options });
      return { response: 0, checkboxChecked: false };
    };
    shell.trashItem = async (file) => {
      // CDP callbacks cannot rely on a dynamic-import loader or an ambient require.
      const fs = process.getBuiltinModule('node:fs/promises');
      const path = process.getBuiltinModule('node:path');
      if (path.dirname(file) !== dataDir) throw new Error('Refusing to trash outside isolated fixture');
      const sink = path.join(dataDir, 'recycle-bin');
      await fs.mkdir(sink, { recursive: true });
      await fs.rename(file, path.join(sink, path.basename(file)));
      fixture.trash.push(file);
    };
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      const call = { method, args, done: false };
      fixture.calls.push(call);
      try {
        const result = await handler(event, method, args);
        call.result = result;
        return result;
      } catch (error) {
        call.error = String(error);
        throw error;
      } finally {
        call.done = true;
      }
    });
  }, dir);
  await connectModel();
}

async function checkTheme(source, { changed = false, style = 'classic' } = {}) {
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, source);
  await page.waitForFunction((value) => document.documentElement.dataset.style === value, style);
  const native = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    source: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors,
    background: BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    overlay: globalThis.themeUi.overlays.at(-1),
  }));
  const nativeSource = { sepia: 'light', green: 'light', navy: 'dark' }[source] ?? source;
  assert.equal(native.source, nativeSource, 'Saved appearance must control Electron nativeTheme');
  if (source !== 'system') assert.equal(native.dark, nativeSource === 'dark');
  const effective = source === 'system' ? (native.dark ? 'dark' : 'light') : source;
  const expected = palette[(style === 'codex' ? 'codex-' : '') + effective];
  // Electron's native background has ARGB alpha order; CSS hex tokens below use RGBA.
  assert.equal(hexColor(native.background, 'electron'), hexColor(expected.background));
  await page.waitForFunction(
    (dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
    native.dark,
  );
  const renderer = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const bar = document.querySelector('.native-titlebar');
    return {
      scheme: style.colorScheme,
      rail: style.getPropertyValue('--rail').trim(),
      ink: style.getPropertyValue('--ink').trim(),
      background: style.getPropertyValue('--bg').trim(),
      accent: style.getPropertyValue('--accent').trim(),
      syntaxKeyword: style.getPropertyValue('--syntax-keyword').trim(),
      titlebar: bar
        ? { color: getComputedStyle(bar).color, background: getComputedStyle(bar).backgroundColor }
        : null,
    };
  });
  assert.equal(renderer.scheme, native.dark ? 'dark' : 'light');
  assert.equal(hexColor(renderer.rail), hexColor(expected.color));
  assert.equal(hexColor(renderer.ink), hexColor(expected.symbolColor));
  assert.equal(hexColor(renderer.background), hexColor(expected.background));
  assert.equal(
    hexColor(renderer.accent),
    hexColor(style === 'codex' ? (native.dark ? '#339cff' : '#005fcc') : native.dark ? '#74c7a3' : '#1f6b52'),
  );
  if (source === 'navy') assert.equal(hexColor(renderer.syntaxKeyword), hexColor('#c99cdf'));
  if (process.platform !== 'darwin') {
    assert.equal(renderer.titlebar.background, rgb(expected.color));
    assert.equal(renderer.titlebar.color, rgb(expected.symbolColor));
    if (changed)
      assert.deepEqual(native.overlay, {
        color: expected.color,
        symbolColor: expected.symbolColor,
        height: 36,
      });
  } else assert.equal(renderer.titlebar, null, 'macOS retains native traffic lights and application menu');
  assert.equal((await bootstrap()).state.settings.theme, source);
  assert.equal((await bootstrap()).state.settings.uiStyle, style);
}

async function openAppearance() {
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.waitFor();
  await settings
    .locator('.settings-layout > nav')
    .getByRole('button', { name: '外观与编辑器', exact: true })
    .click();
  return settings;
}
async function chooseTheme(source, style = 'classic') {
  const settings = await openAppearance();
  const callsBefore = await app.evaluate(() => globalThis.themeUi.calls.length);
  await settings.getByRole('button', { name: style === 'codex' ? 'Codex' : 'Pi 经典', exact: true }).click();
  await settings
    .locator('.theme-options')
    .getByRole('button', {
      name: {
        light: style === 'codex' ? '白天' : '浅色',
        dark: style === 'codex' ? '夜晚' : '深色',
        system: '跟随系统',
        sepia: '护眼米黄',
        green: '豆沙绿',
        navy: '深蓝',
      }[source],
      exact: true,
    })
    .click();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  const save = await eventually(
    () =>
      app.evaluate(
        (_electron, { source, after }) =>
          globalThis.themeUi.calls
            .slice(after)
            .findLast((call) => call.method === 'saveSettings' && call.args[0]?.theme === source),
        { source, after: callsBefore },
      ),
    (call) => call?.done,
    'Appearance save IPC did not finish',
  );
  assert.equal(save.error, undefined, 'Appearance save must succeed before its controls are dismissed');
  assert.equal((await bootstrap()).state.settings.theme, source);
  await settings.locator(':scope > footer').getByRole('button', { name: '关闭', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  await checkTheme(source, { changed: true, style });
}

async function checkTitlebarGeometry() {
  if (process.platform === 'darwin') return;
  const bounds = await page.evaluate(() => {
    const bar = document.querySelector('.native-titlebar');
    const safe = document.querySelector('.native-titlebar-safe');
    const overlay = navigator.windowControlsOverlay;
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:env(titlebar-area-x,-1px);top:env(titlebar-area-y,-1px);width:env(titlebar-area-width,0px);height:env(titlebar-area-height,0px);pointer-events:none';
    document.body.append(probe);
    const env = rect(probe);
    probe.remove();
    return {
      bar: rect(bar),
      safe: rect(safe),
      env,
      overlay: overlay ? { visible: overlay.visible, ...overlay.getTitlebarAreaRect().toJSON() } : null,
      buttons: [...safe.querySelectorAll('button')].map((button) => ({
        ...rect(button),
        drag: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
      })),
      drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
      workspace: rect(document.querySelector('.workspace')),
      sidebar: rect(document.querySelector('.sidebar')),
    };
  });
  assert.equal(bounds.bar.y, 0);
  assert.ok(bounds.bar.height >= 36, 'Menu controls keep a usable CSS height at enlarged zoom');
  assert.ok(
    bounds.bar.bottom >= bounds.env.bottom - 1,
    'Titlebar reserves native overlay height at reduced zoom',
  );
  assert.equal(bounds.buttons.length, 3);
  assert.equal(bounds.drag, 'drag');
  assert.ok(bounds.overlay?.visible, 'Electron Window Controls Overlay API must be enabled');
  assert.ok(bounds.env.width > 0 && bounds.env.height > 0, 'Native titlebar CSS environment must be exposed');
  for (const button of bounds.buttons) {
    assert.equal(button.drag, 'no-drag');
    assert.ok(
      button.x >= bounds.env.x - 1 && button.right <= bounds.env.right + 1,
      'Menu buttons must avoid native controls',
    );
    assert.ok(button.y >= 0 && button.bottom <= bounds.bar.bottom);
  }
  assert.ok(bounds.workspace.y >= bounds.bar.bottom, 'Workspace must start below titlebar');
  assert.ok(
    bounds.workspace.y >= bounds.env.bottom - 1,
    'Workspace must never enter the native controls region',
  );
  assert.ok(bounds.sidebar.y >= bounds.bar.bottom, 'Sidebar must start below titlebar');
}

const beginDelete = async (id) => {
  await page.evaluate((sessionId) => {
    // Keep the dialog-triggering IPC pending without blocking the Playwright driver.
    void window.desktop.invoke('deleteSession', sessionId).catch(() => {});
  }, id);
  const box = page.locator('[data-app-dialog]').getByRole('dialog', { name: /^删除会话/ });
  await box.waitFor();
  return box;
};
const latestDelete = () =>
  app.evaluate(() => globalThis.themeUi.calls.findLast((call) => call.method === 'deleteSession'));
const finishDelete = async (expected) => {
  const call = await eventually(latestDelete, (call) => call?.done, 'Delete IPC did not settle');
  assert.equal(call.error, undefined);
  assert.deepEqual(call.result, expected);
  await page.locator('[data-app-dialog]').waitFor({ state: 'hidden' });
};

try {
  await launch();
  await checkTheme('light');
  await checkTitlebarGeometry();
  const menus = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.map((item) => ({
      id: item.id,
      label: item.label,
      role: item.role,
      items: item.submenu?.items.map((child) => ({
        label: child.label,
        role: child.role,
        accelerator: child.accelerator,
      })),
    })),
  );
  const findMenu = (id) => menus.find((item) => item.id === id);
  for (const id of ['file', 'edit', 'view']) assert.ok(findMenu(id), `Native menu ${id} retained`);
  assert.equal(findMenu('file').items.find((item) => item.label === '新建对话').accelerator, 'CmdOrCtrl+N');
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall'])
    assert.ok(
      findMenu('edit').items.some((item) => item.role?.toLowerCase() === role),
      `Native Edit ${role} retained`,
    );
  assert.ok(findMenu('view').items.some((item) => item.role?.toLowerCase() === 'togglefullscreen'));
  for (const [label, accelerator] of [
    ['重置缩放', 'CmdOrCtrl+0'],
    ['放大', 'CmdOrCtrl+Plus'],
    ['缩小', 'CmdOrCtrl+-'],
  ]) {
    assert.equal(findMenu('view').items.find((item) => item.label === label)?.accelerator, accelerator);
  }
  // Persistence uses application-owned zoom actions. Exercise the actual menu callbacks,
  // rather than requiring Electron's non-persisted role implementation.
  const zoom = async (label) =>
    app.evaluate(({ Menu, BrowserWindow }, label) => {
      Menu.getApplicationMenu()
        .getMenuItemById('view')
        .submenu.items.find((item) => item.label === label)
        .click();
      return BrowserWindow.getAllWindows()[0].webContents.getZoomFactor();
    }, label);
  assert.equal(await zoom('重置缩放'), 1);
  assert.ok((await zoom('放大')) > 1);
  assert.equal(await zoom('重置缩放'), 1);
  assert.ok((await zoom('缩小')) < 1);
  assert.equal(await zoom('重置缩放'), 1);
  assert.ok(
    findMenu('file').items.some((item) => item.role === (process.platform === 'darwin' ? 'close' : 'quit')),
  );
  if (process.platform === 'darwin') {
    const roles = menus.flatMap((menu) => menu.items ?? []).map((item) => item.role?.toLowerCase());
    for (const role of ['services', 'hide', 'hideothers', 'unhide', 'quit', 'minimize', 'zoom', 'front'])
      assert.ok(roles.includes(role), `macOS ${role} native role retained`);
  }
  pass('native application menu retains File/Edit/View, platform roles and CmdOrCtrl+N');

  for (const source of ['sepia', 'green', 'navy', 'dark', 'light', 'system']) {
    await chooseTheme(source);
    if (['sepia', 'green', 'navy'].includes(source)) {
      await page.reload();
      await page.getByRole('textbox', { name: '任务输入', exact: true }).waitFor();
      await checkTheme(source);
    }
    await checkTitlebarGeometry();
    await screenshot(source);
    if (source !== 'system' && process.platform !== 'darwin') {
      await app.evaluate(() => {
        globalThis.themeUi.popupMode = 'native';
      });
      const count = await app.evaluate(() => globalThis.themeUi.popups.length);
      await page.locator('.native-titlebar').getByRole('button', { name: '文件', exact: true }).click();
      await eventually(
        () => app.evaluate(() => globalThis.themeUi.popups.length),
        (value) => value > count,
        'Native popup was not invoked',
      );
      await page.waitForFunction(() => !document.querySelector('.native-titlebar [aria-expanded="true"]'));
      await app.evaluate(() => {
        globalThis.themeUi.popupMode = 'stub';
      });
    }
  }
  pass(
    'all six appearance choices synchronize nativeTheme, native background/overlay and renderer CSS; custom themes survive reload',
  );
  pass(
    'light/dark native popup APIs execute; renderer screenshots deliberately make no claim about OS popup pixels',
  );

  // Exercise the production save handler, including partial updates from old callers.
  assert.equal((await bootstrap()).state.settings.uiStyle, 'classic');
  for (const invalid of ['other', '', null, 7]) {
    await assert.rejects(
      page.evaluate((uiStyle) => window.desktop.invoke('saveSettings', { uiStyle }), invalid),
      /界面风格/,
    );
    assert.equal((await bootstrap()).state.settings.uiStyle, 'classic');
  }
  for (const [theme, expected] of [
    ['sepia', 'light'],
    ['green', 'light'],
    ['navy', 'dark'],
  ]) {
    await page.evaluate((theme) => window.desktop.invoke('saveSettings', { theme, uiStyle: 'codex' }), theme);
    await checkTheme(expected, { changed: true, style: 'codex' });
    await page.evaluate(() => window.desktop.invoke('saveSettings', { fontScale: 1 }));
    assert.equal((await bootstrap()).state.settings.uiStyle, 'codex');
    await chooseTheme(theme);
    const settings = await openAppearance();
    await settings.getByRole('button', { name: 'Codex', exact: true }).click();
    await page.waitForFunction(
      (theme) =>
        document.documentElement.dataset.theme === theme &&
        document.documentElement.dataset.style === 'codex',
      expected,
    );
    assert.equal(await settings.locator('.theme-options').getByRole('button').count(), 5);
    assert.equal((await bootstrap()).state.settings.uiStyle, 'classic', 'Preview must not persist');
    await settings.getByRole('button', { name: 'Pi 经典', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), expected);
    await settings.getByRole('button', { name: 'Codex', exact: true }).click();
    await settings.locator(':scope > footer').getByRole('button', { name: '关闭', exact: true }).click();
    await page
      .getByRole('dialog', { name: '放弃尚未保存的修改？', exact: true })
      .getByRole('button', { name: '放弃修改', exact: true })
      .click();
    await settings.waitFor({ state: 'hidden' });
    await checkTheme(theme);
  }
  for (const theme of ['light', 'dark', 'system']) {
    await chooseTheme(theme, 'codex');
    await screenshot('codex-' + theme);
  }
  await chooseTheme('light');
  pass('Codex saves validate and normalize; style preview, cancel and all three saved modes work');

  const beforeShortcut = (await bootstrap()).state.sessions.length;
  await page.getByRole('textbox', { name: '任务输入', exact: true }).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
  await eventually(
    bootstrap,
    (value) => value.state.sessions.length === beforeShortcut + 1,
    'New-session accelerator did not create exactly one session',
  );
  await connectModel();
  pass('Ctrl/Cmd+N creates exactly one session');

  if (process.platform !== 'darwin') {
    const input = page.getByRole('textbox', { name: '任务输入', exact: true });
    const buttons = page.locator('.native-titlebar button');
    await input.focus();
    await page.keyboard.press('F10');
    await focused(buttons.nth(0));
    await page.keyboard.press('ArrowRight');
    await focused(buttons.nth(1));
    await page.keyboard.press('End');
    await focused(buttons.nth(2));
    await page.keyboard.press('Escape');
    await focused(input);
    await page.keyboard.press('Alt');
    await focused(buttons.nth(0));
    assert.equal(await app.evaluate(() => globalThis.themeUi.win.isMenuBarVisible()), false);
    await page.keyboard.press('Escape');
    await focused(input);
    for (const [key, id] of [
      ['f', 'file'],
      ['e', 'edit'],
      ['v', 'view'],
    ]) {
      const count = await app.evaluate(() => globalThis.themeUi.popups.length);
      await page.keyboard.press(`Alt+${key}`);
      await eventually(
        () => app.evaluate(() => globalThis.themeUi.popups.length),
        (value) => value === count + 1,
        `Alt+${key} did not dispatch one popup`,
      );
      const popup = await app.evaluate(() => globalThis.themeUi.popups.at(-1));
      assert.equal(popup.id, id);
      assert.equal(popup.windowId, await app.evaluate(() => globalThis.themeUi.win.id));
      assert.ok(
        Number.isInteger(popup.x) && Number.isInteger(popup.y) && popup.x >= 0 && popup.y > 0,
        `Native menu anchor: ${JSON.stringify(popup)}`,
      );
      await focused(input);
    }
    for (const zoom of [0.8, 1.25]) {
      await app.evaluate(
        ({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
        zoom,
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await checkTitlebarGeometry();
      const rect = await buttons.nth(0).boundingBox();
      await buttons.nth(0).click();
      await page.waitForFunction(() => !document.querySelector('.native-titlebar [aria-expanded="true"]'));
      const popup = await app.evaluate(() => globalThis.themeUi.popups.at(-1));
      assert.equal(popup.x, Math.round(rect.x * zoom));
      assert.equal(popup.y, Math.round((rect.y + rect.height) * zoom));
      assert.equal(await app.evaluate(() => globalThis.themeUi.win.isMenuBarVisible()), false);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await checkTitlebarGeometry();
    pass(
      '80%/125% zoom reserve native control geometry, avoid menu overlap, and convert popup anchors to DIP',
    );
    for (const args of [
      ['unknown', 1, 36],
      ['file', NaN, 36],
      ['edit', 1, Infinity],
      ['view', '1', 36],
    ])
      await assert.rejects(page.evaluate((values) => window.desktop.invoke('showAppMenu', ...values), args));
    const invalidSender = await app.evaluate(async () => {
      const fixture = globalThis.themeUi;
      const outcomes = [];
      for (const event of [
        { sender: null, senderFrame: null },
        { sender: fixture.win.webContents, senderFrame: null },
      ]) {
        try {
          await fixture.handler(event, 'showAppMenu', ['file', 1, 36]);
          outcomes.push('accepted');
        } catch (error) {
          outcomes.push(String(error));
        }
      }
      return outcomes;
    });
    assert.ok(invalidSender.every((error) => /IPC/.test(error)));
    pass(
      'F10/arrows/Escape and Alt+F/E/V preserve editor focus; menu IPC validates arguments and sender/frame',
    );
  }

  // The production native Edit roles operate on the editor selection retained across menu opening.
  // Use Electron's documented role dispatch, not a user-defined click callback or OS mouse claim.
  const editor = page.getByRole('textbox', { name: '任务输入', exact: true });
  await editor.fill('before SELECTED after');
  await editor.evaluate((node) => {
    node.focus();
    node.setSelectionRange(7, 15);
  });
  if (process.platform !== 'darwin') {
    await page.locator('.native-titlebar').getByRole('button', { name: '编辑', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.native-titlebar [aria-expanded="true"]'));
    await focused(editor);
    assert.deepEqual(await editor.evaluate((node) => [node.selectionStart, node.selectionEnd]), [7, 15]);
    await page.keyboard.press('Alt+e');
    await page.waitForFunction(() => !document.querySelector('.native-titlebar [aria-expanded="true"]'));
    await focused(editor);
    assert.deepEqual(await editor.evaluate((node) => [node.selectionStart, node.selectionEnd]), [7, 15]);
  }
  const editRole = (role) =>
    app.evaluate(({ Menu, BrowserWindow }, role) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.focus();
      win.webContents.focus();
      if (process.platform === 'darwin') Menu.sendActionToFirstResponder(`${role}:`);
      else {
        const item = Menu.getApplicationMenu()
          .getMenuItemById('edit')
          .submenu.items.find((item) => item.role === role);
        item.click({}, win, win.webContents);
      }
    }, role);
  await editRole('cut');
  await eventually(
    () => editor.inputValue(),
    (value) => value === 'before  after',
    'Native Cut did not edit the focused textarea',
  );
  await eventually(
    () => app.evaluate(({ clipboard }) => clipboard.readText()),
    (value) => value === 'SELECTED',
    'Native Cut did not populate the system clipboard',
  );
  assert.deepEqual(await editor.evaluate((node) => [node.selectionStart, node.selectionEnd]), [7, 7]);
  await editRole('paste');
  await eventually(
    () => editor.inputValue(),
    (value) => value === 'before SELECTED after',
    'Native Paste did not restore the selected text',
  );
  await editor.fill('');
  pass('native Edit Cut/Paste dispatch edits the focused textarea; opening menu preserves editor selection');

  // Every dismissal route exercises the real app-dialog IPC and preserves the file and session.
  for (const [theme, dismiss] of [
    ['light', 'escape'],
    ['dark', 'backdrop'],
    ['dark', 'close'],
    ['light', 'cancel'],
    ['light', 'enter'],
  ]) {
    await chooseTheme(theme);
    const box = await beginDelete(disposable.id);
    await screenshot(`${theme}-delete-${dismiss}`);
    const count = (await bootstrap()).state.sessions.length;
    await focused(box.locator(':scope > footer').getByRole('button', { name: '取消', exact: true }));
    for (const key of ['n', 'k', ','])
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+${key}`);
    assert.equal(
      await page.getByRole('dialog').count(),
      1,
      'App dialog must block background search/settings shortcuts',
    );
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      Menu.getApplicationMenu()
        .getMenuItemById('file')
        .submenu.items.find((item) => item.label === '新建对话')
        .click({}, win, win.webContents);
    });
    assert.equal(
      (await bootstrap()).state.sessions.length,
      count,
      'App dialog must block background shortcuts',
    );
    if (dismiss === 'enter') await page.keyboard.press('Enter');
    else if (dismiss === 'escape') await page.keyboard.press('Escape');
    else if (dismiss === 'backdrop')
      await page.locator('[data-app-dialog] .modal-backdrop').click({ position: { x: 4, y: 45 } });
    else if (dismiss === 'close')
      await box.locator(':scope > header').getByRole('button', { name: '关闭', exact: true }).click();
    else await box.locator(':scope > footer').getByRole('button', { name: '取消', exact: true }).click();
    await finishDelete(false);
    assert.ok((await bootstrap()).state.sessions.some((item) => item.id === disposable.id));
    assert.equal(await fs.readFile(disposable.file, 'utf8'), fileContents);
    assert.deepEqual(await app.evaluate(() => globalThis.themeUi.trash), []);
  }
  pass(
    'light/dark business confirmations default to Cancel; Enter/Escape/backdrop/Close cancel safely and background shortcuts/native New Session stay blocked',
  );

  // Native-modal equivalence: a second business action cannot run behind a pending dialog.
  const second = await page.evaluate(() => window.desktop.invoke('newSession'));
  await connectModel();
  await beginDelete(disposable.id);
  const firstId = await app.evaluate(
    () => globalThis.themeUi.events.findLast((event) => event.type === 'appDialog').dialog.id,
  );
  await assert.rejects(
    page.evaluate((id) => window.desktop.invoke('deleteSession', id), second.id),
    /请先完成当前确认/,
  );
  await assert.rejects(
    page.evaluate(() => window.desktop.invoke('newSession')),
    /请先完成当前确认/,
  );
  await assert.rejects(page.evaluate((id) => window.desktop.invoke('respondAppDialog', id, -1), firstId));
  await page
    .locator('[data-app-dialog] [role="dialog"] > footer')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await page.locator('[data-app-dialog]').waitFor({ state: 'hidden' });
  await beginDelete(second.id);
  const secondId = await app.evaluate(
    () => globalThis.themeUi.events.findLast((event) => event.type === 'appDialog').dialog.id,
  );
  assert.notEqual(firstId, secondId);
  await page.evaluate((id) => window.desktop.invoke('respondAppDialog', id, 1), firstId);
  assert.ok(
    (await bootstrap()).state.sessions.some((item) => item.id === disposable.id),
    'Stale response must not confirm canceled deletion',
  );
  await page
    .locator('[data-app-dialog] [role="dialog"] > footer')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await page.locator('[data-app-dialog]').waitFor({ state: 'hidden' });
  assert.ok((await bootstrap()).state.sessions.some((item) => item.id === second.id));
  pass(
    'pending confirmation blocks competing actions; independent IDs and invalid/stale responses never grant deletion',
  );

  await beginDelete(disposable.id);
  const pendingId = await app.evaluate(
    () => globalThis.themeUi.events.findLast((event) => event.type === 'appDialog').dialog.id,
  );
  await page.reload();
  await page.getByRole('textbox', { name: '任务输入', exact: true }).waitFor();
  await finishDelete(false);
  await page.evaluate((id) => window.desktop.invoke('respondAppDialog', id, 1), pendingId);
  assert.equal(await fs.readFile(disposable.file, 'utf8'), fileContents);
  assert.ok((await bootstrap()).state.sessions.some((item) => item.id === disposable.id));
  const box = await beginDelete(disposable.id);
  await box.locator(':scope > footer').getByRole('button', { name: '删除', exact: true }).click();
  await finishDelete({ trashed: true });
  assert.equal(
    (await bootstrap()).state.sessions.some((item) => item.id === disposable.id),
    false,
  );
  await assert.rejects(fs.access(disposable.file), { code: 'ENOENT' });
  assert.equal(
    await fs.readFile(path.join(dir, 'recycle-bin', path.basename(disposable.file)), 'utf8'),
    fileContents,
  );
  assert.deepEqual(await app.evaluate(() => globalThis.themeUi.trash), [disposable.file]);
  pass(
    'renderer reload cancels pending deletion; only a fresh explicit confirmation moves the real fixture file to the mocked recycle sink',
  );

  // OS state assertions are independent of screenshot pixels and do not claim mouse hit testing.
  // Bare Xvfb has no WM: report unsupported transitions rather than a false product failure.
  const transition = async (method, property, expected) => {
    await app.evaluate(({ BrowserWindow }, method) => {
      BrowserWindow.getAllWindows()[0][method]();
    }, method);
    try {
      await eventually(
        mainWindowState,
        (state) => state[property] === expected,
        `Native ${method} did not take effect`,
        process.platform === 'linux' && process.env.PI_DESKTOP_REQUIRE_WINDOW_MANAGER !== '1' ? 1500 : 15000,
      );
      return true;
    } catch (error) {
      if (process.platform !== 'linux' || process.env.PI_DESKTOP_REQUIRE_WINDOW_MANAGER === '1') throw error;
      skip(`Linux native ${method}: the current display/window manager did not implement this transition`);
      return false;
    }
  };
  if (await transition('maximize', 'maximized', true)) {
    await checkTitlebarGeometry();
    assert.ok(await transition('unmaximize', 'maximized', false));
    pass('native maximize/unmaximize API state and maximized titlebar geometry');
  }
  const canMinimize = await transition('minimize', 'minimized', true);
  if (canMinimize) {
    assert.ok(await transition('restore', 'minimized', false));
    pass('native minimize/restore API state');
  } else
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].restore();
    });
  if (process.platform === 'darwin') {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    await eventually(mainWindowState, (state) => !state.visible, 'macOS close must hide the app');
    await app.evaluate(({ app }) => {
      app.emit('activate');
    });
    await eventually(mainWindowState, (state) => state.visible, 'macOS activate must reopen the app');
    pass('macOS close/activate preserves hide/reopen behavior');
  }

  await chooseTheme('dark', 'codex');
  await page.reload();
  await page.getByRole('textbox', { name: '任务输入', exact: true }).waitFor();
  await checkTheme('dark', { style: 'codex' });
  await app.close();
  app = undefined;
  await launch();
  await checkTheme('dark', { style: 'codex' });
  await checkTitlebarGeometry();
  pass('saved Codex dark appearance survives renderer reload and a real application restart');

  const sessionId = (await bootstrap()).state.selectedSessionId;
  await page.evaluate((id) => window.desktop.invoke('send', id, 'hold', [], 'steer'), sessionId);
  await eventually(
    bootstrap,
    (value) => value.runtime.status === 'running',
    'Deterministic hold task did not start',
  );
  for (const state of ['visible', 'hidden', ...(canMinimize ? ['minimized'] : [])]) {
    await app.evaluate(({ BrowserWindow }, state) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (state === 'hidden') win.hide();
      else if (state === 'minimized') win.minimize();
    }, state);
    if (state === 'minimized')
      await eventually(mainWindowState, (value) => value.minimized, 'Window did not minimize before quit');
    if (state === 'hidden')
      await eventually(mainWindowState, (value) => !value.visible, 'Window did not hide before quit');
    // Explicit quit, rather than macOS's ordinary hide-on-close behavior.
    await app.evaluate(({ app }) => {
      app.quit();
    });
    const exit = page
      .locator('[data-app-dialog]')
      .getByRole('dialog', { name: 'Pi 仍在执行任务', exact: true });
    await exit.waitFor();
    await eventually(
      mainWindowState,
      (state) => state.visible && !state.minimized,
      'Quit confirmation must restore/show the app',
    );
    await screenshot(`busy-quit-${state}`);
    await exit.locator(':scope > footer').getByRole('button', { name: '留在窗口', exact: true }).click();
    await exit.waitFor({ state: 'hidden' });
    assert.equal((await bootstrap()).runtime.status, 'running');
  }
  pass(
    `busy quit from visible/hidden${canMinimize ? '/minimized' : ''} states restores a visible confirmation; cancellation keeps the task running`,
  );

  assert.deepEqual(
    await app.evaluate(() => globalThis.themeUi.nativeDialogs),
    [],
    'Healthy renderer confirmations must use themed app dialogs, never native showMessageBox',
  );
  for (const lifecycle of ['unresponsive', 'render-process-gone']) {
    const count = await app.evaluate(() => globalThis.themeUi.nativeDialogs.length);
    await app.evaluate(({ app }, lifecycle) => {
      const win = globalThis.themeUi.win;
      win.hide();
      if (lifecycle === 'unresponsive') win.emit('unresponsive');
      else win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      app.quit();
    }, lifecycle);
    await eventually(
      () => app.evaluate(() => globalThis.themeUi.nativeDialogs.length),
      (value) => value === count + 1,
      'Unavailable renderer did not invoke the native quit fallback',
    );
    const fallback = await app.evaluate(() => globalThis.themeUi.nativeDialogs.at(-1));
    assert.equal(fallback.message, 'Pi 仍在执行任务');
    assert.equal(fallback.cancelId, 0);
    assert.equal(fallback.defaultId, 0);
    assert.deepEqual(fallback.buttons, ['留在窗口', '停止并退出']);
    assert.equal(fallback.windowId, await app.evaluate(() => globalThis.themeUi.win.id));
    await eventually(
      mainWindowState,
      (state) => state.visible && !state.minimized,
      'Native fallback must restore/show its owner',
    );
    assert.equal(
      (await bootstrap()).runtime.status,
      'running',
      'Canceling native fallback must not stop the task',
    );
    // A business operation must still fail closed while the renderer is unavailable.
    assert.equal(await page.evaluate((id) => window.desktop.invoke('deleteSession', id), initial.id), false);
    assert.equal(await app.evaluate(() => globalThis.themeUi.nativeDialogs.length), count + 1);
    if (lifecycle === 'unresponsive')
      await app.evaluate(() => {
        globalThis.themeUi.win.emit('responsive');
      });
    else {
      await page.reload();
      await page.getByRole('textbox', { name: '任务输入', exact: true }).waitFor();
    }
  }
  pass(
    'injected unresponsive/crashed renderer lifecycle uses cancel-safe native quit fallback and keeps ordinary business confirmations fail-closed',
  );

  await app.evaluate(({ app }) => {
    app.quit();
  });
  const finalExit = page
    .locator('[data-app-dialog]')
    .getByRole('dialog', { name: 'Pi 仍在执行任务', exact: true });
  await finalExit.waitFor();
  const closed = app.waitForEvent('close');
  await finalExit.locator(':scope > footer').getByRole('button', { name: '停止并退出', exact: true }).click();
  await closed;
  app = undefined;
  pass('explicit Stop and Quit stops the deterministic task and exits Electron');
  assert.deepEqual(errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = String(error?.stack ?? error);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  throw error;
} finally {
  await fs.writeFile(
    path.join(output, `theme-${process.platform}-report.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (app) {
    // Do not let a failed assertion leave a live fixture task or a confirmation hanging CI.
    await page
      ?.evaluate(async () => {
        const { state } = await window.desktop.invoke('bootstrap');
        await window.desktop.invoke('stop', state.selectedSessionId);
      })
      .catch(() => {});
    await app
      .evaluate(({ app }) => {
        app.exit(0);
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
  await fs.rm(dir, { recursive: true, force: true });
}
