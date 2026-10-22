import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { transformSync } from 'esbuild';
import { Store } from '../electron/store';
import { SessionAgents } from '../electron/session-agents';
import { Workspace } from '../electron/workspace';
import { type AppEvent, type Message } from '../shared/types';

// Exercise the actual handler without booting Electron or copying its implementation.
// Fail closed if its AST shape changes. IPC transport and rendering are covered by UI tests.
const api = new API();
const config = path.resolve('tsconfig.json');
let source: ts.SourceFile;
try {
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const parsed = snapshot.getProject(config)?.program.getSourceFile(path.resolve('electron/main.ts'));
  assert.ok(parsed, 'Expected the current main.ts source');
  source = parsed;
  snapshot.dispose();
} finally {
  api.close();
}
function variable(name: string) {
  const matches = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => declaration.name.getText(source) === name);
  assert.equal(matches.length, 1, `Expected one ${name} declaration`);
  assert.ok(matches[0].initializer);
  return matches[0].initializer;
}
const handlers = variable('handlers');
assert.ok(ts.isObjectLiteralExpression(handlers));
const selections = handlers.properties
  .filter(ts.isPropertyAssignment)
  .filter((property) => property.name.getText(source) === 'selectSession');
assert.equal(selections.length, 1);
const selection = selections[0];
assert.ok(ts.isPropertyAssignment(selection) && ts.isArrowFunction(selection.initializer));
const textHelpers = source.statements.filter(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'text',
);
assert.equal(textHelpers.length, 1);
const { code } = transformSync(
  `const createHandler = (store, service, send) => {
    ${textHelpers[0].getText(source)}
    return ${selection.initializer.getText(source)};
  };`,
  { loader: 'ts', format: 'cjs' },
);
const createHandler = new Function(`${code}\nreturn createHandler;`)() as (
  store: Store,
  service: SessionAgents,
  send: (event: AppEvent) => void,
) => (id: string) => Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  const result = { promise, settled: false };
  void promise.then(
    () => (result.settled = true),
    () => (result.settled = true),
  );
  return result;
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-selection-'));
  const store = new Store(dir);
  await store.load();
  const sessions = [store.createSession(), store.createSession(), store.createSession()];
  for (const [index, session] of sessions.entries()) {
    session.draft = `draft-${index}`;
    session.file = path.join(dir, `history-${index}.jsonl`);
    await fs.writeFile(
      session.file,
      [
        { type: 'session', cwd: dir },
        { type: 'message', id: 'message', message: { role: 'user', content: `history-${index}` } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );
  }
  const [a, b, c] = sessions;
  store.selectSession(a.id);
  await store.save();
  // Keep per-session ownership, history and persistence; replace only process startup.
  const agents = new SessionAgents(store, new Workspace(dir));
  const current = agents.get(a.id);
  const service = agents.get(b.id);
  for (const session of sessions) {
    const agent = agents.get(session.id);
    t.mock.method(agent, 'connect', async (id: string) => {
      agent.runtime.sessionId = id;
      agent.runtime.connected = true;
    });
  }
  current.runtime.connected = true;
  current.runtime.sessionId = a.id;
  const events: AppEvent[] = [];
  const send = (event: AppEvent) => events.push(structuredClone(event));
  store.on('storage', (storage) => send({ type: 'storage', storage }));
  t.after(async () => {
    await agents.dispose();
    await store.flush().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    store,
    service,
    agents,
    current,
    a,
    b,
    c,
    events,
    selectOnly: createHandler(store, agents, send),
    // Navigation and the selected-session view now have separate responsibilities.
    select: async (id: string) => {
      await createHandler(store, agents, send)(id);
      return agents.get(id).history(id);
    },
    selectedEvents: () => events.filter((event) => event.type === 'state').map((event) => event.state),
    persisted: async () => JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')),
  };
}

function blockWrites(t: TestContext, store: Store, count = 1) {
  const gates = Array.from({ length: count }, () => ({ entered: deferred(), release: deferred() }));
  const snapshots: Store['state'][] = [];
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(store.dir, 'state.json.tmp')) {
      const gate = gates[snapshots.length];
      snapshots.push(JSON.parse(String(args[1])));
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
    }
    return write(...args);
  });
  return { gates, snapshots };
}

test('cold selection restores saved history and draft without starting Pi', async (t) => {
  const f = await fixture(t);
  const connect = t.mock.method(f.service, 'connect', async () => {
    throw new Error('Browsing must not start Pi');
  });
  const terminal = t.mock.method(f.agents, 'inTerminal', async () => {
    throw new Error('Browsing must not wait for terminal ownership checks');
  });
  assert.deepEqual(await f.select(f.b.id), [{ role: 'user', content: 'history-1' }]);
  assert.equal(f.store.state.selectedSessionId, f.b.id);
  assert.equal(f.selectedEvents()[0]?.selectedSessionId, f.b.id);
  assert.equal(f.store.session(f.b.id).draft, 'draft-1');
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(terminal.mock.callCount(), 0);
  assert.equal(f.service.runtime.connected, false);
  assert.equal(f.service.lastSwitch, undefined);
});

test('selection alone does not read history or allocate an agent', async (t) => {
  const f = await fixture(t);
  const get = t.mock.method(f.agents, 'get');
  const history = t.mock.method(f.service, 'history');
  assert.equal(await f.selectOnly(f.b.id), undefined);
  assert.equal(get.mock.callCount(), 0);
  assert.equal(history.mock.callCount(), 0);
  assert.deepEqual(await f.service.history(f.b.id), [{ role: 'user', content: 'history-1' }]);
  assert.equal(history.mock.callCount(), 1);
});

test('selection is visible before its save, and completion still waits for persistence', async (t) => {
  const f = await fixture(t);
  const {
    gates: [gate],
    snapshots,
  } = blockWrites(t, f.store);
  const connect = t.mock.method(f.service, 'connect');
  const history = t.mock.method(f.service, 'history');
  const selected = observe(f.select(f.b.id));
  try {
    await gate.entered.promise;
    const flushed = observe(f.store.flush());
    await nextTurn();
    assert.deepEqual(
      f.selectedEvents().map((state) => state.selectedSessionId),
      [f.b.id],
    );
    assert.equal(snapshots[0].selectedSessionId, f.b.id);
    assert.equal((await f.persisted()).selectedSessionId, f.a.id);
    assert.equal(selected.settled, false);
    assert.equal(flushed.settled, false);
    assert.equal(history.mock.callCount(), 0);
    gate.release.resolve();
    assert.deepEqual(await selected.promise, [{ role: 'user', content: 'history-1' }]);
    await flushed.promise;
    assert.equal((await f.persisted()).selectedSessionId, f.b.id);
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(snapshots.length, 1);
    assert.equal(f.selectedEvents().length, 1);
  } finally {
    gate.release.resolve();
    await selected.promise.catch(() => {});
  }
});

test('browsing remains available during a separately requested connection', async (t) => {
  const f = await fixture(t);
  const entered = deferred(),
    backend = deferred();
  t.mock.method(f.service, 'connect', () =>
    (f.service as any).exclusive(async () => {
      entered.resolve();
      await backend.promise;
      f.service.runtime.connected = true;
      f.service.runtime.sessionId = f.b.id;
    }),
  );
  const connecting = f.service.connect(f.b.id);
  try {
    await entered.promise;
    assert.deepEqual(await f.select(f.b.id), [{ role: 'user', content: 'history-1' }]);
    assert.deepEqual(await f.select(f.c.id), [{ role: 'user', content: 'history-2' }]);
    assert.equal(f.service.hasPendingWork, true);
    assert.equal(f.store.state.selectedSessionId, f.c.id);
    backend.resolve();
    await connecting;
    assert.equal(f.store.state.selectedSessionId, f.c.id);
  } finally {
    backend.resolve();
    await connecting;
  }
});

test('ENOSPC still rejects selection and reports read-only storage after the early state', async (t) => {
  const f = await fixture(t);
  const previous = await f.persisted();
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(f.store.dir, 'state.json.tmp'))
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    return write(...args);
  });
  const history = t.mock.method(f.service, 'history');
  await assert.rejects(f.select(f.b.id), /ENOSPC/);
  await assert.rejects(f.store.flush(), /ENOSPC/);
  assert.deepEqual(
    f.events.map((event) => event.type),
    ['state', 'storage'],
  );
  assert.equal(f.selectedEvents()[0].selectedSessionId, f.b.id);
  assert.equal(f.store.storage.writable, false);
  assert.equal(history.mock.callCount(), 0);
  assert.deepEqual(await f.persisted(), previous);
});

test('read-only browsing emits selection without a backend switch or write', async (t) => {
  const f = await fixture(t);
  const previous = await f.persisted();
  f.store.storage = { writable: false, problem: 'read-only fixture' };
  const connect = t.mock.method(f.service, 'connect');
  const disconnect = t.mock.method(f.service, 'disconnect');
  const save = t.mock.method(f.store, 'save');
  assert.deepEqual(await f.select(f.b.id), [{ role: 'user', content: 'history-1' }]);
  assert.equal(f.selectedEvents()[0].selectedSessionId, f.b.id);
  assert.equal(f.selectedEvents().length, 1);
  assert.equal(connect.mock.callCount() + disconnect.mock.callCount() + save.mock.callCount(), 0);
  assert.deepEqual(await f.persisted(), previous);
});

test('rapid B to C keeps handler histories and draft snapshots separate through the exit flush', async (t) => {
  const f = await fixture(t);
  const {
    gates: [first, second],
    snapshots,
  } = blockWrites(t, f.store, 2);
  const b = observe(f.select(f.b.id));
  let c: ReturnType<typeof observe<Message[]>> | undefined;
  try {
    await first.entered.promise;
    c = observe(f.select(f.c.id));
    await nextTurn();
    assert.deepEqual(
      f.selectedEvents().map((state) => state.selectedSessionId),
      [f.b.id, f.c.id],
    );
    // The renderer saves drafts by session ID; retain the real Store snapshot/queue boundary.
    f.store.session(f.b.id).draft = 'new draft B';
    const draftB = f.store.save();
    f.store.session(f.c.id).draft = 'new draft C';
    const draftC = f.store.save();
    const flushed = observe(f.store.flush());
    const exited = observe(f.service.dispose());
    await nextTurn();
    assert.equal(b.settled || c.settled || flushed.settled || exited.settled, false);
    first.release.resolve();
    await second.entered.promise;
    assert.deepEqual(await b.promise, [{ role: 'user', content: 'history-1' }]);
    assert.equal((await f.persisted()).selectedSessionId, f.b.id);
    assert.equal(c.settled || flushed.settled || exited.settled, false);
    second.release.resolve();
    assert.deepEqual(await c.promise, [{ role: 'user', content: 'history-2' }]);
    await Promise.all([draftB, draftC, flushed.promise, exited.promise]);
    assert.deepEqual(
      snapshots.map((state) => state.selectedSessionId),
      [f.b.id, f.c.id, f.c.id, f.c.id],
    );
    assert.equal(snapshots[1].sessions.find((session) => session.id === f.b.id)?.draft, 'draft-1');
    assert.equal(snapshots[2].sessions.find((session) => session.id === f.b.id)?.draft, 'new draft B');
    assert.equal(snapshots[2].sessions.find((session) => session.id === f.c.id)?.draft, 'draft-2');
    const restored = new Store(f.store.dir);
    await restored.load();
    assert.equal(restored.state.selectedSessionId, f.c.id);
    assert.equal(restored.session(f.a.id).draft, 'draft-0');
    assert.equal(restored.session(f.b.id).draft, 'new draft B');
    assert.equal(restored.session(f.c.id).draft, 'new draft C');
    assert.equal(f.selectedEvents().length, 2);
  } finally {
    first.release.resolve();
    second.release.resolve();
    await Promise.allSettled([b.promise, c?.promise]);
  }
});

for (const status of ['disconnected', 'busy elsewhere'] as const) {
  test(`${status} allows browsing without starting Pi or touching the previous process`, async (t) => {
    const f = await fixture(t);
    f.current.runtime.connected = status !== 'disconnected';
    if (status === 'busy elsewhere') f.current.runtime.status = 'running';
    const connect = t.mock.method(f.service, 'connect');
    const history = t.mock.method(f.service, 'history');
    const {
      gates: [gate],
    } = blockWrites(t, f.store);
    const selected = observe(f.select(f.b.id));
    try {
      await gate.entered.promise;
      await nextTurn();
      assert.equal(f.store.state.selectedSessionId, f.b.id);
      assert.equal(f.selectedEvents()[0].selectedSessionId, f.b.id);
      assert.equal(connect.mock.callCount(), 0);
      assert.equal(f.current.runtime.connected, status !== 'disconnected');
      assert.equal(f.current.runtime.status, status === 'busy elsewhere' ? 'running' : 'idle');
      assert.equal(history.mock.callCount(), 0);
      assert.equal(selected.settled, false);
      gate.release.resolve();
      assert.deepEqual(await selected.promise, [{ role: 'user', content: 'history-1' }]);
      assert.equal(connect.mock.callCount(), 0);
      assert.equal(f.selectedEvents()[0].selectedSessionId, f.b.id);
      assert.equal(f.selectedEvents().length, 1);
    } finally {
      gate.release.resolve();
      await selected.promise.catch(() => {});
    }
  });
}

test('a failed state delivery still waits for the selected-session save and flush', async (t) => {
  const f = await fixture(t);
  const {
    gates: [gate],
  } = blockWrites(t, f.store);
  const history = t.mock.method(f.service, 'history');
  const select = createHandler(f.store, f.agents, () => {
    throw new Error('window closed');
  });
  const selected = observe(select(f.b.id));
  try {
    await gate.entered.promise;
    const flushed = observe(f.store.flush());
    await nextTurn();
    assert.equal(selected.settled, false);
    assert.equal(flushed.settled, false);
    assert.equal(history.mock.callCount(), 0);
    assert.equal((await f.persisted()).selectedSessionId, f.a.id);
    gate.release.resolve();
    await assert.rejects(selected.promise, /window closed/);
    await flushed.promise;
    assert.equal((await f.persisted()).selectedSessionId, f.b.id);
    assert.equal(history.mock.callCount(), 0);
  } finally {
    gate.release.resolve();
    await selected.promise.catch(() => {});
  }
});

test('selecting a running target preserves its process, task and queues', async (t) => {
  const f = await fixture(t);
  Object.assign(f.service.runtime, {
    sessionId: f.b.id,
    connected: true,
    status: 'running',
    startedAt: 1234,
    steering: ['only B'],
  });
  const runtime = f.service.runtime;
  const connect = t.mock.method(f.service, 'connect');
  const disconnect = t.mock.method(f.service, 'disconnect');
  assert.deepEqual(await f.select(f.b.id), runtime.messages);
  assert.equal(f.agents.runtime, runtime);
  assert.equal(runtime.status, 'running');
  assert.equal(runtime.startedAt, 1234);
  assert.deepEqual(runtime.steering, ['only B']);
  assert.equal(connect.mock.callCount() + disconnect.mock.callCount(), 0);
  runtime.status = 'idle';
});

test('repeated clicks and untrusted projects browse history without any connection attempt', async (t) => {
  const f = await fixture(t);
  f.store.state.projects.push({
    id: 'untrusted',
    name: 'Untrusted fixture',
    path: f.store.dir,
    trusted: false,
    createdAt: 0,
  });
  f.b.projectId = 'untrusted';
  const connect = t.mock.method(f.service, 'connect');
  const results = await Promise.all([f.select(f.b.id), f.select(f.c.id), f.select(f.b.id)]);
  assert.deepEqual(results, [
    [{ role: 'user', content: 'history-1' }],
    [{ role: 'user', content: 'history-2' }],
    [{ role: 'user', content: 'history-1' }],
  ]);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(f.store.state.selectedSessionId, f.b.id);
  assert.deepEqual(
    f.selectedEvents().map((s) => s.selectedSessionId),
    [f.b.id, f.c.id, f.b.id],
  );
});

test('cold history fallback is confined to connecting with no live messages', async (t) => {
  const f = await fixture(t);
  f.service.runtime.sessionId = f.b.id;
  f.service.runtime.status = 'starting';
  (f.service as any).connecting = true;
  try {
    assert.deepEqual(await f.service.history(f.b.id), [{ role: 'user', content: 'history-1' }]);
    f.service.runtime.status = 'waiting';
    assert.deepEqual(await f.service.history(f.b.id), [{ role: 'user', content: 'history-1' }]);
    f.service.runtime.messages = [{ role: 'assistant', content: 'live-only' }];
    assert.deepEqual(await f.service.history(f.b.id), f.service.runtime.messages);
    (f.service as any).connecting = false;
    f.service.runtime.status = 'running';
    f.service.runtime.messages = [];
    assert.deepEqual(
      await f.service.history(f.b.id),
      [],
      'a real empty running task must not replay disk history',
    );
  } finally {
    (f.service as any).connecting = false;
    f.service.runtime.status = 'idle';
  }
});
