import { DEFAULT_TEAM_SETTINGS, isTeamLink, isTeamSettings, teamMemberActive } from '../shared/team';
import { readGoalDraft } from '../shared/goal-input';
import path from 'node:path';
import { THEMES, UI_STYLES, styleTheme } from '../shared/window-theme';
import { isMaterial } from '../shared/material';
import { busy, type AppState, type Project, type Session, type Settings } from '../shared/types';
import { isDraftQuote } from '../shared/message-content';
import { parseSidebarView, sessionCreatedAtFromFile, sidebarSectionName } from '../shared/sidebar-view';

export const defaultSettings: Settings = {
  team: DEFAULT_TEAM_SETTINGS,
  piPath: '',
  nodePath: '',
  agentDir: '',
  editorPath: '',
  provider: '',
  modelId: '',
  thinking: '',
  theme: 'system',
  uiStyle: 'classic',
  material: 'solid',
  solidOnBattery: true,
  expandThinking: false,
  fontScale: 1,
  sidebarWidth: 240,
  inspectorWidth: 380,
  sideChatWidth: 360,
  inspectorSplit: 40,
  onboardingDone: false,
  notifyOnFinish: true,
  autoDownloadUpdates: false,
  updateProxy: '',
  updateMirror: '',
  notifyOnApproval: true,
  notifyOnError: true,
  lacunaTerms: true,
};
export const emptyState = (): AppState => ({
  version: 1,
  projects: [],
  sessions: [],
  settings: { ...defaultSettings, team: { ...DEFAULT_TEAM_SETTINGS } },
});
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const optionalPath = (value: unknown) =>
  value === undefined || (typeof value === 'string' && path.isAbsolute(value));
const statuses = new Set([
  'idle',
  'starting',
  'running',
  'waiting',
  'retrying',
  'compacting',
  'stopping',
  'completed',
  'stopped',
  'error',
  'interrupted',
]);

/**
 * 1. 读取项目和分区，略过无效或重复的记录。
 * 2. 读取会话并补齐创建时间，移除无效的分区归属。
 * 3. 补齐设置并恢复选中位置，只有原索引字段损坏才报告恢复。
 */
export function parseState(value: unknown) {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.sessions)
  )
    throw new Error('本地数据格式不受支持，请检查应用版本或从备份恢复。');
  const state = emptyState();
  if (typeof value.appVersion === 'string') state.appVersion = value.appVersion;
  const update = value.piUpdate;
  if (
    object(update) &&
    (update.status === 'available' || update.status === 'current' || update.status === 'error')
  ) {
    state.piUpdate = {
      status: update.status,
      current: typeof update.current === 'string' ? update.current : undefined,
      latest: typeof update.latest === 'string' ? update.latest : undefined,
      packageName: typeof update.packageName === 'string' ? update.packageName : undefined,
      note: typeof update.note === 'string' ? update.note : undefined,
      checkedAt: timestamp(update.checkedAt) ? update.checkedAt : undefined,
      error: typeof update.error === 'string' ? update.error : undefined,
      seenVersion: typeof update.seenVersion === 'string' ? update.seenVersion : undefined,
    };
  }
  let discardedProjects = 0,
    discardedSessions = 0,
    repairedSettings = 0;
  const projectIds = new Set<string>(),
    sessionIds = new Set<string>();
  // 1. 先保留有效的分区 ID，会话才能按这些 ID 恢复归属。
  const sectionIds = new Set<string>();
  if (Array.isArray(value.sections)) {
    state.sections = [];
    for (const row of value.sections) {
      if (!object(row) || !id(row.id) || sectionIds.has(row.id) || !timestamp(row.createdAt)) continue;
      const name = sidebarSectionName(row.name);
      if (!name) continue;
      sectionIds.add(row.id);
      state.sections.push({ id: row.id, name, createdAt: row.createdAt });
    }
  }
  for (const row of value.projects) {
    if (
      !object(row) ||
      !id(row.id) ||
      projectIds.has(row.id) ||
      typeof row.name !== 'string' ||
      typeof row.path !== 'string' ||
      !path.isAbsolute(row.path) ||
      typeof row.trusted !== 'boolean' ||
      !timestamp(row.createdAt)
    ) {
      discardedProjects++;
      continue;
    }
    projectIds.add(row.id);
    const project = { ...row } as unknown as Project;
    if (
      project.teamRoleApprovals &&
      (!object(project.teamRoleApprovals) ||
        !Object.values(project.teamRoleApprovals).every(
          (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
        ))
    )
      delete project.teamRoleApprovals;
    state.projects.push(project);
  }
  // 2. 旧会话从 Pi 文件名补创建时间，移动生成的新文件不会覆盖已保存的时间。
  for (const row of value.sessions) {
    if (
      !object(row) ||
      !id(row.id) ||
      sessionIds.has(row.id) ||
      typeof row.title !== 'string' ||
      !timestamp(row.updatedAt) ||
      typeof row.lastStatus !== 'string' ||
      !statuses.has(row.lastStatus) ||
      (row.projectId !== undefined &&
        (typeof row.projectId !== 'string' || !projectIds.has(row.projectId))) ||
      (row.teamEnabled !== undefined && typeof row.teamEnabled !== 'boolean') ||
      (row.teamHintSeen !== undefined && typeof row.teamHintSeen !== 'boolean') ||
      (row.team !== undefined && (!isTeamLink(row.team) || row.team.leadId === row.id)) ||
      (row.draft !== undefined && typeof row.draft !== 'string') ||
      (row.attachments !== undefined && !strings(row.attachments)) ||
      !optionalPath(row.file) ||
      !optionalPath(row.cwd) ||
      (row.expandedTools !== undefined && !strings(row.expandedTools)) ||
      (row.draftQuotes !== undefined &&
        (!Array.isArray(row.draftQuotes) || !row.draftQuotes.every(isDraftQuote))) ||
      (row.sideUsage !== undefined &&
        (!object(row.sideUsage) ||
          !timestamp(row.sideUsage.tokens) ||
          !timestamp(row.sideUsage.cost) ||
          !timestamp(row.sideUsage.updatedAt))) ||
      (row.draftSnippets !== undefined &&
        (!Array.isArray(row.draftSnippets) ||
          row.draftSnippets.some(
            (snippet) =>
              !object(snippet) ||
              typeof snippet.id !== 'string' ||
              typeof snippet.text !== 'string' ||
              !Number.isSafeInteger(snippet.offset) ||
              Number(snippet.offset) < 0 ||
              Number(snippet.offset) > String(row.draft ?? '').length,
          ))) ||
      (row.stats !== undefined &&
        (!object(row.stats) ||
          (row.stats.tokens !== undefined && !timestamp(row.stats.tokens)) ||
          (row.stats.cost !== undefined && !timestamp(row.stats.cost)))) ||
      (row.scrollTop !== undefined && !timestamp(row.scrollTop)) ||
      (row.model !== undefined &&
        (!object(row.model) || typeof row.model.id !== 'string' || typeof row.model.provider !== 'string')) ||
      (row.images !== undefined &&
        (!Array.isArray(row.images) ||
          row.images.some(
            (image) =>
              !object(image) ||
              typeof image.id !== 'string' ||
              typeof image.name !== 'string' ||
              (typeof image.data !== 'string' &&
                !(typeof image.file === 'string' && /^[a-f0-9]{64}\.bin$/.test(image.file))) ||
              typeof image.mimeType !== 'string',
          ))) ||
      (row.approvalMode !== undefined && !['auto', 'confirm', 'readonly'].includes(String(row.approvalMode)))
    ) {
      discardedSessions++;
      continue;
    }
    sessionIds.add(row.id);
    const session = {
      ...row,
      draftGoal: readGoalDraft(row.draftGoal),
      draft: row.draft ?? '',
      attachments: row.attachments ?? [],
    } as unknown as Session;
    session.createdAt = timestamp(row.createdAt)
      ? row.createdAt
      : (sessionCreatedAtFromFile(session.file) ?? session.updatedAt);
    if (session.team || typeof row.sectionId !== 'string' || !sectionIds.has(row.sectionId))
      delete session.sectionId;
    if (busy(session.lastStatus)) session.lastStatus = 'interrupted';
    if (session.team) {
      session.teamEnabled = false;
      session.unread = false;
      if (teamMemberActive(session.team.status)) session.team = { ...session.team, status: 'interrupted' };
    }
    state.sessions.push(session);
  }
  // 3. 显示字段能在内存修正，旧索引继续留在原处，等下一次正常保存。
  const settings = object(value.settings) ? value.settings : {};
  if ('sidebarView' in settings) state.settings.sidebarView = parseSidebarView(settings.sidebarView);
  // Preserve the previous master-switch preference when splitting notification categories.
  if (settings.notifyOnFinish === false) {
    if (!('notifyOnApproval' in settings)) state.settings.notifyOnApproval = false;
    if (!('notifyOnError' in settings)) state.settings.notifyOnError = false;
  }
  if (value.settings !== undefined && !object(value.settings)) repairedSettings++;
  for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    if (!(key in settings)) continue;
    const candidate = settings[key];
    const valid =
      key === 'team'
        ? isTeamSettings(candidate)
        : key === 'theme'
          ? (THEMES as readonly unknown[]).includes(candidate)
          : key === 'uiStyle'
            ? (UI_STYLES as readonly unknown[]).includes(candidate)
            : key === 'material'
              ? isMaterial(candidate)
              : typeof defaultSettings[key] === 'number'
                ? typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
                : typeof candidate === typeof defaultSettings[key];
    if (valid) Object.assign(state.settings, { [key]: candidate });
    else repairedSettings++;
  }
  const theme = styleTheme(state.settings.theme, state.settings.uiStyle);
  if (theme !== state.settings.theme) {
    state.settings.theme = theme;
    repairedSettings++;
  }
  if (typeof value.selectedSessionId === 'string' && sessionIds.has(value.selectedSessionId)) {
    state.selectedSessionId = value.selectedSessionId;
    state.selectedProjectId = state.sessions.find((s) => s.id === value.selectedSessionId)?.projectId;
  } else if (typeof value.selectedProjectId === 'string' && projectIds.has(value.selectedProjectId)) {
    state.selectedProjectId = value.selectedProjectId;
  }
  return { state, discardedProjects, discardedSessions, repairedSettings };
}
