import path from 'node:path';
import { THEMES } from '../shared/window-theme';
import { busy, type AppState, type Project, type Session, type Settings } from '../shared/types';

export const defaultSettings: Settings = {
  piPath: '',
  nodePath: '',
  agentDir: '',
  editorPath: '',
  provider: '',
  modelId: '',
  thinking: '',
  theme: 'system',
  fontScale: 1,
  sidebarWidth: 240,
  inspectorWidth: 380,
  inspectorSplit: 40,
  onboardingDone: false,
  notifyOnFinish: true,
  autoDownloadUpdates: true,
};
export const emptyState = (): AppState => ({
  version: 1,
  projects: [],
  sessions: [],
  settings: { ...defaultSettings },
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

/** Validate the desktop index, not Pi's JSONL history. Bad rows never invalidate healthy rows. */
export function parseState(value: unknown) {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.sessions)
  )
    throw new Error('本地索引格式不受支持');
  const state = emptyState();
  if (typeof value.appVersion === 'string') state.appVersion = value.appVersion;
  let discardedProjects = 0,
    discardedSessions = 0,
    repairedSettings = 0;
  const projectIds = new Set<string>(),
    sessionIds = new Set<string>();
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
    state.projects.push(row as unknown as Project);
  }
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
      (row.draft !== undefined && typeof row.draft !== 'string') ||
      (row.attachments !== undefined && !strings(row.attachments)) ||
      !optionalPath(row.file) ||
      !optionalPath(row.cwd) ||
      (row.expandedTools !== undefined && !strings(row.expandedTools)) ||
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
      draft: row.draft ?? '',
      attachments: row.attachments ?? [],
    } as unknown as Session;
    if (busy(session.lastStatus)) session.lastStatus = 'interrupted';
    state.sessions.push(session);
  }
  const settings = object(value.settings) ? value.settings : {};
  if (value.settings !== undefined && !object(value.settings)) repairedSettings++;
  for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    if (!(key in settings)) continue;
    const candidate = settings[key];
    const valid =
      key === 'theme'
        ? (THEMES as readonly unknown[]).includes(candidate)
        : typeof defaultSettings[key] === 'number'
          ? typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
          : typeof candidate === typeof defaultSettings[key];
    if (valid) Object.assign(state.settings, { [key]: candidate });
    else repairedSettings++;
  }
  if (typeof value.selectedSessionId === 'string' && sessionIds.has(value.selectedSessionId)) {
    state.selectedSessionId = value.selectedSessionId;
    state.selectedProjectId = state.sessions.find((s) => s.id === value.selectedSessionId)?.projectId;
  } else if (typeof value.selectedProjectId === 'string' && projectIds.has(value.selectedProjectId)) {
    state.selectedProjectId = value.selectedProjectId;
  }
  return { state, discardedProjects, discardedSessions, repairedSettings };
}
