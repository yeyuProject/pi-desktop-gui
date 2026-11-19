import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseState } from '../electron/store-state';
import { DEFAULT_SIDEBAR_VIEW } from '../shared/sidebar-view';
import type { TeamLink } from '../shared/team';
import type { Session, SidebarView } from '../shared/types';
import { buildSidebarGroups, getSidebarRowActivity, type SidebarRow } from '../src/lib/sidebar-groups';

const DAY = 86_400_000;
const now = new Date(2026, 3, 1).getTime();
const view = (settings: Partial<SidebarView>) => ({ ...DEFAULT_SIDEBAR_VIEW, ...settings });
const ids = (rows: readonly SidebarRow[]) => rows.map((row) => row.sessionId);
const session = (id: string, fields: Partial<Session> = {}): Session => ({
  id,
  title: id,
  updatedAt: now,
  draft: '',
  attachments: [],
  lastStatus: 'idle',
  ...fields,
});
const teamLink = (leadId: string): TeamLink => ({
  leadId,
  dispatchId: 'dispatch',
  toolCallId: 'tool-call',
  name: 'Member',
  role: 'writer',
  roleSnapshot: {
    name: 'writer',
    description: 'Write',
    body: 'Write the draft',
    source: 'user',
    revision: 'f'.repeat(64),
    editable: true,
  },
  task: 'Draft',
  approvalMode: 'confirm',
  status: 'completed',
});

test('default project groups keep pinned rows and the seven-day cutoff from the original sidebar', () => {
  const sessions = [
    session('project-old', { projectId: 'p1', updatedAt: now - 8 * DAY }),
    session('latest', { updatedAt: now + 1 }),
    session('first-tie'),
    session('second-tie'),
    session('exactly-seven-days', { updatedAt: now - 7 * DAY }),
    session('just-older', { updatedAt: now - 7 * DAY - 1 }),
    session('old-but-pinned', { pinned: true, updatedAt: now - 30 * DAY }),
  ];
  const { pinned, groups } = buildSidebarGroups(sessions, {}, undefined, undefined, now);
  assert.equal(pinned, undefined);
  assert.deepEqual(
    groups.map((group) => group.key),
    ['project:standalone', 'project:p1'],
  );
  assert.deepEqual(ids(groups[0].rows), [
    'old-but-pinned',
    'latest',
    'first-tie',
    'second-tie',
    'exactly-seven-days',
  ]);
  assert.deepEqual(ids(groups[0].olderRows), ['just-older']);
  assert.equal(groups[1].projectId, 'p1');
  assert.deepEqual(ids(groups[1].olderRows), ['project-old']);
  const unfolded = buildSidebarGroups(sessions, {}, view({ groupBy: 'none', foldOlder: false }), [], now);
  assert.equal(unfolded.groups[0].rows.length, sessions.length);
  assert.deepEqual(unfolded.groups[0].olderRows, []);
});

test('time groups use local midnight across months and the selected sort field', () => {
  const sessions = [0, 1, 2, 6, 7, 29, 30].map((age) =>
    session(`day-${age}`, {
      title: age === 2 ? 'Zulu' : age === 6 ? 'Alpha' : `day-${age}`,
      updatedAt: age ? new Date(2026, 3, 1 - age, 23, 59).getTime() : now,
      createdAt: now - 60 * DAY,
    }),
  );
  const time = view({ groupBy: 'time' });
  const { groups } = buildSidebarGroups(sessions, {}, time, [], now);
  assert.deepEqual(
    groups.map((group) => [group.key, ids(group.rows), ids(group.olderRows)]),
    [
      ['time:today', ['day-0'], []],
      ['time:yesterday', ['day-1'], []],
      ['time:week', ['day-2', 'day-6'], []],
      ['time:month', ['day-7', 'day-29'], []],
      ['time:older', ['day-30'], []],
    ],
  );
  const byTitle = buildSidebarGroups(sessions, {}, { ...time, sortBy: 'title' }, [], now);
  assert.deepEqual(
    byTitle.groups.map((group) => group.key),
    groups.map((group) => group.key),
  );
  assert.deepEqual(ids(byTitle.groups[2].rows), ['day-6', 'day-2']);
  const byCreation = buildSidebarGroups(sessions, {}, { ...time, sortBy: 'created' }, [], now);
  assert.deepEqual(
    byCreation.groups.map((group) => group.key),
    ['time:older'],
  );
  assert.deepEqual(
    ids(byCreation.groups[0].rows),
    sessions.map((s) => s.id),
  );
  const nextMidnight = buildSidebarGroups([sessions[0]], {}, time, [], new Date(2026, 3, 2).getTime());
  assert.deepEqual(
    nextMidnight.groups.map((group) => group.key),
    ['time:yesterday'],
  );
});

test('a 23-hour local day still advances the time bucket at midnight', (t) => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (tz === undefined) delete process.env.TZ;
    if (tz !== undefined) process.env.TZ = tz;
  });
  const springForward = new Date(2026, 2, 8).getTime();
  const midnight = new Date(2026, 2, 9).getTime();
  assert.equal(midnight - springForward, 23 * 60 * 60 * 1000);
  const { groups } = buildSidebarGroups(
    [session('dst', { updatedAt: springForward })],
    {},
    view({ groupBy: 'time' }),
    [],
    midnight,
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    ['time:yesterday'],
  );
});

test('status priority and live badges include members in dispatch order even when their rows are hidden', () => {
  const sessions = [
    session('second', { team: teamLink('lead'), pinned: true }),
    session('first', { team: teamLink('lead'), lastStatus: 'running' }),
    session('lead', { unread: true }),
    session('failed', { unread: true, lastStatus: 'error', updatedAt: now - 8 * DAY }),
    session('running', { unread: true, lastStatus: 'running' }),
    session('unread', { unread: true }),
    session('orphan', { team: teamLink('removed') }),
    session('older-other', { updatedAt: now - 8 * DAY }),
  ];
  const status = view({ groupBy: 'status', pinnedGroup: true, teamMembers: false });
  const activities = {
    lead: { status: 'idle', pending: 1 },
    first: { status: 'idle', pending: 1 },
    second: { status: 'running', pending: 2 },
    failed: { status: 'running', pending: 0 },
  } as const;
  const { pinned, groups } = buildSidebarGroups(sessions, activities, status, [], now);
  assert.equal(pinned, undefined);
  assert.deepEqual(
    groups.map((group) => [group.key, ids(group.rows), ids(group.olderRows)]),
    [
      ['status:pending', ['lead', 'failed'], []],
      ['status:running', ['running'], []],
      ['status:unread', ['unread'], []],
      ['status:other', ['orphan'], ['older-other']],
    ],
  );
  const lead = groups[0].rows[0];
  assert.deepEqual(
    lead.members.map((member) => member.id),
    ['first', 'second'],
  );
  assert.deepEqual(getSidebarRowActivity(lead, activities), {
    status: 'idle',
    pending: 4,
    activeMembers: 1,
    running: true,
  });
  const releasable = { second: { status: 'running', pending: 0 } } as const;
  const next = buildSidebarGroups(sessions, releasable, status, [], now);
  assert.deepEqual(ids(next.groups[1].rows), ['lead', 'running']);
});

test('status deferral retains the selected row when the old status group would disappear', () => {
  const status = view({ groupBy: 'status' });
  for (const [lastStatus, groupKey] of [
    ['completed', 'status:unread'],
    ['interrupted', 'status:pending'],
  ] as const) {
    const unread = session('selected', { lastStatus, unread: true, updatedAt: now - 8 * DAY });
    assert.equal(buildSidebarGroups([unread], {}, status, [], now).groups[0].key, groupKey);
    const seen = { ...unread, unread: false };
    const kept = buildSidebarGroups([seen], {}, status, [], now, { sessionId: seen.id, groupKey });
    assert.equal(kept.groups[0].key, groupKey);
    assert.equal(kept.groups[0].rows[0].session.unread, false);
    const released = buildSidebarGroups([seen], {}, status, [], now);
    assert.equal(released.groups[0].key, 'status:other');
    assert.deepEqual(ids(released.groups[0].olderRows), [seen.id]);
  }
  const deferral = { sessionId: 'selected', groupKey: 'status:unread' };
  const activities = { selected: { status: 'waiting', pending: 1 } } as const;
  const { groups } = buildSidebarGroups([session('selected')], activities, status, [], now, deferral);
  assert.equal(groups[0].key, 'status:pending');
});

test('pinning above a section keeps its count without duplicating the row', () => {
  const sections = [
    { id: 'notes', name: '笔记', createdAt: 100 },
    { id: 'empty', name: '空分区', createdAt: 200 },
  ];
  const assigned = session('assigned', {
    pinned: true,
    sectionId: 'notes',
    projectId: 'one',
    updatedAt: now - 9 * DAY,
  });
  const sessions = [
    assigned,
    session('project-pin', { pinned: true, projectId: 'two' }),
    session('standalone-pin', { pinned: true }),
    session('regular'),
  ];
  const separate = buildSidebarGroups(sessions, {}, view({ pinnedGroup: true }), sections, now);
  assert.deepEqual(ids(separate.pinned!.rows), ['project-pin', 'standalone-pin', 'assigned']);
  assert.deepEqual(
    separate.sections.map((group) => [group.key, group.pinnedCount, ids(group.rows)]),
    [
      ['section:notes', 1, []],
      ['section:empty', 0, []],
    ],
  );
  assert.deepEqual(
    separate.groups.flatMap((group) => ids(group.rows)),
    ['regular'],
  );
  assert.equal(assigned.sectionId, 'notes');

  const older = session('older', { sectionId: 'notes', updatedAt: now - 8 * DAY });
  const together = buildSidebarGroups([...sessions, older], {}, undefined, sections, now);
  assert.equal(together.sections[0].pinnedCount, 0);
  assert.deepEqual(ids(together.sections[0].rows), ['assigned', 'older']);
  assert.deepEqual(together.sections[0].olderRows, []);
  const unpinned = buildSidebarGroups(
    [{ ...assigned, pinned: false }],
    {},
    view({ pinnedGroup: true }),
    sections,
    now,
  );
  assert.deepEqual(ids(unpinned.sections[0].rows), ['assigned']);
  assert.equal(unpinned.pinned, undefined);
});

test('title sorting follows the PRD character order, numeric order and updated-at tiebreaker', () => {
  const sessions = [
    session('ten', { title: '任务 10' }),
    session('b', { title: 'b' }),
    session('ali', { title: '阿里' }),
    session('old-a', { title: 'A' }),
    session('two', { title: '任务 2' }),
    session('number', { title: '1 号' }),
    session('new-a', { title: 'a', updatedAt: now + 1 }),
    session('symbol', { title: '  !' }),
  ];
  const { groups } = buildSidebarGroups(sessions, {}, view({ sortBy: 'title' }), [], now);
  assert.deepEqual(ids(groups[0].rows), ['symbol', 'number', 'new-a', 'old-a', 'b', 'ali', 'two', 'ten']);
});

test('legacy state repairs display fields and uses the filename creation time for sorting', () => {
  const valid = { id: 'work', name: ' 工作 ', createdAt: 1 };
  const { state, discardedSessions, repairedSettings } = parseState({
    version: 1,
    projects: [],
    sections: [valid, { ...valid, name: '重复' }, { id: 'invalid', name: ' ', createdAt: 2 }],
    settings: { sidebarView: { groupBy: 'foo', sortBy: 'created', pinnedGroup: 'yes', foldOlder: false } },
    sessions: [
      session('legacy', { file: path.resolve('2024-02-29T12-01-02-003Z_legacy.jsonl') }),
      session('fallback', { file: path.resolve('2024-02-30T12-01-02-003Z_bad.jsonl'), sectionId: 'missing' }),
      session('moved', {
        createdAt: Date.parse('2025-01-01T00:00:00Z'),
        file: path.resolve('2026-01-01T00-00-00-000Z_moved.jsonl'),
      }),
      session('assigned', { sectionId: 'work' }),
      session('member', { sectionId: 'work', team: teamLink('moved') }),
    ],
  });
  assert.equal(discardedSessions, 0);
  assert.equal(repairedSettings, 0);
  assert.deepEqual(state.sections, [{ ...valid, name: '工作' }]);
  assert.deepEqual(state.settings.sidebarView, view({ sortBy: 'created', foldOlder: false }));
  assert.deepEqual(
    state.sessions.map((s) => s.sectionId),
    [undefined, undefined, undefined, 'work', undefined],
  );
  assert.deepEqual(
    state.sessions.slice(0, 3).map((s) => s.createdAt),
    [Date.parse('2024-02-29T12:01:02.003Z'), now, Date.parse('2025-01-01T00:00:00Z')],
  );
  const { groups, sections } = buildSidebarGroups(
    state.sessions,
    {},
    state.settings.sidebarView,
    state.sections,
    now,
  );
  assert.deepEqual(ids(groups[0].rows), ['fallback', 'moved', 'legacy']);
  assert.deepEqual(ids(sections[0].rows), ['assigned']);
});
