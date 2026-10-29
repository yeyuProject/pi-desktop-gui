import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { transformSync } from 'esbuild';
import { UI_STYLES, windowTheme } from '../shared/window-theme';

// Exercise current production functions; native transport and pixels are UI-test concerns.
const api = new API();
let source: ts.SourceFile;
try {
  const config = path.resolve('tsconfig.json');
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const parsed = snapshot.getProject(config)?.program.getSourceFile(path.resolve('electron/main.ts'));
  assert.ok(parsed);
  source = parsed;
  snapshot.dispose();
} finally {
  api.close();
}
function helper(name: string, parameters: string, extra = '', result = name) {
  const declarations = source.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(declarations.length, 1, `Expected current ${name} function`);
  const { code } = transformSync(
    `const create = (${parameters}) => { ${extra}; ${declarations[0].getText(source)}; return ${result}; };`,
    { loader: 'ts', format: 'cjs' },
  );
  return new Function(`${code}\nreturn create;`)();
}
const dialogFactory = helper(
  'showAppDialog',
  'window, appDialogsReady, rendererResponsive, dialog, appDialogs, quitting = false',
);
const finishOperation = source.statements.find(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'finishOperation',
);
assert.ok(finishOperation, 'Expected current operation completion helper');
const menuFactory = helper(
  'newSessionFromMenu',
  'store, updates, appDialogs, newSession, showAppDialog, closing = false, quitting = false',
  `let activeOperations = 0; const operationWaiters = new Set(); ${finishOperation.getText(source)}`,
  '{ invoke: newSessionFromMenu, pending: () => activeOperations }',
);
const themeFactory = helper('updateWindowTheme', 'window, nativeTheme, isMac, windowTheme, store');

test('normal confirmations use themed requests and restore/show/focus before publishing', async () => {
  const calls: string[] = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  const show = dialogFactory(
    win,
    true,
    true,
    { showMessageBox: () => assert.fail('Native fallback must not run for a healthy renderer') },
    {
      show: async () => {
        calls.push('publish');
        return { response: 0 };
      },
    },
  );
  assert.deepEqual(await show({ message: 'delete?', cancelId: 0 }), { response: 0 });
  assert.deepEqual(calls, ['restore', 'show', 'focus', 'publish']);
});

test('unavailable renderer cancels ordinary actions; only explicit quit fallback can show native confirmation', async () => {
  for (const [ready, responsive] of [
    [false, true],
    [true, false],
  ]) {
    const calls: string[] = [];
    const options = {
      message: 'Pi 仍在执行任务',
      buttons: ['留在窗口', '停止并退出'],
      cancelId: 0,
      defaultId: 0,
    };
    const show = dialogFactory(
      {
        isDestroyed: () => false,
        isMinimized: () => true,
        restore: () => calls.push('restore'),
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
      },
      ready,
      responsive,
      {
        showMessageBox: async (_win: unknown, value: unknown) => {
          assert.equal(value, options);
          calls.push('native');
          return { response: 1 };
        },
      },
      { show: () => assert.fail('Unavailable renderer must not receive requests') },
    );
    assert.deepEqual(await show(options), { response: 0 });
    assert.deepEqual(calls, []);
    assert.deepEqual(await show(options, true), { response: 1 });
    assert.deepEqual(calls, ['restore', 'show', 'focus', 'native']);
  }
  const show = dialogFactory(undefined, false, false, {}, {});
  assert.deepEqual(await show({ message: 'gone', cancelId: 1 }, true), { response: 1 });
});

test('ordinary business dialogs fail closed while accepted work drains for quit', async () => {
  const show = dialogFactory(
    {
      isDestroyed: () => false,
      isMinimized: () => false,
      show: () => assert.fail('Quitting business action must not show a window'),
      focus: () => assert.fail('Quitting business action must not focus a window'),
    },
    true,
    true,
    { showMessageBox: () => assert.fail('Business action must not use a native dialog') },
    { show: () => assert.fail('Business action must not queue an unanswered dialog') },
    true,
  );
  assert.deepEqual(await show({ message: 'late deletion?', cancelId: 1 }), { response: 1 });
});

test('native new-session menu cannot mutate read-only storage or bypass modal/update/quit guards', async () => {
  let created = 0,
    errors = 0;
  const readonly = menuFactory(
    {
      assertWritable: () => {
        throw new Error('read only');
      },
    },
    { state: { installing: false } },
    { size: 0 },
    async () => {
      created++;
    },
    async () => {
      errors++;
    },
  );
  await readonly.invoke();
  assert.equal(created, 0);
  assert.equal(errors, 1);
  assert.equal(readonly.pending(), 0);
  for (const [size, installing, closing, quitting] of [
    [1, false, false, false],
    [0, true, false, false],
    [0, false, true, false],
    [0, false, false, true],
  ]) {
    const menu = menuFactory(
      { assertWritable: () => assert.fail('Blocked command reached storage') },
      { state: { installing } },
      { size },
      async () => {
        created++;
      },
      async () => {},
      closing,
      quitting,
    );
    await menu.invoke();
    assert.equal(menu.pending(), 0);
  }
  assert.equal(created, 0);
});

test('native new-session menu participates in update persistence barrier and releases it on errors', async () => {
  let resolve!: () => void;
  const saved = new Promise<void>((done) => {
    resolve = done;
  });
  const menu = menuFactory(
    { assertWritable: () => {} },
    { state: { installing: false } },
    { size: 0 },
    () => saved,
    async () => {},
  );
  const pending = menu.invoke();
  assert.equal(menu.pending(), 1);
  resolve();
  await pending;
  assert.equal(menu.pending(), 0);
  const failed = menuFactory(
    { assertWritable: () => {} },
    { state: { installing: false } },
    { size: 0 },
    async () => {
      throw new Error('save failed');
    },
    async () => {},
  );
  await failed.invoke();
  assert.equal(failed.pending(), 0);
});

test('theme changes update native controls only on Windows/Linux and retain macOS controls', () => {
  for (const isMac of [false, true])
    for (const dark of [false, true]) {
      const colors: unknown[] = [],
        overlays: unknown[] = [];
      const apply = themeFactory(
        {
          isDestroyed: () => false,
          setBackgroundColor: (color: string) => colors.push(color),
          setTitleBarOverlay: (overlay: unknown) => overlays.push(overlay),
        },
        { shouldUseDarkColors: dark },
        isMac,
        windowTheme,
        undefined,
      );
      apply();
      const { background, ...overlay } = windowTheme(dark);
      assert.deepEqual(colors, [background]);
      assert.deepEqual(overlays, isMac ? [] : [overlay]);
    }
});

test('background themes paint the native window and title bar with their own palette', () => {
  for (const theme of ['sepia', 'green', 'navy'] as const) {
    const colors: unknown[] = [],
      overlays: unknown[] = [];
    themeFactory(
      {
        isDestroyed: () => false,
        setBackgroundColor: (color: string) => colors.push(color),
        setTitleBarOverlay: (overlay: unknown) => overlays.push(overlay),
      },
      { shouldUseDarkColors: theme === 'navy' },
      false,
      windowTheme,
      { state: { settings: { theme } } },
    )();
    const { background, ...overlay } = windowTheme(theme === 'navy', theme);
    assert.deepEqual(colors, [background]);
    assert.deepEqual(overlays, [overlay]);
    assert.notEqual(background, windowTheme(theme === 'navy').background);
  }
});

test('each appearance paints the native window and titlebar without changing macOS traffic lights', () => {
  for (const uiStyle of UI_STYLES)
    for (const isMac of [true, false])
      for (const dark of [true, false]) {
        const colors: string[] = [],
          overlays: unknown[] = [];
        themeFactory(
          {
            isDestroyed: () => false,
            setBackgroundColor: (color: string) => colors.push(color),
            setTitleBarOverlay: (overlay: unknown) => overlays.push(overlay),
          },
          { shouldUseDarkColors: dark },
          isMac,
          windowTheme,
          { state: { settings: { theme: 'system', uiStyle } } },
        )();
        const { background, ...overlay } = windowTheme(dark, 'system', uiStyle);
        assert.deepEqual(colors, [background]);
        assert.deepEqual(overlays, isMac ? [] : [overlay]);
      }
});
