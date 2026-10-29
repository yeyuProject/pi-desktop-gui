import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workbenchFixture } from './support/workbench-fixture.mjs';

function desktopMock(script, options) {
  if (script === 'scripts/readme-screenshots.mjs') {
    return new Function(
      'window',
      'options',
      `(${workbenchFixture.toString()})(options); return window.desktop;`,
    )({}, options);
  }
  const source = fs.readFileSync(script, 'utf8');
  const start = source.indexOf('const mock = ');
  const end = source.indexOf('\nconst server = ', start);
  assert.ok(start >= 0 && end > start, `Expected standalone README mock in ${script}`);
  // Execute the real browser initializer without starting the CLI/server. The
  // demo's cursor listener is registered but needs no DOM for this API contract.
  return new Function(
    'window',
    'addEventListener',
    'options',
    `${source.slice(start, end)}; mock(options); return window.desktop;`,
  )({}, () => {}, options);
}

for (const [name, script, options] of [
  ['light screenshot', 'scripts/readme-screenshots.mjs', { theme: 'light', approval: false }],
  ['dark screenshot', 'scripts/readme-screenshots.mjs', { theme: 'dark', approval: false }],
  ['approval screenshot', 'scripts/readme-screenshots.mjs', { theme: 'light', approval: true }],
  ['Codex day screenshot', 'scripts/readme-screenshots.mjs', { theme: 'light', uiStyle: 'codex' }],
  ['Codex night screenshot', 'scripts/readme-screenshots.mjs', { theme: 'dark', uiStyle: 'codex' }],
  ['README demo', 'scripts/readme-demo.mjs', undefined],
]) {
  test(`${name} provides versioned independent bootstrap and completion snapshots`, async () => {
    const api = desktopMock(script, options);
    const initial = await api.invoke('bootstrap');
    assert.ok(Number.isSafeInteger(initial.revision) && initial.revision > 0);
    const confirmed = await api.invoke('navigationState');
    assert.ok(Number.isSafeInteger(confirmed?.revision) && confirmed.revision > initial.revision);
    assert.deepEqual(confirmed.state, initial.state);
    const original = structuredClone(initial.state);
    initial.state.sessions[0].title = 'changed bootstrap copy';
    initial.state.settings.theme = 'changed bootstrap copy';
    confirmed.state.sessions[0].draft = 'changed confirmation copy';
    const next = await api.invoke('bootstrap');
    assert.ok(Number.isSafeInteger(next.revision) && next.revision > confirmed.revision);
    assert.deepEqual(next.state, original);
    const latest = await api.invoke('navigationState');
    assert.ok(Number.isSafeInteger(latest.revision) && latest.revision > next.revision);
    assert.deepEqual(latest.state, original);
  });
}
