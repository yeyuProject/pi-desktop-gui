import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStore } from '../src/lib/runtime-store';
import { emptyRuntime } from '../shared/types';

test('background tokens do not notify the selected conversation or sidebar', () => {
  const store = new RuntimeStore();
  const a = { ...emptyRuntime(), sessionId: 'a' };
  const b = { ...emptyRuntime(), sessionId: 'b' };
  store.set(a);
  store.set(b);
  let selected = 0,
    sidebar = 0;
  store.subscribe('a', () => selected++);
  store.subscribeActivities(() => sidebar++);
  const before = store.getActivities();
  for (let i = 0; i < 100; i++) store.set({ ...b, messages: [{ role: 'assistant', content: String(i) }] });
  assert.equal(selected, 0);
  assert.equal(sidebar, 0);
  assert.equal(store.getActivities(), before);
  store.set({ ...b, dialogs: [{ id: 'approval' } as never] });
  assert.equal(sidebar, 1);
  assert.equal(store.getActivities().b.pending, 1);
  assert.equal(store.anyRunning, true);
  store.remove('b');
  assert.equal(store.anyRunning, false);
  assert.equal(selected, 0);
});
