import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { transformSync } from 'esbuild';
import { Store } from '../electron/store';
import { AgentService } from '../electron/agent';
import { SessionAgents } from '../electron/session-agents';
import { Workspace } from '../electron/workspace';
import { validateImages } from '../electron/images';
import { PiRpc } from '../electron/rpc';
import { composeDraftText } from '../shared/draft';
import type { AppEvent, StateSnapshot } from '../shared/types';

// Compile the production IPC handlers/boundaries, rather than copying their behavior.
// Actual Electron transport and renderer behavior have a separate real UI regression.
const api = new API();
const config = path.resolve('tsconfig.json');
let source: ts.SourceFile;
try {
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const parsed = snapshot.getProject(config)?.program.getSourceFile(path.resolve('electron/main.ts'));
  assert.ok(parsed);
  source = parsed;
  snapshot.dispose();
} finally {
  api.close();
}
function nodes(predicate: (node: ts.Node) => boolean) {
  const matches: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node);
    node.forEachChild(visit);
  }
  visit(source);
  return matches;
}
function one(predicate: (node: ts.Node) => boolean) {
  const matches = nodes(predicate);
  assert.equal(matches.length, 1, 'Expected exactly one production boundary');
  return matches[0];
}
function namedFunction(name: string) {
  return one((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
function initializer(name: string) {
  const declaration = one((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(ts.isVariableDeclaration(declaration) && declaration.initializer);
  return declaration.initializer.getText(source);
}
const handlers = one((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'handlers');
assert.ok(ts.isVariableDeclaration(handlers) && handlers.initializer);
assert.ok(ts.isObjectLiteralExpression(handlers.initializer));
function handler(name: string) {
  assert.ok(ts.isVariableDeclaration(handlers) && handlers.initializer);
  assert.ok(ts.isObjectLiteralExpression(handlers.initializer));
  const found = handlers.initializer.properties.filter(
    (property) => ts.isPropertyAssignment(property) && property.name.getText(source) === name,
  );
  assert.equal(found.length, 1, name);
  return found[0].getText(source);
}
function compile(body: string, dependencies: Record<string, unknown>) {
  const { code } = transformSync(body, { loader: 'ts', format: 'cjs' });
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(t: TestContext, dependencies: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-placeholder-lifecycle-'));
  const store = new Store(dir);
  await store.load();
  store.state.projects.push({ id: 'project', name: 'Project', path: dir, trusted: false, createdAt: 1 });
  const agents = new SessionAgents(store, new Workspace(dir));
  const events: AppEvent[] = [];
  const send = (event: AppEvent) => events.push(structuredClone(event));
  const operations = compile(
    `${namedFunction('text')}
     ${namedFunction('strings')}
     const save = ${initializer('save')};
     ${namedFunction('newSession')}
     ${namedFunction('protectSessionOperation')}
     ${namedFunction('inSessionWorkspace')}
     let stateRevision = 0;
     const stateSnapshot = ${initializer('stateSnapshot')};
     return {
       handlers: { ${['saveDraft', 'consumeDraft', 'saveView', 'renameSession', 'pinSession', 'selectSession', 'editDraft', 'readModels', 'deleteSession'].map(handler).join(',')} },
       newSession, protectSessionOperation, stateSnapshot
     };`,
    {
      store,
      service: agents,
      send,
      validateImages,
      composeDraftText,
      fs,
      path,
      assertTerminalClosed: async () => {},
      openTextEditor: async () => {},
      showAppDialog: async () => ({ response: 0 }),
      ...dependencies,
    },
  ) as {
    handlers: Record<string, (...args: any[]) => Promise<any>>;
    newSession: (scope?: string) => Promise<import('../shared/types').Session>;
    protectSessionOperation: (method: string, args: unknown[]) => Promise<void> | undefined;
    stateSnapshot: () => StateSnapshot;
  };
  t.after(async () => {
    await agents.dispose();
    await store.flush().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { store, agents, events, ...operations };
}
function holdWriter(t: TestContext, store: Store, failure?: Error) {
  const entered = deferred(),
    release = deferred();
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(store.dir, 'state.json.tmp')) {
      entered.resolve();
      await release.promise;
      if (failure) throw failure;
    }
    return write(...args);
  });
  return { entered, release };
}

test('late nonempty draft IPC promotes the original hidden ID without taking the current selection', async (t) => {
  const f = await fixture(t);
  const old = await f.newSession();
  const current = await f.newSession('project');
  assert.equal(
    f.stateSnapshot().state.sessions.some((session) => session.id === old.id),
    false,
  );
  await f.handlers.saveDraft(old.id, ' ', [], [], []);
  assert.equal(f.store.session(old.id), old);
  assert.equal(f.store.state.selectedSessionId, current.id);
  assert.equal(f.store.isTransientSession(old.id), false);
  assert.deepEqual(
    f.stateSnapshot().state.sessions.map((session) => session.id),
    [current.id, old.id],
  );
  await f.handlers.saveDraft(old.id, '', [], [], []);
  const restarted = new Store(f.store.dir);
  await restarted.load();
  assert.equal(restarted.session(old.id).draft, '');
  assert.equal(
    restarted.state.sessions.some((session) => session.id === current.id),
    false,
  );
});

test('empty draft autosaves, view saves and selection/history browsing keep placeholders transient', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const other = await f.newSession('project');
  await f.handlers.saveDraft(blank.id, '', [], [], []);
  await f.handlers.saveView(blank.id, 45, ['tool']);
  await f.handlers.selectSession(blank.id);
  assert.equal(f.store.isTransientSession(blank.id), true);
  assert.equal(f.store.isTransientSession(other.id), true);
  assert.equal(f.agents.connected(blank.id), false);
  assert.equal(f.store.persistentState().sessions.length, 0);
});

for (const [name, args] of [
  ['renameSession', ['新对话']],
  ['pinSession', [false]],
] as const)
  test(`explicit default-valued ${name} is durable before its first asynchronous continuation`, async (t) => {
    const f = await fixture(t);
    const blank = await f.newSession();
    const gate = holdWriter(t, f.store);
    const operation = f.handlers[name](blank.id, ...args);
    assert.equal(f.store.isTransientSession(blank.id), false);
    const replacement = f.store.createPlaceholder();
    assert.notEqual(replacement.id, blank.id);
    gate.release.resolve();
    await operation;
    await f.store.save();
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).id, blank.id);
  });

for (const outcome of ['cancel', 'fail'] as const)
  test(`external draft editor ${outcome} keeps accepted intent durable before side effects`, async (t) => {
    let opened = false;
    const f = await fixture(t, {
      openTextEditor: async () => {
        opened = true;
        if (outcome === 'fail') throw new Error('editor failed');
      },
    });
    const blank = await f.newSession();
    const gate = holdWriter(t, f.store);
    const operation = f.handlers.editDraft(blank.id);
    try {
      await gate.entered.promise;
      assert.equal(f.store.isTransientSession(blank.id), false);
      assert.equal(opened, false, 'external editor must wait for accepted-intent persistence');
      assert.notEqual(f.store.createPlaceholder().id, blank.id);
      gate.release.resolve();
      if (outcome === 'fail') await assert.rejects(operation, /editor failed/);
      else await operation;
      assert.equal(opened, true);
      const restarted = new Store(f.store.dir);
      await restarted.load();
      assert.equal(restarted.session(blank.id).id, blank.id);
    } finally {
      gate.release.resolve();
      await operation.catch(() => {});
    }
  });

test('failed native rename still preserves the explicitly chosen default title', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  t.mock.method(f.agents.get(blank.id), 'rename', async () => {
    throw new Error('rename failed');
  });
  await assert.rejects(f.handlers.renameSession(blank.id, '新对话'), /rename failed/);
  const restarted = new Store(f.store.dir);
  await restarted.load();
  assert.equal(restarted.session(blank.id).title, '新对话');
  assert.equal(f.store.isTransientSession(blank.id), false);
});

for (const [label, payload] of [
  ['attachments', ['', ['file.txt'], [], []]],
  [
    'images',
    [
      '',
      [],
      [
        {
          id: 'image',
          name: 'pixel',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2sWQAAAAASUVORK5CYII=',
        },
      ],
      [],
    ],
  ],
  ['snippets', ['', [], [], [{ id: 'snippet', offset: 0, text: 'retained text' }]]],
] as const)
  test(`saveDraft ${label} promote before save and remain durable after clearing`, async (t) => {
    const f = await fixture(t);
    const blank = await f.newSession();
    await f.handlers.saveDraft(blank.id, ...payload);
    await f.handlers.saveDraft(blank.id, '', [], [], []);
    assert.equal(f.store.isTransientSession(blank.id), false);
    assert.equal(f.store.persistentState().sessions[0].id, blank.id);
  });

test('common numbered snapshots hide unused IDs without changing stale ordering or live identity', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const first = f.stateSnapshot();
  const current = await f.newSession('project');
  const second = f.stateSnapshot();
  await f.handlers.saveDraft(blank.id, 'late content', []);
  const third = f.stateSnapshot();
  assert.ok(first.revision < second.revision && second.revision < third.revision);
  assert.equal(first.state.selectedSessionId, blank.id);
  assert.equal(
    second.state.sessions.some((session) => session.id === blank.id),
    false,
  );
  assert.equal(third.state.selectedSessionId, current.id);
  assert.equal(third.state.sessions.find((session) => session.id === blank.id)?.draft, 'late content');
  assert.equal(first.state.sessions[0].draft, '', 'numbered snapshots are detached at capture time');
  assert.equal(f.store.session(blank.id), blank);
});

for (const [method, rest] of [
  ['connect', []],
  ['send', ['accepted task', [], 'steer', []]],
  ['recover', []],
  ['compact', ['']],
  ['openPiTerminal', []],
  ['testConnection', []],
  ['login', ['provider', 'oauth']],
  ['logout', ['provider']],
  ['branchSession', ['navigate', 'entry', false, '']],
  ['messageAction', ['edit', 'user', 1]],
] as const)
  test(`main ${method} intent is protected while its first terminal/resource await is pending`, async (t) => {
    const f = await fixture(t);
    const blank = await f.newSession();
    const entered = deferred(),
      release = deferred();
    const invoke = () => {
      throw new Error('Handler must not be entered after failed terminal check');
    };
    const execute = compile(`return ${initializer('execute')};`, {
      method,
      args: [blank.id, ...rest],
      store: f.store,
      service: f.agents,
      invoke,
      protectSessionOperation: f.protectSessionOperation,
      inSessionWorkspace: async () => {
        entered.resolve();
        await release.promise;
        throw new Error('terminal check failed');
      },
    }) as () => Promise<unknown>;
    const operation = execute();
    assert.equal(f.store.isTransientSession(blank.id), false);
    await entered.promise;
    const replacement = await f.newSession();
    assert.notEqual(replacement.id, blank.id);
    release.resolve();
    await assert.rejects(operation, /terminal check failed/);
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).id, blank.id);
  });

test('malformed main send input is rejected before promoting an untouched placeholder', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  for (const args of [
    [blank.id, '', [], 'steer', []],
    [blank.id, 'task', [], 'invalid', []],
  ])
    assert.throws(() => f.protectSessionOperation('send', args), /请输入|发送模式/);
  assert.equal(f.store.isTransientSession(blank.id), true);
});

for (const kind of ['connect', 'send', 'recover', 'navigate'] as const)
  test(`Agent ${kind} protects intent before entering its existing exclusive queue`, async (t) => {
    const f = await fixture(t);
    const blank = await f.newSession();
    const agent = f.agents.get(blank.id);
    const release = deferred();
    (agent as any).operation = release.promise;
    t.mock.method(agent as any, 'ensureConnected', async () => {
      throw new Error('connection cancelled');
    });
    const operation =
      kind === 'connect'
        ? agent.connect(blank.id)
        : kind === 'send'
          ? agent.send(blank.id, 'accepted task', [], 'steer')
          : kind === 'recover'
            ? agent.recover(blank.id)
            : agent.branch(blank.id, 'navigate', 'entry');
    assert.equal(f.store.isTransientSession(blank.id), false);
    const replacement = await f.newSession();
    assert.notEqual(replacement.id, blank.id);
    release.resolve();
    await assert.rejects(operation, /cancelled|没有等待恢复/);
    await f.store.flush();
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).id, blank.id);
  });

test('Agent readTask protects intent before beforeConnect registers pending operations', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const entered = deferred(),
    release = deferred();
  const agent = new AgentService(f.store, new Workspace(f.store.dir), undefined, undefined, async () => {
    entered.resolve();
    await release.promise;
    throw new Error('read rejected');
  });
  const operation = agent.tree(blank.id);
  assert.equal(f.store.isTransientSession(blank.id), false);
  await entered.promise;
  assert.equal(agent.hasPendingWork, false, 'the protection precedes the old pending-registration boundary');
  assert.notEqual((await f.newSession()).id, blank.id);
  release.resolve();
  await assert.rejects(operation, /read rejected/);
  await agent.dispose();
  assert.equal(
    f.store.persistentState().sessions.some((session) => session.id === blank.id),
    true,
  );
});

for (const kind of ['model', 'thinking', 'approval'] as const)
  test(`explicit Agent ${kind} choices promote before preference work and survive default values`, async (t) => {
    const f = await fixture(t);
    const blank = await f.newSession();
    const agent = f.agents.get(blank.id);
    const release = deferred();
    (agent as any).settingsOperation = release.promise;
    if (kind === 'model') t.mock.method(agent as any, 'readModelCatalog', async () => {});
    const operation =
      kind === 'model'
        ? agent.setModel(blank.id, 'default', 'default')
        : kind === 'thinking'
          ? agent.setThinking(blank.id, 'off')
          : agent.setApprovalMode(blank.id, 'auto');
    assert.equal(f.store.isTransientSession(blank.id), false);
    assert.notEqual((await f.newSession()).id, blank.id);
    release.resolve();
    await operation;
    await f.store.flush();
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).id, blank.id);
  });

test('main catalog-only browsing reserves its first await but completes without promoting', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, {
    assertTerminalClosed: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const blank = await f.newSession();
  const agent = f.agents.get(blank.id);
  const read = t.mock.method(agent as any, 'readModelCatalog', async () => {});
  const operation = f.handlers.readModels(blank.id);
  assert.equal(agent.hasPendingWork, true, 'existing exclusive queue is reserved before terminal I/O');
  assert.equal(f.store.isTransientSession(blank.id), true);
  await entered.promise;
  release.resolve();
  await operation;
  assert.equal(read.mock.callCount(), 1);
  assert.equal(agent.hasPendingWork, false);
  assert.equal(f.store.isTransientSession(blank.id), true);
  assert.equal((await f.newSession()).id, blank.id, 'a completed read leaves a reusable placeholder');
  assert.deepEqual(f.store.persistentState().sessions, []);
});

test('New during pending catalog browsing conservatively preserves its active original owner', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, {
    assertTerminalClosed: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const blank = await f.newSession();
  t.mock.method(f.agents.get(blank.id) as any, 'readModelCatalog', async () => {});
  const operation = f.handlers.readModels(blank.id);
  await entered.promise;
  const replacement = await f.newSession();
  assert.notEqual(replacement.id, blank.id);
  assert.equal(f.store.isTransientSession(blank.id), false, 'active owner uses the conservative busy guard');
  release.resolve();
  await operation;
  assert.equal(f.store.isTransientSession(replacement.id), true);
  assert.equal(f.store.persistentState().sessions[0].id, blank.id);
});

test('model selection write failure blocks disposable Pi startup and retains the promoted ID', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(f.store.dir, 'state.json.tmp'))
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return write(...args);
  });
  const start = t.mock.method(PiRpc.prototype, 'start', () => {
    throw new Error('Pi must not start after a rejected protection save');
  });
  await assert.rejects(
    f.agents.get(blank.id).setModel(blank.id, 'default', 'default'),
    /保存已暂停|无法写入/,
  );
  assert.equal(start.mock.callCount(), 0);
  assert.equal(f.store.isTransientSession(blank.id), false);
  assert.equal(f.store.session(blank.id), blank);
  assert.equal(f.store.storage.writable, false);
});

function closeBoundary(
  store: Store,
  service: SessionAgents,
  onQuit: () => void,
  showAppDialog = async (_options: unknown, _fallback: boolean) => ({ response: 0 }),
  waitForOperations = async () => {},
  writeWindowState = async () => {},
) {
  const call = one(
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'window.on' &&
      node.arguments[0]?.getText(source) === "'close'",
  );
  assert.ok(ts.isCallExpression(call));
  return compile(
    `let quitting = false, closing = false, appQuitRequested = true, windowTimer;
     ${namedFunction('confirmUnsavedQuit')}
     return ${call.arguments[1].getText(source)};`,
    {
      store,
      service,
      app: { quit: onQuit },
      window: { destroy: () => {} },
      updates: { state: { installing: false }, prepareForQuit: () => {}, dispose: () => {} },
      appDialogs: { size: 0 },
      isMac: false,
      sessionEnding: false,
      workspaceWatcher: undefined,
      configurationWrites: Promise.resolve(),
      writeWindowState,
      showAppDialog,
      waitForOperations,
    },
  ) as (event: { preventDefault: () => void }) => void;
}

test('actual main close path waits for first draft persistence when no AgentService exists', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  assert.deepEqual(f.agents.diagnostics(), []);
  const gate = holdWriter(t, f.store);
  const saving = f.handlers.saveDraft(blank.id, 'first draft, no agent', []);
  await gate.entered.promise;
  let quit = false;
  const quitCalled = deferred();
  const close = closeBoundary(f.store, f.agents, () => {
    quit = true;
    quitCalled.resolve();
  });
  try {
    close({ preventDefault: () => {} });
    await nextTurn();
    assert.equal(quit, false, 'quit must wait for the no-agent Store write queue');
    gate.release.resolve();
    await saving;
    await quitCalled.promise;
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).draft, 'first draft, no agent');
  } finally {
    gate.release.resolve();
    await saving.catch(() => {});
  }
});

test('close captures window bounds before persistence waits and awaits the captured write', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const gate = holdWriter(t, f.store);
  const saving = f.handlers.saveDraft(blank.id, 'keep draft while closing', []);
  await gate.entered.promise;
  let width = 1420;
  const capturedWidths: number[] = [];
  const windowWritten = deferred();
  const quitCalled = deferred();
  let quit = false;
  const close = closeBoundary(
    f.store,
    f.agents,
    () => {
      quit = true;
      quitCalled.resolve();
    },
    undefined,
    undefined,
    () => {
      capturedWidths.push(width);
      return windowWritten.promise;
    },
  );
  try {
    close({ preventDefault: () => {} });
    width = 1440; // A native resize delivered after close must not replace its snapshot.
    assert.deepEqual(capturedWidths, [1420]);
    assert.equal(quit, false);
    gate.release.resolve();
    await saving;
    await nextTurn();
    assert.equal(quit, false, 'close also waits for the already-captured window write');
    assert.deepEqual(capturedWidths, [1420], 'shutdown must not recapture the later bounds');
    windowWritten.resolve();
    await quitCalled.promise;
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).draft, 'keep draft while closing');
  } finally {
    gate.release.resolve();
    windowWritten.resolve();
    await saving.catch(() => {});
  }
});

test('failed no-agent close retains memory and reusable services until explicit discard is confirmed', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(f.store.dir, 'state.json.tmp'))
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return write(...args);
  });
  await assert.rejects(f.handlers.saveDraft(blank.id, 'keep unsaved content visible', []), /保存已暂停/);
  let quit = false,
    response = 0;
  const dialogs: any[] = [];
  const dispose = t.mock.method(f.agents, 'dispose');
  const close = closeBoundary(
    f.store,
    f.agents,
    () => {
      quit = true;
    },
    async (options) => {
      dialogs.push(options);
      return { response };
    },
  );
  close({ preventDefault: () => {} });
  await nextTurn();
  assert.equal(quit, false);
  assert.equal(dispose.mock.callCount(), 0, 'a rejected pre-disposal flush must not close the services');
  assert.equal(f.store.session(blank.id).draft, 'keep unsaved content visible');
  assert.doesNotThrow(() => f.agents.get(blank.id), 'service ownership remains available after staying');
  assert.match(dialogs[0].message, /尚未保存/);
  assert.equal(dialogs[0].defaultId, 0);
  response = 1;
  close({ preventDefault: () => {} });
  await nextTurn();
  assert.equal(quit, true, 'only explicit discard approval allows failed-save exit');
  assert.equal(dialogs.length, 2);
});

test('quit cancels session services before draining accepted native writers and the final flush', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const tracker = compile(
    `
    let activeOperations = 1;
    const operationWaiters = new Set<() => void>();
    ${namedFunction('finishOperation')}
    ${namedFunction('waitForOperations')}
    return { finishOperation, waitForOperations };
  `,
    {},
  ) as { finishOperation: () => void; waitForOperations: () => Promise<void> };
  const flush = t.mock.method(f.store, 'flush');
  const disconnect = t.mock.method(f.agents, 'disconnect');
  const quitCalled = deferred();
  const close = closeBoundary(f.store, f.agents, quitCalled.resolve, undefined, tracker.waitForOperations);
  close({ preventDefault: () => {} });
  await nextTurn();
  assert.equal(flush.mock.callCount(), 1, 'only the current filesystem queue is flushed before disposal');
  assert.equal(disconnect.mock.callCount(), 0);
  assert.equal(f.agents.disposed, true, 'session cancellation starts before native-operation drain');
  await f.handlers.saveDraft(blank.id, 'late accepted writer completed', []);
  tracker.finishOperation();
  await quitCalled.promise;
  const restarted = new Store(f.store.dir);
  await restarted.load();
  assert.equal(restarted.session(blank.id).draft, 'late accepted writer completed');
});

test('unexpected final-barrier failure retains only an explicitly described copy window until discard approval', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  await f.handlers.saveDraft(blank.id, 'copy this content if shutdown saving fails', []);
  const flush = f.store.flush.bind(f.store);
  let calls = 0;
  t.mock.method(f.store, 'flush', () => {
    if (++calls === 1) return flush();
    f.store.storage = { writable: false, problem: 'ENOSPC after shutdown' };
    return Promise.reject(new Error('ENOSPC after shutdown'));
  });
  let quit = false,
    response = 0;
  const dialogs: any[] = [];
  const close = closeBoundary(
    f.store,
    f.agents,
    () => {
      quit = true;
    },
    async (options) => {
      dialogs.push(options);
      return { response };
    },
  );
  close({ preventDefault: () => {} });
  await nextTurn();
  assert.equal(quit, false, 'a defensive barrier failure must never silently close');
  assert.equal(f.agents.disposed, true);
  assert.equal(dialogs[0].buttons[0], '保留窗口以复制内容');
  assert.match(dialogs[0].detail, /会话服务已关闭/);
  assert.equal(f.store.session(blank.id).draft, 'copy this content if shutdown saving fails');
  response = 1;
  close({ preventDefault: () => {} });
  await nextTurn();
  assert.equal(quit, true);
  assert.equal(
    dialogs[1].buttons[0],
    '保留窗口以复制内容',
    'later close attempts cannot imply the service reopened',
  );
});

test('SessionAgents disposal cancels a model-reader dialog before waiting for its workspace reservation', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const agent = f.agents.get(blank.id);
  const entered = deferred(),
    release = deferred();
  let closedReader = false;
  t.mock.method(agent as any, 'readModelCatalog', async () => {
    (agent as any).modelReader = {
      close: async () => {
        closedReader = true;
        release.resolve();
      },
    };
    entered.resolve();
    await release.promise;
  });
  const reading = f.handlers.readModels(blank.id);
  await entered.promise;
  const disposing = f.agents.dispose();
  try {
    await nextTurn();
    assert.equal(
      closedReader,
      true,
      'reader cancellation must not wait for the workspace action it unblocks',
    );
  } finally {
    release.resolve();
    await reading;
    await disposing;
  }
});

test('a queued catalog request disposed before its first await cannot start Pi or acquire a new dialog', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const agent = f.agents.get(blank.id);
  const release = deferred();
  (agent as any).crashCleanup = release.promise;
  const start = t.mock.method(PiRpc.prototype, 'start', () => {
    throw new Error('unexpected Pi start');
  });
  const reading = f.handlers.readModels(blank.id);
  const rejected = assert.rejects(reading, /关闭|取消/);
  await nextTurn();
  assert.equal(
    agent.requiresStopConfirmation,
    false,
    'this covers pending-before-modelsLoading, not an already running reader',
  );
  const disposing = f.agents.dispose();
  release.resolve();
  await rejected;
  await disposing;
  assert.equal(start.mock.callCount(), 0);
  assert.deepEqual(agent.runtime.dialogs, []);
});

for (const outcome of ['saved', 'ENOSPC'] as const)
  test(`testConnection waits for an already-promoted concurrent draft write: ${outcome}`, async (t) => {
    const f = await fixture(t);
    const blank = await f.newSession();
    Object.assign(f.store.state.settings, {
      piPath: path.resolve('tests/support/fixture-pi.mjs'),
      nodePath: process.execPath,
      agentDir: f.store.dir,
      provider: 'fixture',
      modelId: 'test',
    });
    const failure =
      outcome === 'ENOSPC' ? Object.assign(new Error('disk full'), { code: 'ENOSPC' }) : undefined;
    const gate = holdWriter(t, f.store, failure);
    const saving = f.handlers.saveDraft(blank.id, 'concurrent promotion awaiting persistence', []);
    const saved = outcome === 'ENOSPC' ? assert.rejects(saving, /保存已暂停/) : saving;
    await gate.entered.promise;
    assert.equal(
      f.store.isTransientSession(blank.id),
      false,
      'main preflight would see a formal ID while its save is still pending',
    );
    const barrier = deferred();
    const flush = f.store.flush.bind(f.store);
    t.mock.method(f.store, 'flush', () => {
      barrier.resolve();
      return flush();
    });
    const start = t.mock.method(PiRpc.prototype, 'start');
    const testing = f.agents.get(blank.id).testConnection(blank.id);
    let completed = false;
    const result =
      outcome === 'ENOSPC'
        ? assert.rejects(testing, /保存已暂停/).then(() => {
            completed = true;
          })
        : testing.then((value) => {
            completed = true;
            return value;
          });
    try {
      await barrier.promise;
      assert.equal(start.mock.callCount(), 0, 'probe cannot start while the promotion write is held');
      assert.equal(completed, false);
      gate.release.resolve();
      await saved;
      const value = await result;
      assert.equal(f.store.session(blank.id).draft, 'concurrent promotion awaiting persistence');
      if (outcome === 'ENOSPC') {
        assert.equal(start.mock.callCount(), 0);
        assert.equal(f.store.storage.writable, false);
      } else {
        assert.equal(
          start.mock.callCount(),
          1,
          'the actual protocol-fixture probe starts after persistence succeeds',
        );
        assert.match(value?.text ?? '', /完成/);
        const commands = (await fs.readFile(path.join(f.store.dir, 'commands.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.ok(
          commands.some((command) => command.type === 'prompt' && command.message === 'Reply with only OK.'),
        );
        const restarted = new Store(f.store.dir);
        await restarted.load();
        assert.equal(restarted.session(blank.id).draft, 'concurrent promotion awaiting persistence');
      }
    } finally {
      gate.release.resolve();
      await Promise.allSettled([saved, result]);
    }
  });

test('direct testConnection rejects its own failed promotion save before probe startup', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  Object.assign(f.store.state.settings, {
    piPath: path.resolve('tests/support/fixture-pi.mjs'),
    nodePath: process.execPath,
    agentDir: f.store.dir,
    provider: 'fixture',
    modelId: 'test',
  });
  const gate = holdWriter(t, f.store, Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  const start = t.mock.method(PiRpc.prototype, 'start');
  const testing = f.agents.get(blank.id).testConnection(blank.id);
  const rejected = assert.rejects(testing, /保存已暂停/);
  try {
    await gate.entered.promise;
    assert.equal(f.store.isTransientSession(blank.id), false);
    assert.equal(start.mock.callCount(), 0);
    gate.release.resolve();
    await rejected;
    assert.equal(start.mock.callCount(), 0);
    assert.equal(f.store.storage.writable, false);
  } finally {
    gate.release.resolve();
    await rejected;
  }
});

test('testConnection cancelled at the persistence barrier does not start after the write succeeds', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  Object.assign(f.store.state.settings, {
    piPath: path.resolve('tests/support/fixture-pi.mjs'),
    nodePath: process.execPath,
    agentDir: f.store.dir,
    provider: 'fixture',
    modelId: 'test',
  });
  const gate = holdWriter(t, f.store);
  const saving = f.handlers.saveDraft(blank.id, 'saved despite probe cancellation', []);
  await gate.entered.promise;
  const barrier = deferred();
  const flush = f.store.flush.bind(f.store);
  t.mock.method(f.store, 'flush', () => {
    barrier.resolve();
    return flush();
  });
  const start = t.mock.method(PiRpc.prototype, 'start');
  const agent = f.agents.get(blank.id);
  const testing = agent.testConnection(blank.id);
  const rejected = assert.rejects(testing, /取消/);
  let disposing: Promise<void> | undefined;
  try {
    await barrier.promise;
    disposing = agent.dispose();
    gate.release.resolve();
    await saving;
    await rejected;
    await disposing;
    assert.equal(start.mock.callCount(), 0);
  } finally {
    gate.release.resolve();
    await Promise.allSettled([saving, rejected, disposing]);
  }
});

test('testConnection cancelled during sessionDirectory cannot create a late probe', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const agent = f.agents.get(blank.id);
  const entered = deferred(),
    release = deferred();
  t.mock.method(f.store, 'sessionDirectory', async () => {
    entered.resolve();
    await release.promise;
    return f.store.dir;
  });
  const start = t.mock.method(PiRpc.prototype, 'start', () => {
    throw new Error('late probe must not start');
  });
  const testing = agent.testConnection(blank.id);
  const rejected = assert.rejects(testing, /取消/);
  await entered.promise;
  await agent.dispose();
  release.resolve();
  await rejected;
  assert.equal((agent as any).probe, undefined);
  assert.equal(start.mock.callCount(), 0);
});

test('testConnection cancelled during preparePi cannot start its already allocated probe', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const agent = f.agents.get(blank.id);
  const entered = path.join(f.store.dir, 'probe-version-entered');
  const released = path.join(f.store.dir, 'probe-version-released');
  const cli = path.join(f.store.dir, 'delayed-probe.mjs');
  await fs.writeFile(
    cli,
    `import fs from 'node:fs';
if (process.argv.includes('--version')) {
fs.writeFileSync(${JSON.stringify(entered)}, 'entered');
while (!fs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));
console.log('1.1.0');
} else throw new Error('Probe should never start');
`,
  );
  Object.assign(f.store.state.settings, {
    piPath: cli,
    nodePath: process.execPath,
    provider: 'fixture',
    modelId: 'test',
    agentDir: f.store.dir,
  });
  const start = t.mock.method(PiRpc.prototype, 'start', () => {
    throw new Error('late allocated probe must not start');
  });
  const testing = agent.testConnection(blank.id);
  const rejected = assert.rejects(testing, /取消/);
  try {
    const deadline = Date.now() + 10000;
    while (!(await fs.stat(entered).catch(() => undefined))) {
      assert.ok(Date.now() < deadline, 'version fixture was never reached');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok((agent as any).probe, 'probe is allocated before the delayed environment preparation');
    await agent.dispose();
  } finally {
    await fs.writeFile(released, 'release');
    await rejected;
  }
  assert.equal(start.mock.callCount(), 0);
  assert.equal((agent as any).probe, undefined);
});

test('actual update persistence boundary waits for a promoted no-agent draft', async (t) => {
  const f = await fixture(t);
  const blank = await f.newSession();
  const gate = holdWriter(t, f.store);
  const saving = f.handlers.saveDraft(blank.id, 'first draft before update', []);
  await gate.entered.promise;
  const boundary = one(
    (node) => ts.isPropertyAssignment(node) && node.name.getText(source) === 'beforeInstall',
  );
  assert.ok(ts.isPropertyAssignment(boundary));
  const beforeInstall = compile(
    `let quitting = false, windowTimer;
     return ${boundary.initializer.getText(source)};`,
    {
      store: f.store,
      service: f.agents,
      closing: false,
      sessionEnding: false,
      writeWindowState: async () => {},
    },
  ) as () => Promise<void>;
  let completed = false;
  const installing = beforeInstall().then(() => (completed = true));
  try {
    await nextTurn();
    assert.equal(completed, false);
    gate.release.resolve();
    await saving;
    await installing;
    const restarted = new Store(f.store.dir);
    await restarted.load();
    assert.equal(restarted.session(blank.id).draft, 'first draft before update');
  } finally {
    gate.release.resolve();
    await saving.catch(() => {});
  }
});

test('deleting the selected empty conversation removes it without claiming the recycle bin', async (t) => {
  const dialogs: string[] = [];
  const f = await fixture(t, {
    showAppDialog: async (options: { message: string }) => {
      dialogs.push(options.message);
      return { response: 1 };
    },
  });
  const current = await f.newSession();
  const other = f.store.createSession();
  f.store.selectSession(current.id);
  const removed = await f.handlers.deleteSession(current.id);
  assert.deepEqual(removed, { trashed: false });
  assert.equal(dialogs.length, 1);
  assert.equal(
    f.store.state.sessions.some((session) => session.id === current.id),
    false,
  );
  assert.equal(f.store.state.selectedSessionId, other.id);
  const lastEvent = f.events.at(-1);
  assert.equal(lastEvent?.type, 'state');
  if (lastEvent?.type === 'state') assert.equal(lastEvent.state.selectedSessionId, other.id);
});

for (const scenario of [
  'missing',
  'present',
  'lstat-EACCES',
  'lstat-EIO',
  'trash-EACCES',
  'trash-ENOENT',
  'cancel',
]) {
  test(`delete session transcript boundary: ${scenario}`, async (t) => {
    const calls: string[] = [];
    const failure = Object.assign(new Error(scenario), { code: scenario.split('-')[1] });
    const f = await fixture(t, {
      showAppDialog: async () => ({ response: scenario === 'cancel' ? 0 : 1 }),
      fs: {
        lstat: async () => {
          calls.push('lstat');
          if (scenario === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          if (scenario.startsWith('lstat-')) throw failure;
          return {};
        },
      },
      shell: {
        trashItem: async () => {
          calls.push('trash');
          if (scenario.startsWith('trash-')) throw failure;
        },
      },
    });
    const current = f.store.createSession();
    current.file = path.join(f.store.dir, 'transcript.jsonl');
    const other = f.store.createSession();
    f.store.selectSession(current.id);
    if (scenario.includes('-')) {
      await assert.rejects(f.handlers.deleteSession(current.id), (error) => error === failure);
      assert.equal(f.store.state.sessions.includes(current), true);
      assert.equal(f.store.state.selectedSessionId, current.id);
    } else if (scenario === 'cancel') {
      assert.equal(await f.handlers.deleteSession(current.id), false);
      assert.deepEqual(calls, []);
      assert.equal(f.store.state.sessions.includes(current), true);
    } else {
      assert.deepEqual(await f.handlers.deleteSession(current.id), { trashed: scenario === 'present' });
      assert.deepEqual(calls, scenario === 'present' ? ['lstat', 'trash'] : ['lstat']);
      assert.equal(f.store.state.sessions.includes(current), false);
      assert.equal(f.store.state.selectedSessionId, other.id);
    }
  });
}
