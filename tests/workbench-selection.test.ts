import { hidePlanTools } from '../src/lib/plan-transcript';
import * as goalInput from '../shared/goal-input';
import * as goal from '../shared/goal';
import * as ask from '../shared/ask';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';
import * as types from '../shared/types';
import { defaultSettings } from '../electron/store-state';
import { hideRecoveredErrors } from '../src/lib/conversation-layout';
import { readableError } from '../src/lib/format';
import type { Workbench } from '../src/hooks/useWorkbench';
import { Store } from '../electron/store';
import { SessionAgents } from '../electron/session-agents';
import { Workspace } from '../electron/workspace';
import { createMainNavigation } from './support/main-navigation';

// Execute the whole production hook with deterministic hook storage, effects, IPC,
// and timers. This checks its real render/closure logic, not Electron or DOM paint.
const { code } = transformSync(readFileSync('src/hooks/useWorkbench.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
});
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const messages = (content: string): types.Message[] => [{ role: 'user', content }];
const session = (id: string, file: string | undefined = `${id}.jsonl`): types.Session => ({
  id,
  title: id,
  file,
  draft: '',
  attachments: [],
  updatedAt: 1,
  lastStatus: 'idle',
});
const noOp = () => {};

test('the conversation hides internal goal prompts but keeps visible extension output', async () => {
  const f = harness(() => Promise.resolve([]));
  f.view.runtime = {
    ...types.emptyRuntime(),
    sessionId: 'A',
    connected: true,
    messages: [
      { role: 'user', content: 'Fix the tests' },
      { role: 'custom', content: 'Internal goal contract', display: false },
      { role: 'custom', content: 'Visible extension output', display: true },
      { role: 'assistant', content: 'Tests passed' },
    ],
  };
  f.render();
  await f.settle();
  assert.deepEqual(f.current.messages.map(types.messageText), [
    'Fix the tests',
    'Visible extension output',
    'Tests passed',
  ]);
  assert.equal(f.view.runtime.messages.length, 4, 'canonical model context remains intact');
  f.unmount();
});
type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => void | (() => void) };
function harness(
  invoke: (method: string, id?: string) => Promise<unknown>,
  initialState?: types.AppState,
  confirm?: () => Promise<types.StateSnapshot>,
) {
  const slots: any[] = [],
    effects = new Map<number, Effect>();
  let cursor = 0,
    dirty = false,
    mounted = true,
    updatesAfterUnmount = 0,
    timerId = 0;
  const receivedState: { current: { state?: types.AppState; revision: number } } = {
    current: { revision: 0 },
  };
  let queuedState: { state: types.AppState; revision: number } | undefined;
  let deferredCommit = false;
  const timers = new Map<number, { run: () => void; delay: number; interval: boolean }>();
  const cleared: number[] = [];
  const state: types.AppState = initialState ?? {
    version: 1,
    projects: [],
    sessions: ['A', 'B', 'C'].map((id) => session(id)),
    settings: { ...defaultSettings },
    selectedSessionId: 'A',
  };
  const view = {
    state,
    stateRevision: 0,
    receivedState,
    receiveState(state: types.AppState, revision: number) {
      receiveState(state, revision);
      if (!deferredCommit) {
        commitToView();
        dirty = true;
      }
    },
    runtime: types.emptyRuntime(),
    anyRunning: false,
    environment: { supported: false, authExists: false, modelsExist: false },
    storage: { writable: true } as types.StorageStatus,
    setEnvironment: noOp,
    update: undefined,
  };
  const invokeApi = (method: string, id?: string) =>
    method === 'navigationState'
      ? (confirm?.() ??
        Promise.resolve({
          state: structuredClone(receivedState.current.state ?? view.state),
          revision: receivedState.current.revision + 1,
        }))
      : invoke(method, id);
  const changed = (before: unknown[] | undefined, after: unknown[] | undefined) =>
    !before || !after || before.length !== after.length || before.some((v, i) => !Object.is(v, after[i]));
  const useEffect = (run: Effect['run'], deps?: unknown[]) => {
    const index = cursor++,
      previous = effects.get(index);
    if (!previous || changed(previous.deps, deps)) effects.set(index, { ...previous, deps, run });
  };
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (value: any) => {
          if (!mounted) updatesAfterUnmount++;
          const next = typeof value === 'function' ? value(slots[index]) : value;
          if (!Object.is(next, slots[index])) {
            slots[index] = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(factory: () => unknown, deps?: unknown[]) {
      const index = cursor++;
      if (!(index in slots) || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useEffect,
    useLayoutEffect: useEffect,
  };
  const draft = {
    draft: '',
    attachments: [],
    images: [],
    sendMode: 'steer',
    setSendMode: noOp,
    setFileQuery: noOp,
    setFileResults: noOp,
    setCommandIndex: noOp,
    setHideCommands: noOp,
    recall: { current: -1 },
    input: { current: null },
    commandList: { current: null },
    focusComposer: noOp,
    composeDraft: () => '',
    flushDraft: async () => {},
    isReadingAttachments: () => false,
    getDraftRevision: () => 0,
    snippets: [],
    draftQuotes: [],
    addQuote: noOp,
    removeQuote: noOp,
  };
  const workspace = {
    checkpoints: [],
    setTab: noOp,
    selectTab: noOp,
    inspectFile: noOp,
    openCheckpoint: noOp,
  };
  const dependencies: Record<string, unknown> = {
    react: hooks,
    './useRuntime': { useRuntime: () => view },
    './useDraft': { useDraft: () => draft },
    './useSideChat': { useSideChat: () => ({ open: false }) },
    './useWorkspace': { useWorkspace: () => workspace },
    './useShortcuts': { useShortcuts: () => ({ stopArmed: false, runAction: noOp }) },
    './useLayer': { useLayer: noOp },
    '../lib/commands': { builtinCommands: [] },
    '../../shared/types': types,
    '../../shared/goal-input': goalInput,
    '../../shared/goal': goal,
    '../../shared/ask': ask,
    '../lib/format': { readableError },
    '../lib/conversation-layout': { hideRecoveredErrors },
    '../lib/plan-transcript': { hidePlanTools },
    '../../shared/pi-version': { PI_SOURCE_URL: '' },
  };
  const require = (id: string) => {
    assert.ok(id in dependencies, `Unexpected hook dependency: ${id}`);
    return dependencies[id];
  };
  for (const name of ['useHistory', 'useStableCallbacks']) {
    const compiled = transformSync(readFileSync(`src/hooks/${name}.ts`, 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code;
    const hookModule = { exports: {} };
    dependencies['./' + name] = new Function(
      'require',
      'module',
      'exports',
      'window',
      `${compiled}; return module.exports;`,
    )(require, hookModule, hookModule.exports, { desktop: { invoke: invokeApi } });
  }
  const timeout = (run: () => void, delay: number, interval = false) => {
    const id = ++timerId;
    timers.set(id, { run, delay, interval });
    return id;
  };
  const clear = (id: number) => {
    cleared.push(id);
    timers.delete(id);
  };
  const module = { exports: {} };
  const useWorkbench = new Function(
    'require',
    'module',
    'exports',
    'window',
    'localStorage',
    'document',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    `${code}; return module.exports.useWorkbench;`,
  )(
    require,
    module,
    module.exports,
    { desktop: { invoke: invokeApi, platform: 'linux' } },
    { getItem: () => null, setItem: noOp },
    { documentElement: { dataset: {}, style: { setProperty: noOp } }, activeElement: null },
    timeout,
    clear,
    (run: () => void, delay: number) => timeout(run, delay, true),
    clear,
  ) as () => Workbench;
  let result!: Workbench;
  function render() {
    cursor = 0;
    dirty = false;
    result = useWorkbench();
    return result;
  }
  function flush() {
    for (let n = 0; n < 30; n++) {
      if (dirty) render();
      const pending = [...effects.values()].filter((effect) => effect.run);
      if (!pending.length && !dirty) return result;
      for (const effect of pending) {
        const run = effect.run!;
        effect.run = undefined;
        effect.cleanup?.();
        effect.cleanup = run() || undefined;
      }
    }
    assert.fail('Hook did not settle');
  }
  async function settle() {
    for (let n = 0; n < 6; n++) {
      await Promise.resolve();
      flush();
    }
    return result;
  }
  function receiveState(state: types.AppState, revision = receivedState.current.revision + 1) {
    if (revision <= receivedState.current.revision) return;
    queuedState = { state, revision };
    receivedState.current = queuedState;
  }
  function commitToView() {
    if (!queuedState) return;
    view.state = queuedState.state;
    view.stateRevision = queuedState.revision;
    queuedState = undefined;
  }
  function commitState() {
    commitToView();
    return render();
  }
  function select(id: string, runtime = types.emptyRuntime()) {
    receiveState({ ...view.state, selectedSessionId: id });
    view.runtime = runtime;
    return commitState();
  }
  render();
  flush();
  return {
    view,
    draft,
    render,
    flush,
    settle,
    select,
    receiveState,
    commitState,
    deferStateCommit(value = true) {
      deferredCommit = value;
    },
    emitSelection(id: string) {
      receiveState({ ...view.state, selectedSessionId: id });
      commitToView();
    },
    timers,
    cleared,
    get current() {
      return result;
    },
    get updatesAfterUnmount() {
      return updatesAfterUnmount;
    },
    unmount() {
      for (const effect of effects.values()) effect.cleanup?.();
      mounted = false;
    },
    fireTimers(delay: number) {
      for (const [id, timer] of [...timers])
        if (timer.delay === delay) {
          if (!timer.interval) timers.delete(id);
          timer.run();
        }
    },
  };
}

async function mainFixture(t: TestContext, phase: 'save' | 'reply', holdRender = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-navigation-protocol-'));
  const store = new Store(dir);
  await store.load();
  store.state.projects.push({ id: 'P', name: 'project', path: dir, trusted: true, createdAt: 1 });
  const original = store.createSession();
  original.draft = 'Preserve the original chat';
  await store.save();
  const agents = new SessionAgents(store, new Workspace(dir));
  const entered = deferred(),
    release = deferred();
  const selectionEntered = deferred(),
    selectionRelease = deferred();
  let holdSelection = false;
  const trace: {
    kind: 'state' | 'reply' | 'call' | 'confirmation';
    revision?: number;
    id?: string;
    method?: string;
  }[] = [];
  let creationCount = 0;
  if (phase === 'save') {
    const save = store.save.bind(store);
    let count = 0;
    t.mock.method(store, 'save', () => {
      const persisted = save();
      if (++count !== 1) return persisted;
      entered.resolve();
      return persisted.then(() => release.promise);
    });
  }
  const f = harness(
    async (method, id) => {
      trace.push({ kind: 'call', method, id });
      if (method === 'newSession') {
        const first = ++creationCount === 1;
        const result = await navigation.create(id);
        if (phase === 'reply' && first) {
          entered.resolve();
          await release.promise;
        }
        trace.push({ kind: 'reply', id: result.id });
        return result;
      }
      if (method === 'selectSession') {
        const result = await navigation.select(id!);
        if (holdSelection) {
          selectionEntered.resolve();
          await selectionRelease.promise;
        }
        return result;
      }
      if (method === 'readHistory') return agents.get(id!).history(id!);
      return [];
    },
    structuredClone(store.state),
    async () => {
      const result = await navigation.confirm();
      trace.push({ kind: 'confirmation', id: result.state.selectedSessionId, revision: result.revision });
      return result;
    },
  );
  f.deferStateCommit(holdRender);
  const navigation = createMainNavigation(store, agents, (event) => {
    if (event.type !== 'state') return;
    trace.push({ kind: 'state', id: event.state.selectedSessionId, revision: event.revision });
    f.receiveState(structuredClone(event.state), event.revision);
    if (!holdRender) {
      f.commitState();
      f.flush();
    }
  });
  t.after(async () => {
    release.resolve();
    selectionRelease.resolve();
    f.unmount();
    await agents.dispose();
    await store.flush().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    f,
    store,
    navigation,
    agents,
    entered,
    release,
    trace,
    original,
    holdSelection() {
      holdSelection = true;
      return { entered: selectionEntered, release: selectionRelease };
    },
  };
}

test('actual main completion cannot unlock before its received state or a newer snapshot renders', async (t) => {
  const p = await mainFixture(t, 'save', true);
  const creating = p.f.current.createSession('P');
  p.f.flush();
  await p.entered.promise;
  await p.navigation.nativeCreate();
  const c = p.store.state.selectedSessionId!;
  p.release.resolve();
  await creating;
  await p.f.settle();
  assert.equal(p.f.current.selected?.id, p.original.id);
  assert.equal(p.f.current.selectionChanging, true, 'received state is not yet committed');
  p.store.session(c).draft = 'Preserve C';
  await p.navigation.nativeCreate();
  const d = p.store.state.selectedSessionId!;
  assert.notEqual(d, c);
  await p.f.settle();
  assert.equal(p.f.current.selectionChanging, true);
  p.f.commitState();
  p.f.flush();
  assert.equal(p.f.current.selected?.id, d);
  assert.equal(p.f.current.selectionChanging, false);
  assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
});

for (const oldOutcome of ['success', 'cancelled'] as const) {
  test(`actual main ${oldOutcome} completion cannot release a newer hook request`, async (t) => {
    const p = await mainFixture(t, 'save');
    const old = p.f.current.createSession('P');
    p.f.flush();
    await p.entered.promise;
    const selected = p.holdSelection();
    const latest = p.f.current.selectSession(p.original);
    p.f.flush();
    await selected.entered.promise;
    await p.navigation.nativeCreate();
    const c = p.store.state.selectedSessionId!;
    if (oldOutcome === 'success') p.release.resolve();
    else p.release.reject(new Error('TEST_SAVE_CANCELLED'));
    await old;
    await p.f.settle();
    assert.equal(p.f.current.selected?.id, c);
    assert.equal(p.f.current.selectionChanging, true);
    assert.equal(p.f.current.sessionEnabled, false);
    selected.release.resolve();
    await latest;
    await p.f.settle();
    assert.equal(p.f.current.selected?.id, c);
    assert.equal(p.f.current.selectionChanging, false);
    assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
  });
}

test('actual failed creation releases only its pending lock and retains authoritative selection and guards', async (t) => {
  const p = await mainFixture(t, 'save');
  const creating = p.f.current.createSession('P');
  p.f.flush();
  await p.entered.promise;
  await p.navigation.nativeCreate();
  const c = p.store.state.selectedSessionId!;
  p.release.reject(new Error('TEST_SAVE_FAILED'));
  await creating;
  await p.f.settle();
  assert.equal(p.f.current.selected?.id, c);
  assert.equal(p.f.current.selectionChanging, false);
  p.f.view.storage.writable = false;
  p.f.render();
  p.f.flush();
  assert.equal(p.f.current.sessionEnabled, false);
  await p.f.current.connect();
  assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
});

test('a queued authoritative state invalidates old model actions before React commits it', async (t) => {
  const p = await mainFixture(t, 'reply', true);
  const old = p.f.current;
  await p.navigation.nativeCreate();
  const c = p.store.state.selectedSessionId!;
  assert.equal(p.f.current.selected?.id, p.original.id);
  await old.connect();
  await old.readModels();
  await old.setModel('provider::model');
  await old.setThinking('high');
  const modelCalls = () =>
    p.trace.filter((entry) =>
      ['connect', 'readModels', 'setSessionModel', 'setSessionThinking'].includes(entry.method!),
    );
  assert.deepEqual(modelCalls(), []);
  p.f.commitState();
  p.f.flush();
  await p.f.current.setModel('provider::model');
  await p.f.settle();
  assert.deepEqual(modelCalls(), [{ kind: 'call', method: 'setSessionModel', id: c }]);
});

test('main confirmation snapshots are immutable, monotonic and do not write storage', async (t) => {
  const p = await mainFixture(t, 'reply');
  const before = await fs.readFile(path.join(p.store.dir, 'state.json'), 'utf8');
  const first = p.navigation.confirm();
  const count = first.state.sessions.length;
  p.store.createSession('P');
  const second = p.navigation.confirm();
  assert.equal(first.state.selectedSessionId, p.original.id);
  assert.equal(first.state.sessions.length, count);
  assert.ok(second.revision > first.revision);
  assert.equal(await fs.readFile(path.join(p.store.dir, 'state.json'), 'utf8'), before);
});

test('an older confirmation arriving after a newer state cannot roll selection back', async (t) => {
  const p = await mainFixture(t, 'reply');
  const confirm = p.navigation.confirm.bind(p.navigation);
  const entered = deferred(),
    release = deferred();
  t.mock.method(p.navigation, 'confirm', () => {
    const snapshot = confirm();
    entered.resolve();
    return release.promise.then(() => snapshot) as unknown as types.StateSnapshot;
  });
  const selecting = p.f.current.selectSession(p.original);
  p.f.flush();
  await entered.promise;
  await p.navigation.nativeCreate();
  const c = p.store.state.selectedSessionId!;
  release.resolve();
  await selecting;
  await p.f.settle();
  assert.equal(p.f.current.selected?.id, c);
  assert.equal(p.f.current.selectionChanging, false);
  assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
});

test('failed confirmation stays visibly disabled and a fresh valid navigation recovers', async (t) => {
  const p = await mainFixture(t, 'reply');
  const confirm = p.navigation.confirm.bind(p.navigation);
  let calls = 0;
  t.mock.method(p.navigation, 'confirm', () => {
    if (++calls === 1) throw new Error('TEST_CONFIRMATION_FAILED');
    return confirm();
  });
  await p.f.current.selectSession(p.original);
  await p.f.settle();
  assert.equal(p.f.current.selectionChanging, true);
  assert.match(p.f.current.error, /无法确认当前会话.*TEST_CONFIRMATION_FAILED/);
  await p.f.current.connect();
  assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
  await p.f.current.selectSession(p.original);
  await p.f.settle();
  assert.equal(p.f.current.selectionChanging, false);
  assert.equal(p.f.current.error, '');
});

test('confirmation failure remains visible when a queued external selection commits later', async (t) => {
  const p = await mainFixture(t, 'reply', true);
  const confirm = p.navigation.confirm.bind(p.navigation);
  let count = 0;
  t.mock.method(p.navigation, 'confirm', () => {
    if (++count === 1) throw new Error('TEST_CONFIRMATION_FAILED');
    return confirm();
  });
  await p.f.current.selectSession(p.original);
  await p.f.settle();
  await p.navigation.nativeCreate();
  const c = p.store.state.selectedSessionId!;
  p.f.commitState();
  p.f.flush();
  assert.equal(p.f.current.selected?.id, c);
  assert.equal(p.f.current.selectionChanging, true);
  assert.match(p.f.current.error, /无法确认当前会话.*TEST_CONFIRMATION_FAILED/);
  p.f.deferStateCommit(false);
  await p.f.current.selectSession(p.store.session(c));
  await p.f.settle();
  assert.equal(p.f.current.selectionChanging, false);
  assert.equal(p.f.current.error, '');
});

test('an old held confirmation cannot release a newer request awaiting its own completion', async (t) => {
  const p = await mainFixture(t, 'reply');
  const confirm = p.navigation.confirm.bind(p.navigation);
  const entered = deferred(),
    release = deferred();
  let count = 0;
  t.mock.method(p.navigation, 'confirm', () => {
    const snapshot = confirm();
    if (++count !== 1) return snapshot;
    entered.resolve();
    return release.promise.then(() => snapshot) as unknown as types.StateSnapshot;
  });
  const old = p.f.current.selectSession(p.original);
  p.f.flush();
  await entered.promise;
  await p.navigation.nativeCreate();
  const c = p.store.state.selectedSessionId!;
  const selected = p.holdSelection();
  const latest = p.f.current.selectSession(p.store.session(c));
  p.f.flush();
  await selected.entered.promise;
  release.resolve();
  await old;
  await p.f.settle();
  assert.equal(p.f.current.selected?.id, c);
  assert.equal(p.f.current.selectionChanging, true);
  selected.release.resolve();
  await latest;
  await p.f.settle();
  assert.equal(p.f.current.selectionChanging, false);
  assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
});

for (const phase of ['save', 'reply'] as const) {
  test(`actual main/store and hook accept ${phase === 'save' ? 'C/C/B' : 'B/C/B'} publication/completion order`, async (t) => {
    const p = await mainFixture(t, phase);
    const creating = p.f.current.createSession('P');
    p.f.flush();
    await p.entered.promise;
    const b = p.store.state.sessions.find((s) => s.projectId === 'P')!;
    assert.ok(b);
    await p.navigation.nativeCreate();
    const c = p.store.state.selectedSessionId!;
    assert.notEqual(c, b.id);
    p.release.resolve();
    await creating;
    await p.f.settle();
    const protocol = p.trace.filter((entry) => entry.kind !== 'call');
    assert.deepEqual(
      protocol.map((entry) => entry.kind),
      ['state', 'state', 'reply', 'confirmation'],
    );
    assert.deepEqual(
      protocol.map((entry) => entry.id),
      phase === 'save' ? [c, c, b.id, c] : [b.id, c, b.id, c],
    );
    assert.equal(p.f.current.selected?.id, c);
    assert.equal(p.f.current.selectionChanging, false);
    assert.equal(p.f.current.sessionEnabled, true);
    assert.ok(!p.trace.some((entry) => entry.method === 'connect'));
    assert.ok(p.store.state.sessions.every((s) => !p.agents.connected(s.id)));
    t.diagnostic(JSON.stringify({ phase, protocol, selected: p.f.current.selected?.id }));
  });
}

test('the first selected-ID render never displays the previous session history', async () => {
  const b = deferred<types.Message[]>();
  const f = harness((_method, id) => (id === 'B' ? b.promise : Promise.resolve(messages('A history'))));
  await f.settle();
  assert.deepEqual(f.current.messages, messages('A history'));
  const firstFrame = f.select('B');
  assert.deepEqual(firstFrame.messages, [], 'must be empty before selection effects run');
  f.flush();
  b.resolve(messages('B history'));
  await f.settle();
  assert.deepEqual(f.current.messages, messages('B history'));
  f.unmount();
});

test('starting, extension setup and failed cold runtimes retain history; live and connected-empty are authoritative', async () => {
  const f = harness(() => Promise.resolve(messages('saved history')));
  f.select('B');
  f.flush();
  await f.settle();
  for (const patch of [
    { status: 'starting' as const },
    { status: 'starting' as const, dialogs: [{ id: 'setup', title: 'Extension setup' }] },
    { status: 'error' as const },
  ]) {
    f.select('B', { ...types.emptyRuntime(), sessionId: 'B', ...patch } as types.Runtime);
    f.flush();
    assert.deepEqual(f.current.messages, messages('saved history'));
  }
  f.select('B', { ...types.emptyRuntime(), sessionId: 'B', messages: messages('live') });
  assert.deepEqual(f.current.messages, messages('live'));
  f.select('B', { ...types.emptyRuntime(), sessionId: 'B', connected: true });
  assert.deepEqual(f.current.messages, [], 'an authoritative empty transcript must not resurrect JSONL');
  f.unmount();
});

test('a history read resolving after connection cannot repopulate an empty live transcript', async () => {
  const history = deferred<types.Message[]>();
  const f = harness(() => history.promise);
  f.select('A', { ...types.emptyRuntime(), sessionId: 'A', connected: true });
  f.flush();
  history.resolve(messages('obsolete persisted history'));
  await f.settle();
  assert.deepEqual(f.current.messages, []);
  f.unmount();
});

for (const outcome of ['success', 'failure'] as const) {
  test(`B to C to B discards obsolete history ${outcome} without scroll timers`, async () => {
    const first = deferred<types.Message[]>(),
      c = deferred<types.Message[]>(),
      last = deferred<types.Message[]>();
    let reads = 0;
    const f = harness((_method, id) =>
      id === 'B' ? (++reads === 1 ? first : last).promise : id === 'C' ? c.promise : Promise.resolve([]),
    );
    f.select('B');
    f.flush();
    f.select('C');
    f.flush();
    f.select('B');
    f.flush();
    assert.equal([...f.timers.values()].filter((timer) => timer.delay === 80).length, 0);
    last.resolve(messages('latest B'));
    await f.settle();
    if (outcome === 'success') first.resolve(messages('obsolete B'));
    else first.reject(new Error('obsolete B history error'));
    c.resolve(messages('obsolete C'));
    await f.settle();
    assert.deepEqual(f.current.messages, messages('latest B'));
    assert.equal(f.current.error, '');
    f.unmount();
    assert.equal(f.timers.size, 0);
  });
}

test('only the current session restores its saved scroll position', async () => {
  const f = harness(() => Promise.resolve([]));
  f.view.state.sessions = f.view.state.sessions.map((s) => ({ ...s, scrollTop: s.id === 'B' ? 45 : 120 }));
  const positions: number[] = [];
  f.current.thread.current = {
    get scrollTop() {
      return 0;
    },
    set scrollTop(value: number) {
      positions.push(value);
    },
    scrollHeight: 1000,
  } as HTMLDivElement;
  f.select('B');
  f.flush();
  f.select('C');
  f.flush();
  await f.settle();
  f.fireTimers(80);
  assert.equal(positions.at(-1), 120);
  assert.ok(!positions.includes(45), 'an obsolete history must not restore its position');
  f.unmount();
});

test('edits during the draft save barrier cancel the old send snapshot', async () => {
  const calls: string[] = [];
  const saving = deferred();
  const f = harness(async (method) => {
    calls.push(method);
    return [];
  });
  let revision = 0;
  f.draft.composeDraft = () => 'same prompt';
  f.draft.getDraftRevision = () => revision;
  f.draft.flushDraft = () => saving.promise;
  f.view.environment.supported = true;
  f.select('A');
  f.flush();
  const sending = f.current.send();
  f.flush();
  revision++;
  f.draft.attachments = ['added-during-save.txt'] as never[];
  f.render();
  saving.resolve();
  await sending;
  await f.settle();
  assert.ok(!calls.includes('send'));
  assert.deepEqual(f.current.attachments, ['added-during-save.txt']);
  assert.match(f.current.notice, /草稿.*变化/);
  f.unmount();
});

for (const top of [0, 700]) {
  test(`history completion restores saved position ${top} after an arbitrarily delayed read`, async () => {
    const history = deferred<types.Message[]>();
    const f = harness(() => history.promise);
    f.view.state.sessions = f.view.state.sessions.map((s) => ({ ...s, scrollTop: top }));
    const element = { scrollTop: -1, scrollHeight: 2000 } as HTMLDivElement;
    f.current.thread.current = element;
    f.select('B');
    f.flush();
    f.fireTimers(80);
    assert.equal(element.scrollTop, -1);
    history.resolve(messages('loaded after the old timeout'));
    await f.settle();
    assert.equal(element.scrollTop, top);
    assert.equal(f.current.autoScroll.current, false);
    f.unmount();
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`unmount cancels history ${outcome} and pending scroll restoration`, async () => {
    const history = deferred<types.Message[]>();
    const f = harness(() => history.promise);
    f.unmount();
    if (outcome === 'success') history.resolve(messages('late'));
    else history.reject(new Error('late history error'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.updatesAfterUnmount, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('selectSession completion never writes history or closes a newer search', async () => {
  const old = deferred<types.Message[]>(),
    latest = deferred<types.Message[]>();
  const f = harness((method, id) =>
    method === 'readHistory' ? Promise.resolve(messages(`${id} JSONL`)) : (id === 'B' ? old : latest).promise,
  );
  const b = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const c = f.current.selectSession(session('C'));
  f.select('C');
  f.flush();
  latest.resolve(messages('C IPC'));
  await c;
  await f.settle();
  f.current.setSearchOpen(true);
  f.flush();
  old.resolve(messages('B IPC'));
  await b;
  await f.settle();
  assert.equal(f.current.searchOpen, true, 'obsolete completion cannot close a newly opened search');
  assert.deepEqual(f.current.messages, messages('C JSONL'));
  f.unmount();
});

test('reopening search during the current selection survives its eventual completion', async () => {
  const connection = deferred<types.Message[]>();
  const f = harness((method) => (method === 'readHistory' ? Promise.resolve([]) : connection.promise));
  f.current.setSearchOpen(true);
  f.flush();
  const selecting = f.current.selectSession(session('B'));
  f.flush();
  assert.equal(f.current.searchOpen, false, 'the choice consumes the search immediately');
  f.select('B');
  f.flush();
  f.current.setSearchOpen(true);
  f.flush();
  connection.resolve([]);
  await selecting;
  await f.settle();
  assert.equal(f.current.searchOpen, true, 'completion must not dismiss a later user-opened search');
  f.unmount();
});

test('B selection is pending on B, while A and C remain independently usable', async () => {
  const connection = deferred<types.Message[]>();
  const f = harness((method) => (method === 'readHistory' ? Promise.resolve([]) : connection.promise));
  const selecting = f.current.selectSession(session('B'));
  f.flush();
  assert.equal(f.current.pending, false, 'the click must not charge the previous A session');
  f.select('B');
  f.flush();
  assert.equal(f.current.pending, true);
  f.select('C');
  f.flush();
  assert.equal(f.current.pending, false);
  connection.resolve([]);
  await selecting;
  await f.settle();
  f.select('B');
  f.flush();
  assert.equal(f.current.pending, false);
  f.unmount();
});

test('overlapping selections of the same ID retain pending until both settle', async () => {
  const first = deferred<types.Message[]>(),
    second = deferred<types.Message[]>();
  let count = 0;
  const f = harness((method) =>
    method === 'readHistory' ? Promise.resolve([]) : (++count === 1 ? first : second).promise,
  );
  const one = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const two = f.current.selectSession(session('B'));
  f.flush();
  second.resolve([]);
  await two;
  await f.settle();
  assert.equal(f.current.pending, true);
  first.resolve([]);
  await one;
  await f.settle();
  assert.equal(f.current.pending, false);
  f.unmount();
});

test('current B selection failure belongs to B, never the click-time A closure', async () => {
  const connection = deferred<types.Message[]>();
  const f = harness((method) => (method === 'readHistory' ? Promise.resolve([]) : connection.promise));
  const selecting = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  connection.reject(new Error('B selection failed'));
  await selecting;
  await f.settle();
  assert.match(f.current.error, /B selection failed/);
  assert.equal(f.current.pending, false);
  f.select('A');
  f.flush();
  assert.equal(f.current.error, '');
  f.unmount();
});

test('an obsolete B failure cannot overwrite the newer C failure or leak into A', async () => {
  const old = deferred<types.Message[]>(),
    latest = deferred<types.Message[]>();
  const f = harness((method, id) =>
    method === 'readHistory' ? Promise.resolve([]) : (id === 'B' ? old : latest).promise,
  );
  const b = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const c = f.current.selectSession(session('C'));
  f.select('C');
  f.flush();
  latest.reject(new Error('current C failure'));
  await c;
  await f.settle();
  old.reject(new Error('obsolete B failure'));
  await b;
  await f.settle();
  assert.equal(f.current.error, 'current C failure');
  f.select('B');
  f.flush();
  assert.equal(f.current.error, '');
  f.select('A');
  f.flush();
  assert.equal(f.current.error, '');
  f.unmount();
});

test('B to C to B ignores an old failure after newer success and clears the previous retry error', async () => {
  const old = deferred<types.Message[]>();
  let bCalls = 0;
  const f = harness((method, id) =>
    method === 'readHistory'
      ? Promise.resolve([])
      : id === 'B' && ++bCalls === 1
        ? old.promise
        : Promise.resolve([]),
  );
  const one = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  f.current.setError('previous B failure');
  f.flush();
  const c = f.current.selectSession(session('C'));
  f.select('C');
  f.flush();
  await c;
  const two = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  await two;
  await f.settle();
  old.reject(new Error('obsolete B selection failure'));
  await one;
  await f.settle();
  assert.equal(f.current.error, '');
  assert.equal(f.current.pending, false);
  f.select('A');
  f.flush();
  assert.equal(f.current.error, '');
  f.unmount();
});

test('same-ID callers still expose the latest selection failure', async () => {
  const shared = deferred<types.Message[]>();
  const f = harness((method) => (method === 'readHistory' ? Promise.resolve([]) : shared.promise));
  const one = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const two = f.current.selectSession(session('B'));
  f.flush();
  shared.reject(new Error('shared connection failed'));
  await Promise.all([one, two]);
  await f.settle();
  assert.match(f.current.error, /shared connection failed/);
  assert.equal(f.current.pending, false);
  f.select('A');
  f.flush();
  assert.equal(f.current.error, '');
  f.unmount();
});

test('new-session intent invalidates an old selection failure without unlocking a separate action', async () => {
  const connection = deferred<types.Message[]>(),
    other = deferred();
  const f = harness((method) =>
    method === 'readHistory'
      ? Promise.resolve([])
      : method === 'newSession'
        ? Promise.resolve(session('new'))
        : connection.promise,
  );
  const selecting = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const working = f.current.action(() => other.promise);
  await f.current.createSession();
  connection.reject(new Error('obsolete B failure'));
  await selecting;
  await f.settle();
  assert.equal(f.current.error, '');
  assert.equal(f.current.pending, true);
  other.resolve();
  await working;
  await f.settle();
  assert.equal(f.current.pending, false);
  f.select('A');
  f.flush();
  assert.equal(f.current.error, '');
  f.unmount();
});

for (const empty of [false, true]) {
  test(`opening and revisiting a ${empty ? 'new empty' : 'saved'} chat never automatically connects`, async () => {
    const calls: string[] = [];
    const f = harness((method) => {
      calls.push(method);
      return Promise.resolve([]);
    });
    f.view.environment = { supported: true, authExists: true, modelsExist: true };
    if (empty)
      f.view.state.sessions = f.view.state.sessions.map((s) =>
        s.id === 'B' ? { ...s, file: undefined } : s,
      );
    const selecting = f.current.selectSession(session('B'));
    f.select('B');
    f.flush();
    await selecting;
    await f.settle();
    f.select('C');
    f.flush();
    f.select('B');
    f.flush();
    await f.settle();
    assert.equal(f.current.pending, false);
    assert.equal(f.current.ownRunning, false);
    assert.equal(calls.includes('connect'), false);
    assert.equal(calls.includes('send'), false);
    f.unmount();
  });
}

test('an explicit connection still reads Pi models without sending a task', async () => {
  const calls: { method: string; id?: string }[] = [];
  const f = harness((method, id) => {
    calls.push({ method, id });
    return Promise.resolve([]);
  });
  f.select('B');
  f.flush();
  await f.current.connect();
  await f.settle();
  assert.deepEqual(
    calls.filter((call) => call.method === 'connect'),
    [{ method: 'connect', id: 'B' }],
  );
  assert.equal(
    calls.some((call) => call.method === 'send'),
    false,
  );
  assert.equal(f.current.pending, false);
  f.unmount();
});

test('the first prompt is sent to the selected cold chat without a separate eager connection', async () => {
  const calls: { method: string; id?: string }[] = [];
  const f = harness((method, id) => {
    calls.push({ method, id });
    return Promise.resolve([]);
  });
  f.view.environment = { supported: true, authExists: true, modelsExist: true };
  f.draft.composeDraft = () => 'First task in B';
  f.select('B');
  f.flush();
  await f.current.send();
  await f.settle();
  assert.deepEqual(
    calls.filter((call) => call.method === 'send'),
    [{ method: 'send', id: 'B' }],
  );
  assert.equal(
    calls.some((call) => call.method === 'connect'),
    false,
  );
  assert.equal(f.current.pending, false);
  f.unmount();
});

test('selection completion waits for the received authoritative snapshot to render', async () => {
  const selecting = deferred<types.Message[]>();
  const calls: string[] = [];
  const f = harness((method) => {
    calls.push(method);
    return method === 'selectSession' ? selecting.promise : Promise.resolve([]);
  });
  const operation = f.current.selectSession(session('B'));
  f.deferStateCommit();
  f.flush();
  assert.equal(f.current.selectionChanging, true);
  assert.equal(f.current.selected?.id, 'A');
  f.receiveState({ ...f.view.state, selectedSessionId: 'B' });
  selecting.resolve([]);
  await operation;
  await f.settle();
  assert.equal(f.current.selectionChanging, true, 'an IPC result alone does not commit queued state');
  f.commitState();
  f.flush();
  assert.equal(f.current.selectionChanging, false);
  assert.ok(!calls.includes('connect'));
  f.unmount();
});

test('obsolete creation completion cannot unlock a newer transition or restore an old target', async () => {
  const first = deferred<types.Session>(),
    second = deferred<types.Session>();
  let count = 0;
  const f = harness((method) =>
    method === 'newSession' ? (++count === 1 ? first.promise : second.promise) : Promise.resolve([]),
  );
  const a = f.current.createSession();
  f.flush();
  const b = f.current.createSession();
  f.flush();
  first.resolve(session('B'));
  await a;
  await f.settle();
  f.select('B');
  f.flush();
  assert.equal(f.current.selectionChanging, true);
  f.deferStateCommit();
  f.receiveState({ ...f.view.state, selectedSessionId: 'C' });
  second.resolve(session('C'));
  await b;
  await f.settle();
  assert.equal(f.current.selectionChanging, true);
  f.commitState();
  f.flush();
  assert.equal(f.current.selectionChanging, false);
  assert.equal(f.current.selected?.id, 'C');
  f.unmount();
});

test('a new selection cancels the old transition owner and failures release the model entry', async () => {
  const old = deferred<types.Message[]>(),
    latest = deferred<types.Message[]>();
  const f = harness((method, id) =>
    method === 'selectSession' ? (id === 'B' ? old.promise : latest.promise) : Promise.resolve([]),
  );
  const b = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const c = f.current.selectSession(session('C'));
  f.select('C');
  f.flush();
  old.resolve([]);
  await b;
  await f.settle();
  assert.equal(f.current.selectionChanging, true);
  latest.reject(new Error('selection rejected'));
  await c;
  await f.settle();
  assert.equal(f.current.selectionChanging, false);
  assert.match(f.current.error, /selection rejected/);
  f.unmount();
});

test('failed new chat releases the transition without connecting or changing selection', async () => {
  const f = harness((method) =>
    method === 'newSession' ? Promise.reject(new Error('creation cancelled')) : Promise.resolve([]),
  );
  await f.current.createSession();
  await f.settle();
  assert.equal(f.current.selectionChanging, false);
  assert.equal(f.current.selected?.id, 'A');
  assert.match(f.current.error, /creation cancelled/);
  f.unmount();
});

test('a native-menu selection supersedes an in-flight renderer selection before its late success reply', async () => {
  const selecting = deferred<types.Message[]>();
  const calls: { method: string; id?: string }[] = [];
  const f = harness((method, id) => {
    calls.push({ method, id });
    return method === 'selectSession' ? selecting.promise : Promise.resolve([]);
  });
  const operation = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  f.select('C'); // Native File > New Chat broadcasts a new selected ID outside this hook.
  f.flush();
  selecting.resolve([]);
  await operation;
  await f.settle();
  assert.equal(f.current.selected?.id, 'C');
  assert.equal(f.current.selectionChanging, false);
  assert.equal(f.current.sessionEnabled, true);
  assert.deepEqual(
    calls.filter((call) => call.method === 'connect'),
    [],
  );
  await f.current.connect();
  await f.settle();
  assert.deepEqual(
    calls.filter((call) => call.method === 'connect'),
    [{ method: 'connect', id: 'C' }],
  );
  f.unmount();
});

test('deleting the observed selection releases its transition for the surviving fallback chat', async () => {
  const selecting = deferred<types.Message[]>();
  const calls: string[] = [];
  const f = harness((method) => {
    calls.push(method);
    return method === 'selectSession' ? selecting.promise : Promise.resolve([]);
  });
  const operation = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const oldModel = f.current.setModel;
  f.view.state.sessions = f.view.state.sessions.filter((s) => s.id !== 'B');
  f.select('C');
  f.flush();
  selecting.resolve([]);
  await operation;
  await f.settle();
  assert.equal(f.current.selected?.id, 'C');
  assert.equal(f.current.selectionChanging, false);
  assert.equal(f.current.sessionEnabled, true);
  await oldModel('provider::model');
  assert.ok(!calls.includes('setSessionModel'));
  assert.ok(!calls.includes('connect'));
  assert.ok(!f.view.state.sessions.some((s) => s.id === 'B'));
  f.unmount();
});

test('external selection and an old completion cannot release a newer unobserved hook target', async () => {
  const old = deferred<types.Message[]>(),
    latest = deferred<types.Message[]>();
  const calls: string[] = [];
  const f = harness((method, id) => {
    calls.push(method);
    return method === 'selectSession' ? (id === 'B' ? old.promise : latest.promise) : Promise.resolve([]);
  });
  const b = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  const c = f.current.selectSession(session('C'));
  f.flush();
  f.select('A');
  f.flush();
  assert.equal(f.current.selectionChanging, true);
  old.resolve([]);
  await b;
  await f.settle();
  assert.equal(f.current.selectionChanging, true);
  await f.current.connect();
  assert.ok(!calls.includes('connect'));
  f.select('C');
  f.flush();
  assert.equal(f.current.selectionChanging, true, 'the latest IPC must still complete');
  latest.resolve([]);
  await c;
  await f.settle();
  assert.equal(f.current.selectionChanging, false);
  assert.equal(f.current.selected?.id, 'C');
  f.unmount();
});

for (const kind of ['selection', 'creation', 'blank reuse'] as const) {
  test(`authoritative ${kind} and external selection events survive a coalesced React render`, async () => {
    const response = deferred<unknown>();
    const calls: string[] = [];
    const f = harness((method) => {
      calls.push(method);
      return ['selectSession', 'newSession'].includes(method) ? response.promise : Promise.resolve([]);
    });
    const target = kind === 'blank reuse' ? 'A' : 'B';
    const operation =
      kind === 'selection' ? f.current.selectSession(session(target)) : f.current.createSession();
    f.flush();
    // useRuntime sees both authoritative events before React renders just C.
    f.emitSelection(target);
    f.emitSelection('C');
    f.render();
    f.flush();
    response.resolve(kind === 'selection' ? [] : session(target));
    await operation;
    await f.settle();
    assert.equal(f.current.selected?.id, 'C');
    assert.equal(f.current.selectionChanging, false);
    assert.equal(f.current.sessionEnabled, true);
    assert.ok(!calls.includes('connect'));
    f.unmount();
  });
}

test('a creation result cannot override or lock a different authoritative selected session', async () => {
  const response = deferred<types.Session>();
  const calls: string[] = [];
  const f = harness((method) => {
    calls.push(method);
    return method === 'newSession' ? response.promise : Promise.resolve([]);
  });
  const creating = f.current.createSession();
  f.flush();
  f.emitSelection('C');
  f.render();
  f.flush();
  response.resolve(session('B'));
  await creating;
  await f.settle();
  assert.equal(f.current.selected?.id, 'C');
  assert.equal(f.current.selectionChanging, false);
  assert.equal(f.current.sessionEnabled, true);
  assert.ok(!calls.includes('connect'));
  f.unmount();
});

test('unchanged selected state and recovered background sessions are not external navigation', async () => {
  const response = deferred<types.Message[]>();
  const f = harness((method) => (method === 'selectSession' ? response.promise : Promise.resolve([])));
  const operation = f.current.selectSession(session('B'));
  f.select('B');
  f.flush();
  f.view.state.sessions = [...f.view.state.sessions, session('recovered-image')];
  f.emitSelection('B');
  f.render();
  f.flush();
  assert.equal(f.current.selected?.id, 'B');
  assert.equal(f.current.selectionChanging, true);
  response.resolve([]);
  await operation;
  await f.settle();
  assert.equal(f.current.selectionChanging, false);
  f.unmount();
});

test('old connection and model catalog callbacks cannot run after navigation starts, even before the next render', async () => {
  const next = deferred<types.Session>();
  const calls: string[] = [];
  const f = harness((method) => {
    calls.push(method);
    return method === 'newSession' ? next.promise : Promise.resolve([]);
  });
  const oldConnect = f.current.connect,
    oldReadModels = f.current.readModels;
  const changing = f.current.createSession();
  await oldConnect();
  await oldReadModels();
  assert.ok(!calls.includes('connect'));
  assert.ok(!calls.includes('readModels'));
  f.flush();
  await f.current.connect();
  await f.current.readModels();
  assert.ok(!calls.includes('connect'));
  assert.ok(!calls.includes('readModels'));
  next.resolve(session('B'));
  await changing;
  f.select('B');
  f.flush();
  await f.current.readModels();
  await f.settle();
  await f.current.connect();
  await f.settle();
  assert.equal(calls.filter((call) => call === 'readModels').length, 1);
  assert.equal(calls.filter((call) => call === 'connect').length, 1);
  f.unmount();
});

test('model and thinking callbacks belong to their original session and navigation request', async () => {
  const next = deferred<types.Session>();
  const calls: { method: string; id?: string }[] = [];
  const f = harness((method, id) => {
    calls.push({ method, id });
    return method === 'newSession' ? next.promise : Promise.resolve([]);
  });
  const oldModel = f.current.setModel,
    oldThinking = f.current.setThinking;
  const changing = f.current.createSession();
  await oldModel('provider::model');
  await oldThinking('high');
  f.flush();
  next.resolve(session('B'));
  await changing;
  f.select('B');
  f.flush();
  await oldModel('provider::model');
  await oldThinking('high');
  assert.deepEqual(
    calls.filter((call) => call.method.startsWith('setSession')),
    [],
  );
  await f.current.setModel('provider::model');
  await f.settle();
  await f.current.setThinking('high');
  await f.settle();
  assert.deepEqual(
    calls.filter((call) => call.method.startsWith('setSession')),
    [
      { method: 'setSessionModel', id: 'B' },
      { method: 'setSessionThinking', id: 'B' },
    ],
  );
  f.unmount();
});

test('an external selection change invalidates every old model action without relying on popup cleanup', async () => {
  const calls: { method: string; id?: string }[] = [];
  const f = harness((method, id) => {
    calls.push({ method, id });
    return Promise.resolve([]);
  });
  const previous = f.current;
  f.select('B');
  // Deliberately do not flush effects, including any selection cleanup.
  await previous.connect();
  await previous.readModels();
  await previous.setModel('provider::model');
  await previous.setThinking('high');
  assert.deepEqual(
    calls.filter((call) =>
      ['connect', 'readModels', 'setSessionModel', 'setSessionThinking'].includes(call.method),
    ),
    [],
  );
  f.view.storage.writable = false;
  f.select('B');
  await f.current.connect();
  await f.current.readModels();
  await f.current.setModel('provider::model');
  await f.current.setThinking('high');
  assert.deepEqual(
    calls.filter((call) =>
      ['connect', 'readModels', 'setSessionModel', 'setSessionThinking'].includes(call.method),
    ),
    [],
    'a disabled target must reject model actions as well as connections',
  );
  f.unmount();
});
