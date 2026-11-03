import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { watchedPath, WorkspaceWatcher } from '../electron/workspace-watch';
import type { Project } from '../shared/types';
import type { WorkspaceChangedEvent } from '../shared/workspace';

type Batch = { elapsedMs: number; event: WorkspaceChangedEvent };

// Native callbacks can arrive late, in multiple batches, or without a filename.
// Match the preview consumer: a parent directory alone does not cover a file.
async function waitForChangedPaths(
  batches: Batch[],
  projectId: string,
  expectedPaths: string[],
  timeoutMs = 5_000,
) {
  const startedAt = performance.now();
  for (;;) {
    const relevant = batches.filter(
      ({ event }) => event.type === 'workspaceChanged' && event.projectId === projectId,
    );
    if (relevant.some(({ event }) => event.changedPaths === undefined)) return;
    const changed = new Set(relevant.flatMap(({ event }) => event.changedPaths ?? []));
    const missingPaths = expectedPaths.filter((name) => !changed.has(name));
    if (missingPaths.length === 0) return;
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      assert.fail(
        `Native watcher did not cover external writes: ${JSON.stringify({
          projectId,
          expectedPaths,
          missingPaths,
          timeoutMs,
          elapsedMs: Math.round(elapsedMs),
          batches: batches.map(({ elapsedMs, event }) => ({
            elapsedMs,
            ...event,
            changedPaths: event.changedPaths ?? '<all paths>',
          })),
        })}`,
      );
    }
    await delay(Math.min(25, timeoutMs - elapsedMs));
  }
}

async function fakeWatcher(t: TestContext, options: Parameters<typeof WorkspaceWatcher.watch>[3] = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const project: Project = {
    id: randomUUID(),
    path: path.resolve('work', 'watcher-unit'),
    name: 'workspace',
    trusted: true,
    createdAt: 0,
  };
  type WatchFactory = NonNullable<Parameters<typeof WorkspaceWatcher.watch>[2]>;
  let listener!: Parameters<WatchFactory>[2];
  let onError!: () => void;
  const close = t.mock.fn();
  const factory = t.mock.fn<WatchFactory>((root, options, callback) => {
    assert.equal(root, project.path);
    assert.deepEqual(options, { recursive: true });
    listener = callback;
    return {
      close,
      on(event, callback) {
        assert.equal(event, 'error');
        onError = callback;
      },
    };
  });
  const events: WorkspaceChangedEvent[] = [];
  const watcher = await WorkspaceWatcher.watch(project, (event) => events.push(event), factory, options);
  t.after(() => watcher.dispose());
  assert.equal(factory.mock.callCount(), 1);
  return {
    project,
    events,
    watcher,
    close,
    factory,
    emit: (file: string | null, event: 'change' | 'rename' = 'change') => listener(event, file),
    error: () => onError(),
  };
}

test('watcher filters generated paths but retains Git HEAD/index/refs', () => {
  for (const name of [
    'node_modules/a.js',
    'dist/b.js',
    'dist-electron/main.cjs',
    'release/app.zip',
    '.next/build',
    '.cache/a',
    '__pycache__/a.pyc',
    '.venv/bin/python',
    'venv/bin/python',
    'src/node_modules/b',
    '.git/objects/ab/cd',
    'src/.git/HEAD',
    'src\\node_modules\\b',
    ...[
      'target',
      'build',
      'out',
      'coverage',
      '.turbo',
      '.gradle',
      '.idea',
      '.pytest_cache',
      '.mypy_cache',
    ].map((name) => `src/${name}/generated`),
  ])
    assert.equal(watchedPath(name), false, name);
  for (const name of ['src/a.ts', '.git/HEAD', '.git/index', '.git/refs/heads/main'])
    assert.equal(watchedPath(name), true, name);
});

test('watcher debounces from the last callback and merges exact paths without duplicates', async (t) => {
  const { project, events, emit } = await fakeWatcher(t);
  emit(path.join('src', 'a.ts'));
  t.mock.timers.tick(299);
  assert.deepEqual(events, []);
  emit(path.join('src', 'b.ts'), 'rename');
  t.mock.timers.tick(1);
  assert.deepEqual(events, [], 'the original 300ms deadline must be cancelled');
  t.mock.timers.tick(298);
  assert.deepEqual(events, []);
  emit(path.join('src', 'a.ts'));
  t.mock.timers.tick(299);
  assert.deepEqual(events, [], 'a repeated path still resets the deadline');
  t.mock.timers.tick(1);
  assert.deepEqual(events, [
    { type: 'workspaceChanged', projectId: project.id, changedPaths: ['src/a.ts', 'src/b.ts'] },
  ]);
  t.mock.timers.tick(1_000);
  assert.equal(events.length, 1, 'a batch is emitted only once');
});

test('watcher clears known and unknown paths between batches', async (t) => {
  const { project, events, emit } = await fakeWatcher(t);
  emit('src/a.ts');
  t.mock.timers.tick(300);
  emit('src/b.ts');
  emit(null);
  emit('src/c.ts');
  t.mock.timers.tick(300);
  emit('src/d.ts');
  t.mock.timers.tick(300);
  emit(null);
  t.mock.timers.tick(300);
  emit('src/e.ts');
  t.mock.timers.tick(300);
  assert.deepEqual(
    events,
    [['src/a.ts'], undefined, ['src/d.ts'], undefined, ['src/e.ts']].map((changedPaths) => ({
      type: 'workspaceChanged',
      projectId: project.id,
      changedPaths,
    })),
  );
});

test('ignored callbacks neither emit nor postpone a pending batch; Git metadata remains watched', async (t) => {
  const { project, events, emit } = await fakeWatcher(t);
  emit('node_modules/a.js');
  emit('.git/objects/ab/cd');
  t.mock.timers.tick(1_000);
  assert.deepEqual(events, []);
  emit('src/a.ts');
  t.mock.timers.tick(299);
  emit('dist/b.js');
  t.mock.timers.tick(1);
  assert.deepEqual(events, [{ type: 'workspaceChanged', projectId: project.id, changedPaths: ['src/a.ts'] }]);
  for (const name of ['.git/HEAD', '.git/index', '.git/refs/heads/main']) emit(name);
  t.mock.timers.tick(300);
  assert.deepEqual(events[1], {
    type: 'workspaceChanged',
    projectId: project.id,
    changedPaths: ['.git/HEAD', '.git/index', '.git/refs/heads/main'],
  });
});

test('dispose closes the native watcher, cancels pending delivery and ignores late callbacks', async (t) => {
  const { watcher, events, emit, close } = await fakeWatcher(t);
  emit('src/a.ts');
  emit(null);
  t.mock.timers.tick(299);
  watcher.dispose();
  assert.equal(close.mock.callCount(), 1);
  t.mock.timers.tick(1_000);
  assert.deepEqual(events, [], 'dispose cancels the pending known/unknown batch');
  emit('src/b.ts', 'rename');
  emit(null);
  t.mock.timers.tick(1_000);
  assert.deepEqual(events, [], 'a saved native listener cannot notify after disposal');
});

test('a native watcher error closes its handle without starting another watcher or timer', async (t) => {
  const { close, error, events, factory } = await fakeWatcher(t);
  error();
  assert.equal(close.mock.callCount(), 1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(events, []);
  assert.equal(factory.mock.callCount(), 1);
});

test('continuous file events notify within two seconds and active-task refreshes stay two seconds apart', async (t) => {
  const f = await fakeWatcher(t, { running: () => true });
  for (let i = 0; i < 20; i++) {
    f.emit(`src/file-${i}.ts`);
    t.mock.timers.tick(100);
  }
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].changedPaths?.length, 20);
  f.emit('src/next.ts');
  t.mock.timers.tick(1999);
  assert.equal(f.events.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.events.length, 2);
});

test('ignored output and failed native watchers invalidate checkpoint tracking without repeated UI refreshes', async (t) => {
  const changed = t.mock.fn(),
    failed = t.mock.fn();
  const f = await fakeWatcher(t, { changed, failed });
  for (let i = 0; i < 100; i++) f.emit(`build/file-${i}.js`);
  t.mock.timers.tick(2000);
  assert.equal(f.events.length, 0);
  assert.ok(changed.mock.calls.every((call) => call.arguments.length === 0));
  f.error();
  assert.equal(failed.mock.callCount(), 1);
});

test('native coverage wait requires both exact file paths or a matching full invalidation', async () => {
  const event = (changedPaths?: string[], projectId = 'project'): WorkspaceChangedEvent => ({
    type: 'workspaceChanged',
    projectId,
    changedPaths,
  });
  const batch = (event: WorkspaceChangedEvent, elapsedMs = 300): Batch => ({ elapsedMs, event });
  const expected = ['src/a.ts', 'src/b.ts'];
  await waitForChangedPaths(
    [batch(event(['src/a.ts'])), batch(event(['src/b.ts']), 900)],
    'project',
    expected,
    0,
  );
  await waitForChangedPaths([batch(event())], 'project', expected, 0);
  for (const [label, batches] of [
    ['no events', []],
    ['wrong path', [batch(event(['src/other.ts']))]],
    ['empty batch', [batch(event([]))]],
    ['parent only', [batch(event(['src']))]],
    ['one file only', [batch(event(['src/a.ts']))]],
    ['wrong project', [batch(event(undefined, 'other-project'))]],
  ] satisfies [string, Batch[]][]) {
    await assert.rejects(waitForChangedPaths(batches, 'project', expected, 0), (error: Error) => {
      assert.match(error.message, /Native watcher did not cover external writes/, label);
      assert.match(error.message, /"missingPaths":\[/, label);
      assert.match(error.message, /"elapsedMs":/, label);
      assert.match(error.message, /"batches":\[/, label);
      if (batches.length) assert.match(error.message, /"elapsedMs":300/, label);
      return true;
    });
  }
});

test('native recursive watcher covers both external file creations across delivered batches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workspace-watch-'));
  const project: Project = {
    id: randomUUID(),
    path: root,
    name: 'workspace',
    trusted: true,
    createdAt: Date.now(),
  };
  await fs.mkdir(path.join(root, 'src'));
  const batches: Batch[] = [];
  const startedAt = performance.now();
  const watcher = await WorkspaceWatcher.watch(project, (event) => {
    batches.push({ elapsedMs: Math.round(performance.now() - startedAt), event });
  });
  t.after(async () => {
    watcher.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a');
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'b');
  await waitForChangedPaths(batches, project.id, ['src/a.ts', 'src/b.ts']);
  t.diagnostic(
    `Native watcher batches: ${JSON.stringify(
      batches.map(({ elapsedMs, event }) => ({
        elapsedMs,
        ...event,
        changedPaths: event.changedPaths ?? '<all paths>',
      })),
    )}`,
  );
  for (const { event } of batches) {
    assert.equal(event.type, 'workspaceChanged');
    assert.equal(event.projectId, project.id);
  }
});
