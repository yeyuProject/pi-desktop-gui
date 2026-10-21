import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { THEMES } from '../shared/window-theme';

// Render the real components without a browser. This checks DOM/name contracts,
// not focus, visibility, or native Electron interactions (covered by the UI script).
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { desktop: { platform: 'linux', invoke: async () => {} } },
});
const { SettingsModal } = await import('../src/components/SettingsModal');
const { TitleBar } = await import('../src/components/TitleBar');
const { Modal } = await import('../src/components/Modal');
const names = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (match) => /aria-label="([^"]*)"/.exec(match[1])?.[1] ?? match[2].replace(/<[^>]*>/g, '').trim(),
  );
const section = (html: string, tag: string) => {
  const found = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
  assert.equal(found.length, 1, `Expected one ${tag} in this fixture`);
  return found[0][1];
};
const once = (labels: string[], expected: string) =>
  assert.equal(labels.filter((label) => label === expected).length, 1, `Expected unique ${expected}`);

test('real appearance dialog has two Close controls, but one scoped footer Close and each exact theme label', () => {
  for (const theme of THEMES) {
    const html = renderToStaticMarkup(
      React.createElement(SettingsModal, {
        settingsOpen: true,
        settingsTab: 'appearance',
        prefs: {
          theme,
          fontScale: 1,
          sidebarWidth: 240,
          inspectorWidth: 380,
          inspectorSplit: 50,
          editorPath: '',
        },
        runtime: { status: 'idle' },
        setSettingsOpen() {},
        setSettingsTab() {},
        setPrefs() {},
        attempt: async () => {},
        saveSettings() {},
        chooseSettingPath() {},
        updatePanel: null,
      } as unknown as React.ComponentProps<typeof SettingsModal>),
    );
    assert.equal((html.match(/role="dialog"/g) ?? []).length, 1);
    assert.match(html, /role="dialog" aria-modal="true" aria-label="设置"/);
    assert.equal(names(html).filter((name) => name === '关闭').length, 2);
    once(names(section(html, 'header')), '关闭');
    once(names(section(html, 'footer')), '关闭');
    once(names(section(html, 'nav')), '外观与编辑器');
    for (const label of ['浅色', '深色', '跟随系统', '护眼米黄', '豆沙绿', '深蓝']) once(names(html), label);
  }
});

test('real titlebar menu labels are unique exact names and macOS has no renderer menu', () => {
  for (const platform of ['linux', 'win32']) {
    window.desktop.platform = platform;
    const html = renderToStaticMarkup(React.createElement(TitleBar));
    assert.deepEqual(names(html), ['文件', '编辑', '视图']);
    assert.equal((html.match(/class="native-titlebar"/g) ?? []).length, 1);
  }
  window.desktop.platform = 'darwin';
  assert.equal(renderToStaticMarkup(React.createElement(TitleBar)), '');
  window.desktop.platform = 'linux';
});

test('real Modal header Close and business fixture footer actions are independently unique', () => {
  for (const [title, labels] of [
    ['删除会话“fixture”？', ['取消', '删除']],
    ['Pi 仍在执行任务', ['留在窗口', '停止并退出']],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(Modal, {
        title,
        close() {},
        children: React.createElement(
          'footer',
          null,
          ...labels.map((label) => React.createElement('button', { key: label }, label)),
        ),
      }),
    );
    once(names(section(html, 'header')), '关闭');
    for (const label of labels) once(names(section(html, 'footer')), label);
  }
});

test('native regression script scopes dialog actions rather than hiding duplicate matches with first/last', () => {
  const script = fs.readFileSync(new URL('../scripts/test-theme-ui.mjs', import.meta.url), 'utf8');
  assert.match(script, /const settings = page\.getByRole\('dialog', \{ name: '设置', exact: true \}\)/);
  assert.match(
    script,
    /settings\.locator\(':scope > footer'\)\.getByRole\('button', \{ name: '关闭', exact: true \}\)/,
  );
  assert.match(script, /await settings\.waitFor\(\{ state: 'hidden' \}\)/);
  assert.match(script, /\(_electron, \{ source, after \}\) =>/);
  assert.doesNotMatch(script, /getByRole\('dialog'\)\.getByRole/);
  assert.doesNotMatch(script, /\.(?:first|last)\(\)/);
  assert.doesNotMatch(script, /getByRole\('textbox', \{ name: '任务输入' \}\)/);
});
