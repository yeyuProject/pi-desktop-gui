import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { DEFAULT_SIDEBAR_VIEW, parseSidebarView, sessionCreatedAtFromFile } from '../shared/sidebar-view';
import type { Session } from '../shared/types';

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidebar-view-store-'));
  const store = new Store(dir);
  t.after(async () => {
    store.stopRecovery();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await store.load();
  return { store, dir, file: (name: string) => path.join(dir, name) };
}

function memberOf(leadId: string): NonNullable<Session['team']> {
  return {
    leadId,
    dispatchId: 'dispatch',
    toolCallId: 'call',
    name: 'Member',
    role: 'reviewer',
    roleSnapshot: {
      name: 'reviewer',
      description: 'Reviews code',
      body: 'Review the change.',
      source: 'builtin',
      revision: 'a'.repeat(64),
      editable: false,
    },
    task: 'Review the change.',
    approvalMode: 'readonly',
    status: 'completed',
  };
}

test('sidebar index repairs preserve healthy data and do not move aside either index version', async (t) => {
  const f = await fixture(t);
  const lead = f.store.createSession();
  const member = f.store.createSession();
  const orphan = f.store.createSession();
  const explicitTime = f.store.createSession();
  const piFile = f.file('2025-01-02T03-04-05-123Z_test.jsonl');
  const badDate = f.file('2025-02-30T03-04-05-123Z_test.jsonl');
  const savedView = { ...DEFAULT_SIDEBAR_VIEW, sortBy: 'title', foldOlder: false };
  const section = { id: 'kept', name: ' 📁 ', createdAt: 1 };
  const data = {
    ...f.store.state,
    sessions: [
      { ...lead, sectionId: section.id, file: piFile, createdAt: undefined },
      { ...member, sectionId: section.id, team: memberOf(lead.id) },
      { ...orphan, sectionId: 'missing', createdAt: 'bad', file: badDate },
      { ...explicitTime, sectionId: 123, file: piFile, createdAt: 0 },
    ],
    sections: [
      { ...section, name: ' ' },
      section,
      { ...section, name: 'Duplicate' },
      { ...section, id: 'too-long', name: '📁'.repeat(41) },
      { ...section, id: 'second', name: '📁'.repeat(40) },
    ],
    settings: {
      ...f.store.state.settings,
      fontScale: 1.5,
      sidebarView: { sortBy: 'title', foldOlder: false, groupBy: 'foo', pinnedGroup: 1 },
    },
  };
  assert.equal(lead.createdAt, lead.updatedAt);
  for (const version of [1, 2]) {
    const original = JSON.stringify({ ...data, version });
    await fs.writeFile(f.file('state.json'), original);
    const store = new Store(f.dir);
    assert.deepEqual(await store.load(), { writable: true });
    assert.equal(await fs.readFile(f.file('state.json'), 'utf8'), original);
    assert.deepEqual(store.state.settings.sidebarView, savedView);
    assert.equal(store.state.settings.fontScale, 1.5);
    assert.deepEqual(store.state.sections, [
      { ...section, name: '📁' },
      { ...section, id: 'second', name: '📁'.repeat(40) },
    ]);
    assert.equal(store.session(lead.id).sectionId, section.id);
    assert.equal(store.session(lead.id).createdAt, Date.parse('2025-01-02T03:04:05.123Z'));
    assert.equal(store.session(member.id).sectionId, undefined);
    assert.equal(store.session(member.id).team?.leadId, lead.id);
    assert.equal(store.session(orphan.id).sectionId, undefined);
    assert.equal(store.session(orphan.id).createdAt, orphan.updatedAt);
    assert.equal(store.session(explicitTime.id).createdAt, 0);
    assert.equal(store.session(explicitTime.id).sectionId, undefined);
    await store.save();
    const disk = JSON.parse(await fs.readFile(f.file('state.json'), 'utf8'));
    assert.equal(disk.version, 2);
    assert.deepEqual(disk.settings.sidebarView, savedView);
    assert.equal(disk.sessions[0].createdAt, store.session(lead.id).createdAt);
  }
});

test('strict sidebar view requires every field and Pi timestamps are exact UTC dates', () => {
  for (const view of [
    null,
    [],
    { ...DEFAULT_SIDEBAR_VIEW, groupBy: 'foo' },
    { ...DEFAULT_SIDEBAR_VIEW, sortBy: 'foo' },
    { ...DEFAULT_SIDEBAR_VIEW, pinnedGroup: 'false' },
    { ...DEFAULT_SIDEBAR_VIEW, foldOlder: 1 },
    { ...DEFAULT_SIDEBAR_VIEW, teamMembers: undefined },
  ])
    assert.throws(() => parseSidebarView(view, true), /侧栏显示方式无效/);
  const view = { ...DEFAULT_SIDEBAR_VIEW, groupBy: 'time', foldOlder: false, extra: 'ignored' };
  assert.deepEqual(parseSidebarView(view, true), {
    ...DEFAULT_SIDEBAR_VIEW,
    groupBy: 'time',
    foldOlder: false,
  });
  const leapDay = '2024-02-29T01-02-03-004Z_example.jsonl';
  const expected = Date.parse('2024-02-29T01:02:03.004Z');
  assert.equal(sessionCreatedAtFromFile(leapDay), expected);
  assert.equal(sessionCreatedAtFromFile('C:\\history\\' + leapDay), expected);
  assert.equal(sessionCreatedAtFromFile('/history/' + leapDay), expected);
  assert.equal(sessionCreatedAtFromFile(leapDay.replace('2024', '2025')), undefined);
  assert.equal(sessionCreatedAtFromFile(leapDay.replace('T01', 'T24')), undefined);
  assert.equal(sessionCreatedAtFromFile(leapDay + '.bak'), undefined);
});

test('creating a section with a selected blank session persists both and protects the session', async (t) => {
  const f = await fixture(t);
  const session = f.store.createPlaceholder();
  assert.equal(f.store.isTransientSession(session.id), true);
  assert.equal(f.store.persistentState().selectedSessionId, undefined);
  const section = await f.store.createSection('Review', session.id);
  assert.equal(f.store.isTransientSession(session.id), false);
  const restored = new Store(f.dir);
  assert.deepEqual(await restored.load(), { writable: true });
  assert.deepEqual(restored.state.sections, [section]);
  assert.equal(restored.state.selectedSessionId, session.id);
  assert.equal(restored.session(session.id).sectionId, section.id);
  assert.equal(restored.session(session.id).createdAt, session.createdAt);

  session.lastStatus = 'waiting';
  const member = f.store.createSession();
  member.team = memberOf(session.id);
  await assert.rejects(f.store.createSection('Member only', member.id), /团队成员跟随负责人显示/);
  await assert.rejects(f.store.setSessionSection(member.id, section.id), /团队成员跟随负责人显示/);
  await f.store.setSessionSection(session.id, null);
  assert.equal(session.sectionId, undefined);
  const other = await f.store.createSection('Other');
  await f.store.setSessionSection(session.id, other.id);
  assert.equal(session.sectionId, other.id);
  assert.equal(session.lastStatus, 'waiting');
  assert.equal(session.projectId, undefined);
  assert.equal(session.cwd, undefined);
  assert.equal(session.createdAt, session.updatedAt);
  assert.deepEqual(await f.store.deleteSection(other.id), { name: 'Other', sessionCount: 1 });
  assert.equal(Object.hasOwn(session, 'sectionId'), false);
  await restored.load();
  assert.deepEqual(restored.state.sections, [section]);
  assert.equal(restored.session(session.id).sectionId, undefined);
});

test('queued section changes enforce unique names, limits and current ownership', async (t) => {
  const f = await fixture(t);
  const session = f.store.createSession();
  const [first, second] = await Promise.allSettled([
    f.store.createSection('Notes'),
    f.store.createSection('nOTEs'),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(String(second.reason), /已有同名分区/);
  const other = await f.store.createSection('Other');
  await assert.rejects(f.store.renameSection(other.id, 'NOTES'), /已有同名分区/);
  await f.store.renameSection(first.value.id, 'NOTES');
  assert.deepEqual(f.store.state.sections, [{ ...first.value, name: 'NOTES' }, other]);

  await f.store.setSessionSection(session.id, first.value.id);
  const deleting = f.store.deleteSection(first.value.id);
  const assigning = f.store.setSessionSection(session.id, first.value.id);
  const moving = f.store.commitSessionMove(
    session.id,
    { projectId: undefined, cwd: f.dir, file: undefined, attachments: [] },
    { sectionId: first.value.id },
  );
  await Promise.all([
    assert.rejects(assigning, /分区不存在/),
    assert.rejects(moving, /分区已变化/),
    deleting,
  ]);
  assert.equal(session.sectionId, undefined);
  assert.equal(session.cwd, undefined);

  await Promise.all(Array.from({ length: 19 }, (_, i) => f.store.createSection('Section ' + i)));
  await assert.rejects(f.store.createSection('Overflow'), /最多可以建 20 个分区/);
  assert.equal(f.store.state.sections?.length, 20);
});

test('project moves preserve creation time and only a drag clears the confirmed section', async (t) => {
  const f = await fixture(t);
  f.store.state.projects.push({ id: 'target', name: 'Target', path: f.dir, trusted: true, createdAt: 1 });
  const session = f.store.createSession();
  session.createdAt = 1;
  const section = await f.store.createSection('Review', session.id);
  const newFile = f.file('2025-01-02T03-04-05-123Z_target.jsonl');
  await f.store.commitSessionMove(session.id, {
    projectId: 'target',
    cwd: undefined,
    file: newFile,
    attachments: [],
  });
  assert.equal(session.sectionId, section.id);
  assert.equal(session.createdAt, 1);
  const otherFile = f.file('2025-01-02T03-04-05-124Z_chat.jsonl');
  const movePatch = { projectId: undefined, cwd: f.dir, file: otherFile, attachments: [] };
  await fs.mkdir(f.file('state.json.tmp'));
  await assert.rejects(
    f.store.commitSessionMove(session.id, movePatch, { sectionId: section.id }),
    /无法写入本地数据目录/,
  );
  assert.equal(session.projectId, 'target');
  assert.equal(session.file, newFile);
  assert.equal(session.sectionId, section.id);
  await fs.rmdir(f.file('state.json.tmp'));
  await f.store.retrySave();
  await f.store.commitSessionMove(session.id, movePatch, { sectionId: section.id });
  const restored = new Store(f.dir);
  await restored.load();
  assert.equal(restored.session(session.id).projectId, undefined);
  assert.equal(restored.session(session.id).file, otherFile);
  assert.equal(restored.session(session.id).sectionId, undefined);
  assert.equal(restored.session(session.id).createdAt, 1);
  assert.equal(restored.state.selectedProjectId, undefined);
  assert.equal(restored.state.selectedSessionId, session.id);
});

test('primary write failures keep section ownership and saved display settings through draft retry', async (t) => {
  const f = await fixture(t);
  const session = f.store.createPlaceholder();
  const section = await f.store.createSection('Review');
  const saved = { ...DEFAULT_SIDEBAR_VIEW, groupBy: 'status' } as const;
  await f.store.setSidebarView(saved);
  await fs.mkdir(f.file('state.json.tmp'));
  await assert.rejects(f.store.setSessionSection(session.id, section.id), /无法写入本地数据目录/);
  assert.equal(session.sectionId, undefined);
  assert.equal(f.store.isTransientSession(session.id), true);
  await fs.rmdir(f.file('state.json.tmp'));
  await f.store.retrySave();
  await f.store.setSessionSection(session.id, section.id);

  await fs.mkdir(f.file('state.json.tmp'));
  await assert.rejects(f.store.setSidebarView(DEFAULT_SIDEBAR_VIEW), /无法写入本地数据目录/);
  assert.deepEqual(f.store.state.settings.sidebarView, saved);
  session.draft = 'save after the disk recovers';
  await fs.rmdir(f.file('state.json.tmp'));
  await f.store.retrySave();
  const restored = new Store(f.dir);
  await restored.load();
  assert.equal(restored.session(session.id).draft, session.draft);
  assert.equal(restored.session(session.id).sectionId, section.id);
  assert.deepEqual(restored.state.settings.sidebarView, saved);
});

test('ordinary saves wait for sidebar changes and a backup error preserves the primary commit', async (t) => {
  const f = await fixture(t);
  const session = f.store.createSession();
  await f.store.save();
  const initial = { ...DEFAULT_SIDEBAR_VIEW, groupBy: 'time' } as const;
  const view = { ...initial, sortBy: 'title' } as const;
  const first = f.store.setSidebarView(initial);
  const second = f.store.setSidebarView(view);
  session.draft = 'typed while the settings requests were queued';
  const saving = f.store.save();
  await Promise.all([first, second, saving]);
  const restored = new Store(f.dir);
  await restored.load();
  assert.deepEqual(restored.state.settings.sidebarView, view);
  assert.equal(restored.session(session.id).draft, session.draft);

  await fs.utimes(f.file('state.backup-1.json'), 1, 1);
  await fs.mkdir(f.file('state.backup-1.json.tmp'));
  const section = await f.store.createSection('Review', session.id);
  assert.equal(f.store.storage.writable, true);
  assert.equal(session.sectionId, section.id);
  await restored.load();
  assert.deepEqual(restored.state.sections, [section]);
  assert.equal(restored.session(session.id).sectionId, section.id);
});
