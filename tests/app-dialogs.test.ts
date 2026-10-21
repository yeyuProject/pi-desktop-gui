import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDialogRequests } from '../electron/app-dialogs';
import type { AppDialog } from '../shared/app-dialogs';
import { nativeThemeSource, windowTheme } from '../shared/window-theme';
import fs from 'node:fs';

test('confirmation needs an explicit valid reply; stale and duplicate replies cannot confirm', async () => {
  const events: AppDialog[] = [];
  const dialogs = new AppDialogRequests((event) => events.push(event));
  let settled = false;
  const result = dialogs.show({
    message: '删除会话？',
    detail: '移到回收站',
    buttons: ['取消', '删除'],
    defaultId: 1,
  });
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(dialogs.size, 1);
  assert.deepEqual(events[0].buttons, ['取消', '删除']);
  assert.equal(events[0].detail, '移到回收站');
  assert.equal(events[0].cancelId, 0);
  for (const invalid of [-1, 2, NaN, 0.5, Infinity])
    assert.throws(() => dialogs.respond(events[0].id, invalid), /无效/);
  dialogs.respond('unrequested', 1);
  assert.equal(dialogs.size, 1);
  dialogs.respond(events[0].id, 0);
  dialogs.respond(events[0].id, 1);
  assert.deepEqual(await result, { response: 0 });
  assert.equal(dialogs.size, 0);
});

test('independent request identities survive out-of-order responses and cancel safely on renderer loss', async () => {
  const events: AppDialog[] = [];
  const dialogs = new AppDialogRequests((event) => events.push(event));
  const first = dialogs.show({ message: 'first', buttons: ['取消', '确认'] });
  const second = dialogs.show({ message: 'second', buttons: ['确认', '取消'], cancelId: 1 });
  const third = dialogs.show({ message: 'third', buttons: ['取消', '确认'] });
  assert.equal(new Set(events.map((event) => event.id)).size, 3);
  dialogs.respond(events[1].id, 0);
  assert.deepEqual(await second, { response: 0 });
  dialogs.cancelAll();
  assert.deepEqual(await first, { response: 0 });
  assert.deepEqual(await third, { response: 0 });
  assert.equal(dialogs.size, 0);
  dialogs.respond(events[0].id, 1);
  const next = dialogs.show({ message: 'next', buttons: ['继续', '取消'], cancelId: 1 });
  dialogs.cancelAll();
  assert.deepEqual(await next, { response: 1 });
});

test('publication failure resolves to cancellation and invalid cancel options never enter the queue', async () => {
  const dialogs = new AppDialogRequests(() => {
    throw new Error('renderer gone');
  });
  assert.deepEqual(await dialogs.show({ message: 'first', buttons: ['确认', '取消'], cancelId: 1 }), {
    response: 1,
  });
  assert.equal(dialogs.size, 0);
  for (const cancelId of [-1, 2, NaN, 0.5])
    assert.throws(() => dialogs.show({ message: 'invalid', buttons: ['a', 'b'], cancelId }), /无效/);
  assert.throws(() => dialogs.show({ message: 'empty', buttons: [] }), /无效/);
  assert.equal(dialogs.size, 0);
});

test('request buttons are snapshotted and cannot be expanded while confirmation is pending', async () => {
  let current: AppDialog | undefined;
  const dialogs = new AppDialogRequests((event) => {
    current = event;
  });
  const buttons = ['取消', '删除'];
  const result = dialogs.show({ message: 'delete', buttons });
  buttons.push('other');
  assert.deepEqual(current?.buttons, ['取消', '删除']);
  assert.throws(() => dialogs.respond(current!.id, 2), /无效/);
  dialogs.cancelAll();
  await result;
});

test('native window palette agrees with background theme tokens', () => {
  const css = fs.readFileSync(new URL('../src/styles/themes.css', import.meta.url), 'utf8');
  for (const theme of ['sepia', 'green', 'navy'] as const) {
    const start = css.indexOf(`:root[data-theme='${theme}'] {`);
    assert.ok(start >= 0, theme);
    const section = css.slice(start, css.indexOf('}', start));
    const palette = windowTheme(false, theme);
    for (const [token, color] of [
      ['--bg', palette.background],
      ['--rail', palette.color],
      ['--ink', palette.symbolColor],
    ])
      assert.match(section, new RegExp(`${token}: ${color};`));
    assert.equal(nativeThemeSource(theme), theme === 'navy' ? 'dark' : 'light');
  }
});

test('native window palette agrees with light and dark renderer tokens', () => {
  const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  const light = css.slice(0, css.indexOf(":root[data-theme='dark']"));
  const dark = css.slice(
    css.indexOf(":root[data-theme='dark']"),
    css.indexOf('@media (prefers-color-scheme: dark)'),
  );
  for (const [darkMode, section] of [
    [false, light],
    [true, dark],
  ] as const) {
    const palette = windowTheme(darkMode);
    for (const [token, color] of [
      ['--bg', palette.background],
      ['--rail', palette.color],
      ['--ink', palette.symbolColor],
    ])
      assert.match(section, new RegExp(`${token}: ${color};`));
    assert.equal(palette.height, 36);
  }
});
