import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as types from '../shared/types';
import { defaultSettings } from '../electron/store-state';
import { readableError } from '../src/lib/format';
import { RuntimeStore } from '../src/lib/runtime-store';

const { code } = transformSync(readFileSync('src/hooks/useRuntime.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
});
const state = (id: string): types.AppState => ({
  version: 1,
  projects: [],
  sessions: [{ id, title: id, draft: '', attachments: [], updatedAt: 1, lastStatus: 'idle' }],
  selectedSessionId: id,
  settings: { ...defaultSettings, provider: id },
});
function fixture(initialPrefs?: types.Settings) {
  const slots: any[] = [],
    effects: (() => void | (() => void))[] = [];
  let cursor = 0,
    listener: ((event: types.AppEvent) => void) | undefined;
  let prefs = initialPrefs;
  let resolve!: (value: types.Bootstrap) => void;
  const bootstrap = new Promise<types.Bootstrap>((done) => {
    resolve = done;
  });
  const hooks = {
    useCallback(fn: unknown) {
      return fn;
    },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) {
      return snapshot();
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (value: any) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(run: () => void | (() => void)) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = true;
        effects.push(run);
      }
    },
  };
  const dependencies: Record<string, unknown> = {
    react: hooks,
    '../../shared/types': types,
    '../lib/format': { readableError },
    '../lib/runtime-store': { RuntimeStore },
  };
  const module = { exports: {} };
  const useRuntime = new Function(
    'require',
    'module',
    'exports',
    'window',
    `${code}; return module.exports.useRuntime;`,
  )(
    (name: string) => {
      assert.ok(name in dependencies);
      return dependencies[name];
    },
    module,
    module.exports,
    {
      desktop: {
        invoke: () => bootstrap,
        onEvent: (next: typeof listener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    },
  ) as typeof import('../src/hooks/useRuntime').useRuntime;
  const render = () => {
    cursor = 0;
    return useRuntime(
      () => {},
      (value) => {
        prefs = typeof value === 'function' ? value(prefs) : value;
      },
    );
  };
  render();
  const cleanup = effects.map((run) => run());
  return {
    render,
    get prefs() {
      return prefs;
    },
    emit: (id: string, revision: number) => listener?.({ type: 'state', state: state(id), revision }),
    async bootstrap(id: string, revision: number) {
      resolve({
        state: state(id),
        revision,
        runtime: types.emptyRuntime(),
        storage: { writable: true },
      } as types.Bootstrap);
      await new Promise<void>((done) => setImmediate(done));
    },
    dispose: () => cleanup.forEach((stop) => stop?.()),
  };
}

test('production useRuntime drops old state events and a late bootstrap from the same main revision stream', async () => {
  const f = fixture();
  f.emit('B', 4);
  await f.bootstrap('A', 1);
  assert.equal(f.render().state?.selectedSessionId, 'B');
  f.emit('C', 3);
  f.emit('C', 4);
  assert.equal(f.render().state?.selectedSessionId, 'B');
  assert.equal(f.render().stateRevision, 4);
  assert.equal(f.prefs?.provider, 'B');
  f.dispose();
});

test('a late bootstrap cannot replace an already edited settings draft', async () => {
  const f = fixture({ ...defaultSettings, provider: 'unsaved draft' });
  f.emit('B', 4);
  await f.bootstrap('A', 1);
  assert.equal(f.render().state?.selectedSessionId, 'B');
  assert.equal(f.prefs?.provider, 'unsaved draft');
  f.dispose();
});

test('a completion snapshot cannot replace a newer authoritative event or a newer confirmation', async () => {
  const f = fixture();
  await f.bootstrap('A', 1);
  f.emit('D', 8);
  f.render().receiveState(state('C'), 6);
  assert.equal(f.render().state?.selectedSessionId, 'D');
  f.render().receiveState(state('E'), 10);
  f.emit('C', 9);
  f.render().receiveState(state('B'), 7);
  assert.equal(f.render().state?.selectedSessionId, 'E');
  assert.equal(f.render().stateRevision, 10);
  f.dispose();
});

test('state and its revision commit together, while the received snapshot invalidates old actions immediately', async () => {
  const f = fixture();
  await f.bootstrap('A', 1);
  const committed = f.render();
  f.emit('C', 5);
  assert.equal(committed.state?.selectedSessionId, 'A');
  assert.equal(committed.stateRevision, 1);
  assert.equal(committed.receivedState.current.state?.selectedSessionId, 'C');
  assert.equal(committed.receivedState.current.revision, 5);
  const next = f.render();
  assert.equal(next.state?.selectedSessionId, 'C');
  assert.equal(next.stateRevision, 5);
  f.dispose();
});
