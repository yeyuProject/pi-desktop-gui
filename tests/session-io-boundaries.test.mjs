import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the production boundaries with deterministic filesystem faults, without
// starting Electron/Pi. Real-Pi and Store/selection coverage lives in the TS suites.
async function boundary(file, start, end, wrap, dependencies) {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
  assert.equal(source.split(start).length, 2);
  const body = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return new Function(
    ...Object.keys(dependencies),
    stripTypeScriptTypes(`function load() { ${wrap(body)} }`) + '\nreturn load();',
  )(...Object.values(dependencies));
}

for (const code of ['ENOENT', 'EACCES', 'EIO']) {
  test(`model copy ${code}: fallback only for missing source, always clean up`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-boundary-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const session = { file: path.join(root, 'source.jsonl') };
    await fs.writeFile(session.file, 'original history');
    const failure = Object.assign(new Error(code), { code });
    const directories = [];
    const starts = [];
    class Reader {
      on() {}
      start(_spec, _cwd, args) {
        starts.push(args);
      }
      async request(command) {
        return command === 'get_available_models' ? { models: [] } : { levels: [] };
      }
      async close() {}
    }
    const Probe = await boundary(
      '../electron/agent.ts',
      '  private async readModelCatalog(',
      '  assertCommandsStopped()',
      (body) => `return class Probe { ${body} };`,
      {
        fs: {
          ...fs,
          mkdtemp: async () => {
            const dir = await fs.mkdtemp(path.join(root, 'probe-'));
            directories.push(dir);
            return dir;
          },
          copyFile: async () => {
            throw failure;
          },
        },
        os,
        path,
        PiRpc: Reader,
        preparePi: async () => ({ environment: {}, resolved: { spec: {} } }),
        agentDirectory: () => root,
        piShellEnvironment: () => ({}),
        displayModel: (v) => v,
        errorText: (error) => error.message,
      },
    );
    const probe = new Probe();
    Object.assign(probe, {
      stopEpoch: 0,
      runtime: {},
      store: {
        flush: async () => {},
        assertWritable() {},
        session: () => session,
        sessionDirectory: async () => root,
        state: { settings: {} },
      },
      assertCommandsStopped() {},
      publish() {},
      clearDialogs() {},
      setError(error) {
        this.runtime.error = error;
      },
    });
    if (code === 'ENOENT') {
      await probe.readModelCatalog('session');
      assert.equal(probe.runtime.modelsLoaded, true);
      assert.ok(starts[0].includes('--no-session'));
      assert.ok(!starts[0].includes('--session'));
    } else {
      await assert.rejects(probe.readModelCatalog('session'), (error) => error === failure);
      assert.equal(starts.length, 0);
    }
    assert.equal(probe.runtime.modelsLoading, false);
    assert.equal(directories.length, 1);
    for (const dir of directories) await assert.rejects(fs.lstat(dir), { code: 'ENOENT' });
    assert.equal(await fs.readFile(session.file, 'utf8'), 'original history');
  });
}

for (const scenario of [
  'missing',
  'present',
  'empty',
  'lstat-EACCES',
  'lstat-EIO',
  'trash-EACCES',
  'trash-ENOENT',
  'cancel',
]) {
  test(`production delete boundary: ${scenario}`, async () => {
    const session = {
      id: 'current',
      title: 'chat',
      file: scenario === 'empty' ? undefined : '/transcript.jsonl',
    };
    const state = { sessions: [session], selectedSessionId: 'current' };
    const failure = Object.assign(new Error(scenario), { code: scenario.split('-')[1] });
    const calls = [];
    const handlers = await boundary(
      '../electron/main.ts',
      '  deleteSession: async (id)',
      '  pinSession:',
      (body) => `return { ${body} };`,
      {
        text() {},
        assertTerminalClosed: async () => {},
        store: {
          dir: '/fixture',
          purgeDeletedSession: async () => {},
          state,
          session: () => session,
          removeSessions: () => {
            state.sessions = [];
          },
          durableSessions: () => [{ id: 'other' }],
          selectSession: (id) => {
            state.selectedSessionId = id;
          },
        },
        service: { active: () => false, release: async () => {} },
        workspace: { removeSession: async () => {} },
        removeSessionScratch: async () => {},
        showAppDialog: async () => ({ response: scenario === 'cancel' ? 0 : 1 }),
        save: async () => {},
        fs: {
          lstat: async () => {
            calls.push('lstat');
            if (scenario === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            if (scenario.startsWith('lstat-')) throw failure;
          },
        },
        shell: {
          trashItem: async () => {
            calls.push('trash');
            if (scenario.startsWith('trash-')) throw failure;
          },
        },
      },
    );
    if (scenario.includes('-')) {
      await assert.rejects(handlers.deleteSession('current'), (error) => error === failure);
      assert.deepEqual(state.sessions, [session]);
      assert.equal(state.selectedSessionId, 'current');
    } else if (scenario === 'cancel') {
      assert.equal(await handlers.deleteSession('current'), false);
      assert.deepEqual(calls, []);
    } else {
      assert.deepEqual(await handlers.deleteSession('current'), { trashed: scenario === 'present' });
      assert.deepEqual(
        calls,
        scenario === 'present' ? ['lstat', 'trash'] : scenario === 'missing' ? ['lstat'] : [],
      );
      assert.deepEqual(state.sessions, []);
      assert.equal(state.selectedSessionId, 'other');
    }
  });
}
