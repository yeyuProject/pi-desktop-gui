import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../electron/agent';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';
import type { Message } from '../shared/types';

const emptyMessage = '会话尚未产生可导出的内容';
const formats = ['html', 'jsonl'] as const;

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-session-export-'));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  const file = path.join(dir, 'session.jsonl');
  const service = new AgentService(store, new Workspace(dir));
  let context: Message[] = [];
  const calls: string[] = [];
  const rpc = {
    closed: false,
    async request(type: string, params?: any): Promise<any> {
      calls.push(type);
      if (type === 'get_state') return { sessionFile: file, sessionName: session.title };
      if (type === 'get_messages') return { messages: context };
      if (type === 'get_commands') return { commands: [] };
      if (type === 'get_available_models') return { models: [] };
      if (type === 'get_available_thinking_levels') return { levels: ['off'] };
      if (type === 'get_session_stats') return { tokens: { total: 0 } };
      if (type === 'export_html') {
        await fs.writeFile(params.outputPath, '<!DOCTYPE html><html><body>Saved conversation</body></html>');
        return;
      }
      throw new Error('Unexpected command ' + type);
    },
    async bridge(method: string) {
      if (method === 'apply_tool_settings') return { activeTools: [] };
      assert.equal(method, 'options');
      return { approvalMode: 'auto' };
    },
  };
  const internal = service as unknown as {
    rpc: typeof rpc | undefined;
    resetSession(id: string, cwd: string): void;
    rebindSession(id: string, resuming: boolean): Promise<void>;
    onEvent(event: any): void;
  };
  internal.rpc = rpc;
  const records = [
    { type: 'session', version: 3, id: session.id, cwd: dir },
    {
      type: 'message',
      id: 'user',
      parentId: null,
      message: { role: 'user', content: 'Saved question', timestamp: 1 },
    },
  ];
  t.after(async () => {
    internal.rpc = undefined;
    service.runtime.status = 'idle';
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    service,
    session,
    file,
    dir,
    internal,
    calls,
    records,
    setContext: (messages: Message[]) => (context = messages),
    async bind(resuming = false) {
      if (resuming) session.file = file;
      internal.resetSession(session.id, dir);
      await internal.rebindSession(session.id, resuming);
    },
    write: (entries = records) =>
      fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'),
    capture: (format: (typeof formats)[number]) =>
      service.captureExport(session.id, format, path.join(dir, 'export.' + format)),
  };
}

for (const format of formats) {
  test(`${format}: untouched sessions with no assigned path retain the empty-export message`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.capture(format), { message: emptyMessage });
    assert.deepEqual(f.calls, [], 'export must not start Pi to discover an empty session');
  });

  test(`${format}: a fresh connected Pi allocation is empty until its file is created`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    assert.equal(f.session.file, f.file);
    assert.equal(f.service.runtime.connected, true);
    assert.deepEqual(f.service.runtime.messages, []);
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    assert.deepEqual(await f.service.history(f.session.id), []);
    await assert.rejects(f.capture(format), { message: emptyMessage });
    await assert.rejects(f.capture(format), { message: emptyMessage });
    assert.equal(f.calls.includes('export_html'), false);
  });

  test(`${format}: a resumed missing history remains a filesystem error, even with an empty context`, async (t) => {
    const f = await fixture(t);
    await f.bind(true);
    assert.deepEqual(f.service.runtime.messages, []);
    await assert.rejects(f.capture(format), { code: 'ENOENT' });
  });

  test(`${format}: a missing populated session is not treated as empty after navigating before its first message`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    f.internal.onEvent({ type: 'message_start', message: f.records[1].message });
    await assert.rejects(f.capture(format), { code: 'ENOENT' });
    f.service.runtime.messages = [];
    await assert.rejects(f.capture(format), { code: 'ENOENT' });
  });

  for (const content of ['', '{broken json}\n'])
    test(`${format}: ${content ? 'corrupt' : 'zero-byte'} files preserve parsing failures`, async (t) => {
      const f = await fixture(t);
      await f.bind();
      await fs.writeFile(f.file, content);
      await assert.rejects(f.capture(format), SyntaxError);
      assert.equal(f.calls.includes('export_html'), false);
    });

  test(`${format}: permission errors are not converted to empty-session errors`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    const denied = Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
    const read = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === f.file) throw denied;
      return read(...args);
    });
    await assert.rejects(f.capture(format), (error) => error === denied);
  });

  test(`${format}: a corrupt history read retires freshness before a later deletion`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    await fs.writeFile(f.file, '{broken json}\n');
    await assert.rejects(f.service.history(f.session.id), /会话文件包含损坏的 JSON 记录/);
    await fs.rm(f.file);
    await assert.rejects(f.capture(format), { code: 'ENOENT' });
  });
}

for (const status of ['starting', 'running', 'retrying', 'compacting'] as const)
  test(`a missing file while ${status} is not classified from an empty live cache`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    f.service.runtime.status = status;
    await assert.rejects(f.capture('jsonl'), { code: 'ENOENT' });
  });

test('disconnecting or resetting a fresh binding does not guess whether the absent history was persisted', async (t) => {
  const f = await fixture(t);
  await f.bind();
  f.service.runtime.connected = false;
  await assert.rejects(f.capture('jsonl'), { code: 'ENOENT' });
  f.internal.resetSession(f.session.id, f.dir);
  f.service.runtime.connected = true;
  await assert.rejects(f.capture('jsonl'), { code: 'ENOENT' });
});

test('message content returned during binding retires the fresh allocation even if the file is missing', async (t) => {
  const f = await fixture(t);
  f.setContext([{ role: 'user', content: 'Observed content' }]);
  await f.bind();
  f.service.runtime.messages = [];
  await assert.rejects(f.capture('jsonl'), { code: 'ENOENT' });
});

for (const read of ['history', 'export'] as const)
  test(`successful ${read} retires the fresh allocation even for a persisted empty branch`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    await f.write([f.records[0]]);
    if (read === 'history') assert.deepEqual(await f.service.history(f.session.id), []);
    else await f.capture('jsonl');
    await fs.rm(f.file);
    await assert.rejects(f.capture('jsonl'), { code: 'ENOENT' });
  });

for (const change of ['runtime', 'file', 'message', 'busy', 'disconnect'] as const)
  test(`a ${change} change during the disk read prevents stale empty-export classification`, async (t) => {
    const f = await fixture(t);
    await f.bind();
    let entered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const missing = Object.assign(new Error('fixture missing history'), { code: 'ENOENT' });
    const read = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === f.file) {
        entered();
        await gate;
        throw missing;
      }
      return read(...args);
    });
    const exporting = assert.rejects(f.capture('jsonl'), (error) => error === missing);
    try {
      await pending;
      if (change === 'runtime') {
        f.internal.resetSession(f.session.id, f.dir);
        f.service.runtime.connected = true;
      } else if (change === 'file') f.session.file = path.join(f.dir, 'replacement.jsonl');
      else if (change === 'message') {
        f.internal.onEvent({ type: 'message_start', message: f.records[1].message });
        f.service.runtime.messages = [];
      } else if (change === 'busy') f.service.runtime.status = 'running';
      else f.service.runtime.connected = false;
    } finally {
      release();
      await exporting;
    }
  });

test('normal and running exports preserve the source file, live partial reply and tool output', async (t) => {
  const f = await fixture(t);
  await f.bind();
  await f.write();
  const original = await fs.readFile(f.file, 'utf8');
  assert.equal((await f.capture('jsonl')).toString(), original);
  assert.match((await f.capture('html')).toString(), /<!DOCTYPE html>/);
  f.service.runtime.status = 'running';
  f.service.runtime.messages.push({ role: 'assistant', content: '<partial & reply>', timestamp: 2 });
  f.service.runtime.tools = [
    { id: 'tool', name: 'bash', args: {}, status: 'running', output: '<tool & output>', startedAt: 1 },
  ];
  const messages = structuredClone(f.service.runtime.messages);
  const entries = (await f.capture('jsonl'))
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(entries.slice(0, 2), f.records);
  assert.equal(entries[2].message.content, '<partial & reply>');
  assert.equal(entries[2].message.stopReason, 'aborted');
  assert.match(entries[2].message.errorMessage, /导出快照/);
  assert.equal(entries[2].parentId, 'user');
  assert.equal(entries[3].parentId, entries[2].id);
  assert.equal(entries[3].customType, 'desktop-export-output');
  assert.deepEqual(entries[3].data, [{ name: 'bash', output: '<tool & output>' }]);
  const html = (await f.capture('html')).toString();
  assert.match(html, /&lt;partial &amp; reply&gt;/);
  assert.match(html, /&lt;tool &amp; output&gt;/);
  assert.deepEqual(f.service.runtime.messages, messages);
  assert.equal(f.service.runtime.status, 'running');
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});
