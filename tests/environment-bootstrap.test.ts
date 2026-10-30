import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { defaultSettings } from '../electron/store';
import type { Environment } from '../shared/types';

// Exercise the production coordinator without launching Electron or subprocesses.
const source = readFileSync('electron/main.ts', 'utf8');
const start = source.indexOf('let environmentRevision =');
const end = source.indexOf('// Broadcasts, bootstrap', start);
assert.ok(start >= 0 && end > start);
const { code } = transformSync(
  `const create = (store, detectEnvironment, send) => {
  const developmentRoot = 'fixture';
  const agentDirectory = (settings) => settings.agentDir;
  ${source.slice(start, end)}
  return { refresh: refreshEnvironment, snapshot: () => environmentSnapshot };
};`,
  { loader: 'ts', format: 'cjs' },
);
const create = new Function(`${code}\nreturn create;`)();
const environment = (piPath: string): Environment => ({
  piPath,
  supported: true,
  compatibility: 'verified',
  agentDir: 'fixture',
  authExists: false,
  modelsExist: false,
  errors: [],
});
function deferred() {
  let resolve!: (value: Environment) => void;
  const promise = new Promise<Environment>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('layout saves during bootstrap preserve the pending environment result', async () => {
  const pending = deferred(),
    events: any[] = [];
  const store = { state: { settings: { ...defaultSettings, piPath: 'pi' } } };
  const probe = create(
    store,
    () => pending.promise,
    (event: unknown) => events.push(event),
  );
  const result = probe.refresh();
  store.state.settings = { ...store.state.settings, sidebarWidth: 280, theme: 'dark' };
  pending.resolve(environment('pi'));
  await result;
  assert.equal(events.length, 1);
  assert.equal(events[0].environment.piPath, 'pi');
  assert.equal(probe.snapshot().value.piPath, 'pi');
});

test('changed Pi paths restart an in-flight probe before publishing', async () => {
  const pending = deferred(),
    events: any[] = [],
    calls: string[] = [];
  const store = { state: { settings: { ...defaultSettings, piPath: 'old' } } };
  const probe = create(
    store,
    (settings: typeof defaultSettings) => {
      calls.push(settings.piPath);
      return settings.piPath === 'old' ? pending.promise : Promise.resolve(environment(settings.piPath));
    },
    (event: unknown) => events.push(event),
  );
  const result = probe.refresh();
  store.state.settings = { ...store.state.settings, piPath: 'new' };
  pending.resolve(environment('old'));
  assert.equal((await result).piPath, 'new');
  assert.deepEqual(calls, ['old', 'new']);
  assert.deepEqual(
    events.map((event) => event.environment.piPath),
    ['new'],
  );
});

test('superseded probes cannot overwrite a newer environment or hide a detection error', async () => {
  const pending = deferred(),
    events: any[] = [];
  const store = { state: { settings: { ...defaultSettings } } };
  let calls = 0;
  const probe = create(
    store,
    () => (++calls === 1 ? pending.promise : Promise.reject(new Error('probe failed'))),
    (event: unknown) => events.push(event),
  );
  const first = probe.refresh();
  await probe.refresh();
  pending.resolve(environment('obsolete'));
  await first;
  assert.equal(events.length, 1);
  assert.equal(events[0].environment.supported, false);
  assert.deepEqual(events[0].environment.errors, ['probe failed']);
});
