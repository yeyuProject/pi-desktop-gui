import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../electron/agent';
import { applyRuntimePatch, emptyRuntime, type Runtime, type RuntimePatch } from '../shared/types';

function service() {
  const s = new AgentService({ state: { selectedSessionId: '' } } as never, {} as never);
  let view: Runtime = emptyRuntime();
  const patches: RuntimePatch[] = [];
  s.on('runtimePatch', (p: RuntimePatch) => {
    patches.push(p);
    view = applyRuntimePatch(view, p);
  });
  return { s, view: () => view, patches };
}

test('runtime patches reproduce the full runtime through streaming, edits and session switches', () => {
  const { s, view, patches } = service();
  const r = s.runtime;
  r.sessionId = 'a';
  for (let i = 0; i < 30; i++)
    r.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i, timestamp: i });
  r.tools.push({ id: 't1', name: 'bash', args: {}, status: 'running', output: '', startedAt: 0 });
  s.publish(true);
  assert.deepEqual(view(), JSON.parse(JSON.stringify(r)));
  assert.equal(patches.at(-1)!.messagesFrom, 0);

  const streaming = { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: 99 };
  r.messages.push(streaming);
  const before = view().messages;
  for (const piece of ['你', '好', '！']) {
    (streaming.content[0] as { text: string }).text += piece;
    s.publish(true);
    assert.equal(patches.at(-1)!.messages.length, 1, 'only the streaming message is sent');
  }
  assert.equal(view().messages[0], before[0], 'unchanged messages keep their identity');
  assert.deepEqual(view(), JSON.parse(JSON.stringify(r)));

  r.tools[0].output = 'line\n'.repeat(3);
  r.tools[0].status = 'done';
  s.publish(true);
  assert.deepEqual(view().tools, JSON.parse(JSON.stringify(r.tools)));
  r.error = 'Rate limit reached';
  r.errorKind = 'busy';
  r.errorCount = 3;
  s.publish(true);
  assert.equal(view().errorKind, 'busy');
  assert.equal(view().errorCount, 3);

  r.messages[3] = { role: 'assistant', content: 'replaced', timestamp: 3 };
  r.messages.splice(10);
  s.publish(true);
  assert.equal(patches.at(-1)!.messagesFrom, 3);
  assert.deepEqual(view(), JSON.parse(JSON.stringify(r)));

  s.runtime = { ...emptyRuntime(), sessionId: 'b' };
  s.runtime.messages.push({ role: 'user', content: 'other session', timestamp: 1 });
  s.publish(true);
  assert.equal(patches.at(-1)!.messagesFrom, 0);
  assert.deepEqual(view(), JSON.parse(JSON.stringify(s.runtime)));

  s.resync();
  s.publish(true);
  assert.equal(patches.at(-1)!.messagesFrom, 0, 'resync sends everything again');
});

test('an older concurrent tool still publishes its final result', () => {
  const { s, view } = service();
  s.runtime.sessionId = 'parallel';
  for (let i = 0; i < 12; i++)
    s.runtime.tools.push({
      id: 'tool-' + i,
      name: 'bash',
      args: {},
      status: 'running',
      output: '',
      startedAt: 0,
    });
  s.publish(true);
  const first = s.runtime.tools[0];
  first.status = 'done';
  first.output = 'finished';
  first.durationMs = 25;
  s.publish(true);
  assert.equal(view().tools[0].status, 'done');
  assert.equal(view().tools[0].output, 'finished');
});

test('scalar and text patches preserve unchanged arrays for cached message rows', () => {
  const { s, view } = service();
  s.runtime.sessionId = 'stable';
  s.runtime.messages.push({ role: 'assistant', content: 'first' });
  s.publish(true);
  const initial = view();
  s.runtime.status = 'running';
  s.publish(true);
  assert.equal(view().messages, initial.messages);
  assert.equal(view().tools, initial.tools);
  s.runtime.messages[0].content = 'updated';
  s.publish(true);
  assert.equal(view().tools, initial.tools);
  assert.notEqual(view().messages, initial.messages);
});

test('streaming omits unchanged catalogs and diagnostics, and clears removed fields', () => {
  const { s, view, patches } = service();
  s.runtime.sessionId = 'catalogs';
  s.runtime.diagnostic = ['diagnostic'.repeat(400)];
  s.runtime.commands = [{ name: 'fixture', source: 'extension' } as never];
  s.runtime.error = 'temporary';
  s.publish(true);
  const first = view();
  s.runtime.messages.push({ role: 'assistant', content: 'stream' });
  delete s.runtime.error;
  s.publish(true);
  const patch = patches.at(-1)!;
  for (const key of ['diagnostic', 'models', 'commands']) assert.ok(!(key in patch), key);
  assert.equal(view().commands, first.commands);
  assert.equal(view().diagnostic, first.diagnostic);
  assert.ok(!('error' in view()));
  s.runtime.diagnostic = [...s.runtime.diagnostic, 'next'];
  s.publish(true);
  assert.deepEqual(view().diagnostic, s.runtime.diagnostic);
  s.resync();
  s.publish(true);
  assert.deepEqual(patches.at(-1)!.commands, s.runtime.commands);
});

test('unchanged user image bodies are encoded once while the reply streams', () => {
  const { s, view } = service();
  s.runtime.sessionId = 'images';
  let reads = 0;
  const image = {
    type: 'image',
    mimeType: 'image/png',
    get data() {
      reads++;
      return 'opaque-image';
    },
  };
  s.runtime.messages = [
    { role: 'user', content: [image] },
    { role: 'assistant', content: 'reply' },
  ];
  s.publish(true);
  const firstReads = reads;
  for (let i = 0; i < 10; i++) {
    s.runtime.messages[1].content += ' more';
    s.publish(true);
  }
  assert.equal(reads, firstReads, 'stable image data must not be re-read/serialized for each token');
  assert.deepEqual(view().messages[0].content, [
    { type: 'image', mimeType: 'image/png', data: 'opaque-image' },
  ]);
});

test('plan scalar patches update, clear, resync and cannot leak across sessions', () => {
  const { s, view, patches } = service();
  s.runtime.sessionId = 'plan-session';
  s.runtime.plan = { turnId: 123, steps: [{ text: 'work', status: 'pending' }] };
  s.publish(true);
  assert.deepEqual(view().plan, s.runtime.plan);
  s.runtime.plan.steps[0].status = 'completed';
  s.runtime.planUpdateRequest = 1;
  s.publish(true);
  assert.equal(view().plan?.steps[0].status, 'completed');
  s.resync();
  s.publish(true);
  assert.deepEqual(patches.at(-1)?.plan, s.runtime.plan);
  s.runtime.plan = null;
  s.publish(true);
  assert.equal(view().plan, null);
  s.runtime = { ...emptyRuntime(), sessionId: 'other' };
  s.publish(true);
  assert.equal(view().plan, undefined);
  assert.equal(view().planUpdateRequest, undefined);
});
