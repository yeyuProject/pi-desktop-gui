import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-move-store-'));
  const store = new Store(dir);
  await store.load();
  store.state.projects.push({ id: 'target', name: 'Target', path: dir, trusted: true, createdAt: 1 });
  const session = store.createSession();
  session.title = 'preserved';
  session.file = path.join(dir, 'old.jsonl');
  session.draft = 'keep';
  await store.save();
  const patch = { projectId: 'target', cwd: undefined, file: path.join(dir, 'new.jsonl'), attachments: [] };
  return {
    store,
    session,
    dir,
    patch,
    close: async () => {
      store.stopRecovery();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('move persistence failure never exposes or saves the new location', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.session);
    const replace = (f.store as any).replace.bind(f.store);
    (f.store as any).replace = async (name: string, contents: string) => {
      if (name === 'state.json') throw Object.assign(new Error('injected'), { code: 'ENOSPC' });
      return replace(name, contents);
    };
    await assert.rejects(f.store.commitSessionMove(f.session.id, f.patch));
    assert.equal(JSON.stringify(f.session), before);
    const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
    assert.equal(disk.sessions.find((s: any) => s.id === f.session.id).file, f.session.file);
  } finally {
    await f.close();
  }
});

test('concurrent save waits for relocation and captures committed location', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const replace = (f.store as any).replace.bind(f.store);
    let first = true;
    (f.store as any).replace = async (name: string, contents: string) => {
      if (name === 'state.json' && first) {
        first = false;
        entered();
        await gate;
      }
      return replace(name, contents);
    };
    const moving = f.store.commitSessionMove(f.session.id, f.patch);
    await started;
    assert.equal(f.session.projectId, undefined);
    f.session.draft = 'edited meanwhile';
    const saving = f.store.save();
    release();
    await Promise.all([moving, saving]);
    const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
    const saved = disk.sessions.find((s: any) => s.id === f.session.id);
    assert.equal(saved.projectId, 'target');
    assert.equal(saved.file, f.patch.file);
    assert.equal(saved.draft, 'edited meanwhile');
  } finally {
    await f.close();
  }
});

test('backup failure after primary commit does not roll back relocation', async () => {
  const f = await fixture();
  try {
    (f.store as any).backup = async () => {
      throw new Error('injected backup failure');
    };
    await f.store.commitSessionMove(f.session.id, f.patch);
    assert.equal(f.session.projectId, 'target');
    assert.equal(f.session.file, f.patch.file);
    const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'));
    assert.equal(disk.sessions.find((s: any) => s.id === f.session.id).file, f.patch.file);
  } finally {
    await f.close();
  }
});
