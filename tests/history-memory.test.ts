import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('stream change hints allow old raw and derived message arrays to be collected', async () => {
  // A separate process enables real GC without changing the test runner’s flags.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { setImmediate } from 'node:timers/promises';
      import { applyRuntimePatch, emptyRuntime } from ${JSON.stringify(new URL('../shared/types.ts', import.meta.url).href)};
      import { HistoryDeriver, deriveHistory } from ${JSON.stringify(new URL('../src/lib/history-derive.ts', import.meta.url).href)};
      let runtime = { ...emptyRuntime(), sessionId: 'memory', messages: Array.from({ length: 5000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'fixture' })) };
      const history = new HistoryDeriver();
      const raw = [], derived = [];
      for (let i = 0; i < 200; i++) {
        raw.push(new WeakRef(runtime.messages));
        derived.push(new WeakRef(history.derive(runtime.messages)));
        runtime = applyRuntimePatch(runtime, { sessionId: 'memory', messagesFrom: 4999, messages: [{ role: 'assistant', content: 'patch ' + i }], messageCount: 5000, toolsFrom: 0, tools: [], toolCount: 0 });
      }
      history.derive(runtime.messages);
      for (let i = 0; i < 5; i++) { await setImmediate(); global.gc(); }
      await setImmediate();
      const collected = (refs) => refs.filter((ref) => !ref.deref()).length;
      const result = { raw: collected(raw), derived: collected(derived), total: raw.length };
      assert.ok(result.raw > 190 && result.derived > 190, JSON.stringify(result));
      assert.equal(runtime.messages.at(-1).content, 'patch 199');
      assert.deepEqual(history.derive(runtime.messages), deriveHistory(runtime.messages));
      console.log(JSON.stringify(result));
    `,
    ],
    { timeout: 30000, windowsHide: true },
  );
  const result = JSON.parse(stdout);
  assert.ok(result.raw > 190 && result.derived > 190);
});
