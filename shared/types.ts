import type { AppDialog, AppMenuId } from './app-dialogs';
import type { ApprovalMode, ApprovalRequest, ApprovalGrant } from './approval';
import type { AttachmentInfo } from './attachments';
import type { CheckpointSummary, CheckpointPreview } from './checkpoints';
import type { AgentRulesFile } from './workspace';
import type { Theme } from './window-theme';
import type { PromptTemplateInput, PromptTemplateDocument } from './prompts';
import type { LocalUsageSummary } from './usage';
import type { PiCompatibility } from './pi-version';
import type { UpdateState } from './app-update';
import type { ModelErrorKind } from './errors';
import type { DraftSnippet } from './draft';
import type { NestedToolCalls } from '@earendil-works/pi-ai';
export type { DraftSnippet } from './draft';
export type { ApprovalMode, ApprovalRequest } from './approval';
export type RunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'retrying'
  | 'compacting'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'interrupted';
export type SendMode = 'steer' | 'followUp';
export interface Project {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
  createdAt: number;
}
export interface Session {
  id: string;
  projectId?: string;
  title: string;
  file?: string;
  draft: string;
  attachments: string[];
  images?: ImageAttachment[];
  draftSnippets?: DraftSnippet[];
  stats?: { tokens?: number; cost?: number };
  cwd?: string;
  updatedAt: number;
  lastStatus: RunStatus;
  scrollTop?: number;
  expandedTools?: string[];
  unread?: boolean;
  pinned?: boolean;
  model?: { provider: string; id: string };
  thinking?: string;
  approvalMode?: ApprovalMode;
}
export interface Settings {
  piPath: string;
  nodePath: string;
  agentDir: string;
  editorPath: string;
  provider: string;
  modelId: string;
  thinking: string;
  theme: Theme;
  fontScale: number;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorSplit: number;
  onboardingDone: boolean;
  notifyOnFinish: boolean;
  autoDownloadUpdates: boolean;
}
export interface AppState {
  version: 1;
  appVersion?: string;
  projects: Project[];
  sessions: Session[];
  settings: Settings;
  selectedProjectId?: string;
  selectedSessionId?: string;
}
export interface StateSnapshot {
  state: AppState;
  revision: number;
}
export interface IndexRecovery {
  corruptFile?: string;
  recoveredFrom?: string;
  backupAt?: number;
  discardedProjects: number;
  discardedSessions: number;
  repairedSettings: number;
  restarted: boolean;
}
export interface StorageStatus {
  writable: boolean;
  problem?: string;
  recovery?: IndexRecovery;
  newerFormat?: { version: number; appVersion?: string };
}
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface Message {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  nestedCalls?: NestedToolCalls;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
}
export interface ToolActivity {
  id: string;
  parentToolCallId?: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  output: string;
  startedAt: number;
  durationMs?: number;
  patch?: string;
}
export interface ExtensionDialog {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  /** Present when the dialog is a tool approval request from the desktop bridge. */
  approval?: ApprovalRequest;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  expiresAt?: number;
}
export interface Model {
  id: string;
  provider: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  input?: string[];
}
export interface ImageAttachment {
  id: string;
  name: string;
  data: string;
  mimeType: string;
}
export interface PiCommand {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: { path: string; scope?: string };
  argumentHint?: string;
}
export interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  text: string;
  label?: string;
  depth: number;
  active: boolean;
}
export type ConfigKind = 'settings' | 'models' | 'mcp';
export interface ConfigDocument {
  text: string;
  revision: string;
  path: string;
}
/** Returned only after the configuration file has been persisted successfully. */
export interface ConfigSaveResult {
  applied: boolean;
  deferred?: boolean;
  warning?: string;
}
export interface ResourceItem {
  path: string;
  enabled: boolean;
  kind: 'extensions' | 'skills' | 'prompts' | 'themes';
  name?: string;
  description?: string;
  argumentHint?: string;
  promptEditable?: boolean;
  metadata: { source: string; scope: string; origin: string; baseDir?: string };
}
export interface ResourceCatalog {
  resources: ResourceItem[];
  packages: { source: string; scope: string; installedPath?: string }[];
  tools: { name: string; description: string }[];
  activeTools: string[];
}
export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  authSource?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command';
  oauth: boolean;
  apiKey: boolean;
}
export interface Runtime {
  sessionId?: string;
  status: RunStatus;
  messages: Message[];
  tools: ToolActivity[];
  steering: string[];
  followUp: string[];
  dialogs: ExtensionDialog[];
  notices: string[];
  widgets: Record<string, string[]>;
  statuses: Record<string, string>;
  models: Model[];
  modelsLoaded: boolean;
  modelsLoading: boolean;
  thinkingLevels: string[];
  model?: Model;
  thinking?: string;
  /** Saved selection for the next user task; the active task keeps model/thinking above. */
  nextTask?: { model: Model; thinking: string; thinkingLevels: string[] };
  configurationPending?: boolean;
  error?: string;
  errorKind?: ModelErrorKind;
  errorCount?: number;
  startedAt?: number;
  connected: boolean;
  stats?: {
    /** Cumulative usage across the full Pi session, including compacted history. */
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
    contextPercent?: number;
    contextTokens?: number;
    contextWindow?: number;
  };
  notifications?: RuntimeNotification[];
  retry?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    startedAt: number;
    phase: 'delay' | 'requesting';
    requestedAt?: number;
    error?: string;
  };
  diagnostic: string[];
  stopStartedAt?: number;
  commands: PiCommand[];
  cwd?: string;
  title?: string;
  auth?: { message: string; url?: string; code?: string };
  widgetPlacements?: Record<string, string>;
  autoCompaction?: boolean;
  autoRetry?: boolean;
  approvalMode?: ApprovalMode;
  approvalGrants?: ApprovalGrant[];
  steeringMode?: string;
  followUpMode?: string;
  crash?: {
    cleanup: 'checking' | 'confirmed' | 'unconfirmed';
    code: number | null;
    signal: string | null;
    lastTool?: { name: string; target: string; seconds: number };
    log: string[];
    at: number;
    repeated: boolean;
  };
}
export interface RuntimeNotification {
  id: number;
  text: string;
  level: 'info' | 'warning' | 'error';
}
export interface PiSessionInfo {
  file: string;
  name?: string;
  cwd: string;
  preview: string;
  updatedAt: number;
}
export interface SessionMatch {
  sessionId: string;
  snippet: string;
}
export type MessageAction = 'edit' | 'regenerate' | 'fork';
export interface Environment {
  piPath: string;
  version?: string;
  supported: boolean;
  compatibility: PiCompatibility;
  nodePath?: string;
  git?: string;
  bash?: string;
  agentDir: string;
  authExists: boolean;
  modelsExist: boolean;
  errors: string[];
}
export interface FileItem {
  path: string;
  name: string;
  directory: boolean;
  size?: number;
}
export interface FilePreview {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}
export interface Change {
  path: string;
  oldPath?: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  existedBeforeRun: boolean;
}
export interface Changes {
  git: boolean;
  branch?: string;
  head?: string;
  files: Change[];
  baselineAvailable: boolean;
  baselineInvalid?: boolean;
  omitted: string[];
  error?: string;
}
export interface FileDiff {
  path: string;
  patch: string;
  before: string;
  after: string;
  unavailable?: string;
}
/**
 * Incremental runtime update. Only changed fields are sent; `messages` and `tools` replace the
 * receiver's arrays from `messagesFrom` / `toolsFrom` onwards (a full resync uses 0).
 */
export type RuntimePatch = Partial<Omit<Runtime, 'messages' | 'tools'>> & {
  removed?: (keyof Runtime)[];
  messagesFrom: number;
  messages: Message[];
  messageCount: number;
  toolsFrom: number;
  tools: ToolActivity[];
  toolCount: number;
};
export type AppEvent =
  | { type: 'action'; action: import('./workbench-actions').WorkbenchAction }
  | { type: 'appDialog'; dialog: AppDialog }
  | { type: 'appDialogsCancelled' }
  | { type: 'workspaceChanged'; projectId: string; changedPaths?: string[] }
  | ({ type: 'state' } & StateSnapshot)
  | { type: 'storage'; storage: StorageStatus }
  | { type: 'update'; update: UpdateState }
  | { type: 'runtime'; runtime: Runtime }
  | { type: 'runtimeRemoved'; sessionId: string }
  | { type: 'runtimePatch'; patch: RuntimePatch };
/** Apply a patch; arrays before the change point keep their identity so the UI can skip them. */
export function applyRuntimePatch(previous: Runtime, patch: RuntimePatch): Runtime {
  const { messagesFrom, messages, messageCount, toolsFrom, tools, toolCount, removed, ...rest } = patch;
  const sameSession = previous.sessionId === patch.sessionId;
  const applyItems = <T>(before: T[], from: number, changed: T[], count: number) => {
    if (sameSession && from === before.length && changed.length === 0 && count === before.length)
      return before;
    return (sameSession ? before.slice(0, from) : []).concat(changed).slice(0, count);
  };
  const next: Runtime = {
    ...(sameSession ? previous : emptyRuntime()),
    ...rest,
    messages: applyItems(previous.messages, messagesFrom, messages, messageCount),
    tools: applyItems(previous.tools, toolsFrom, tools, toolCount),
  };
  for (const key of removed ?? []) delete (next as unknown as Record<string, unknown>)[key];
  return next;
}
export interface Bootstrap extends StateSnapshot {
  runtime: Runtime;
  environment: Environment;
  dataDir: string;
  storage: StorageStatus;
  update: UpdateState;
}
export interface ApiMap {
  appDialogsReady: { args: []; result: void };
  respondAppDialog: { args: [id: string, response: number]; result: void };
  showAppMenu: { args: [id: AppMenuId, x: number, y: number]; result: void };
  bootstrap: { args: []; result: Bootstrap };
  navigationState: { args: []; result: StateSnapshot };
  checkUpdate: { args: []; result: void };
  downloadUpdate: { args: []; result: void };
  installUpdate: { args: []; result: void };
  addProject: { args: []; result: Project | null };
  renameProject: { args: [string, string]; result: void };
  removeProject: { args: [string]; result: void };
  trustProject: { args: [string]; result: void };
  newSession: { args: [projectId?: string]; result: Session };
  importSession: { args: [projectId?: string]; result: Session | null };
  selectSession: { args: [string]; result: void };
  renameSession: { args: [string, string]; result: void };
  deleteSession: { args: [string]; result: false | { trashed: boolean } };
  pinSession: { args: [string, boolean]; result: void };
  searchSessions: { args: [string]; result: SessionMatch[] };
  piSessions: { args: []; result: PiSessionInfo[] };
  openPiSession: { args: [string]; result: Session };
  setSessionModel: { args: [string, string, string]; result: void };
  setSessionThinking: { args: [string, string]; result: void };
  messageAction: { args: [string, MessageAction, 'user' | 'assistant', number]; result: void };
  abortRetry: { args: [sessionId: string]; result: void };
  setApprovalMode: { args: [string, ApprovalMode]; result: void };
  revokeApproval: { args: [string, string?]; result: void };
  checkpoints: { args: [string]; result: CheckpointSummary[] };
  checkpointPreview: { args: [string, string]; result: CheckpointPreview };
  revertCheckpoint: { args: [string, string, string[], string]; result: string[] };
  revertChanges: {
    args: [string, string[] | null, { sessionId: string; checkpointId?: string }?];
    result: string[];
  };
  setEntryLabel: { args: [string, string, string]; result: void };
  saveDraft: { args: [string, string, string[], ImageAttachment[]?, DraftSnippet[]?]; result: void };
  consumeDraft: { args: [string, string]; result: void };
  saveView: { args: [string, number, string[]]; result: void };
  readHistory: { args: [string]; result: Message[] };
  detect: { args: []; result: Environment };
  choosePath: { args: ['pi' | 'node' | 'agent' | 'editor']; result: string | null };
  saveSettings: { args: [Partial<Settings>]; result: void };
  connect: { args: [string]; result: void };
  readModels: { args: [string]; result: void };
  recover: { args: [string, string?]; result: void };
  testConnection: { args: [string]; result: { elapsed: number; text: string } };
  send: { args: [string, string, string[], SendMode, ImageAttachment[]?]; result: void };
  pickImages: { args: []; result: ImageAttachment[] };
  projectImage: { args: [string, string]; result: ImageAttachment | null };
  sessionTree: { args: [string]; result: TreeEntry[] };
  branchSession: { args: [string, 'fork' | 'clone' | 'navigate', string?, boolean?, string?]; result: void };
  compact: {
    args: [string, string];
    result: { summary: string; tokensBefore: number; estimatedTokensAfter?: number };
  };
  piOption: {
    args: [string, 'autoCompaction' | 'autoRetry' | 'steeringMode' | 'followUpMode', boolean | string];
    result: void;
  };
  exportSession: { args: [string, 'html' | 'jsonl']; result: string | null };
  shareSession: { args: [string]; result: string | null };
  reloadPi: { args: [string]; result: void };
  resources: { args: [string]; result: ResourceCatalog };
  promptRead: { args: [string, string]; result: PromptTemplateDocument };
  promptSave: {
    args: [string, PromptTemplateInput, PromptTemplateDocument?];
    result: PromptTemplateDocument;
  };
  promptDelete: { args: [string, string, string]; result: void };
  usageSummary: { args: []; result: LocalUsageSummary };
  cleanupEmptySessions: { args: []; result: number };
  toggleResource: { args: [string, ResourceItem, boolean]; result: void };
  packageAction: { args: [string, 'install' | 'remove' | 'update', string, boolean]; result: void };
  providers: { args: [string]; result: ProviderInfo[] };
  login: { args: [string, string, 'oauth' | 'api_key']; result: void };
  logout: { args: [string, string]; result: void };
  cancelLogin: { args: [sessionId: string]; result: void };
  configRead: { args: [string, ConfigKind, boolean]; result: ConfigDocument };
  configSave: { args: [string, ConfigKind, boolean, ConfigDocument]; result: ConfigSaveResult };
  revealSessionDirectory: { args: [string]; result: void };
  openPiTerminal: { args: [string]; result: void };
  editDraft: { args: [string]; result: void };
  stop: { args: [sessionId: string]; result: void };
  stopAll: { args: []; result: void };
  clearQueue: { args: [sessionId: string]; result: void };
  forceStop: { args: [sessionId: string]; result: boolean };
  respond: {
    args: [sessionId: string, dialogId: string, { value?: string; confirmed?: boolean; cancelled?: boolean }];
    result: void;
  };
  files: { args: [string, string]; result: FileItem[] };
  searchFiles: { args: [string, string]; result: string[] };
  preview: { args: [string, string]; result: FilePreview };
  attachmentInfo: { args: [string, string[]]; result: AttachmentInfo[] };
  projectRules: { args: [string]; result: AgentRulesFile | undefined };
  editProjectRules: { args: [string]; result: void };
  createAgentRules: { args: [string]; result: AgentRulesFile };
  changes: {
    args: [string, ('all' | 'run')?, { sessionId: string; checkpointId?: string }?];
    result: Changes;
  };
  diff: {
    args: [string, string, 'all' | 'run', { sessionId: string; checkpointId?: string }?];
    result: FileDiff;
  };
  openFile: { args: [string, string]; result: void };
  openResource: { args: [string, string]; result: void };
  referenceDropped: { args: [string, string[]]; result: { accepted: string[]; rejected: string[] } };
  openLink: { args: [string]; result: void };
  copy: { args: [string]; result: void };
  copyImage: { args: [string]; result: void };
  exportOutput: { args: [sessionId: string]; result: string | null };
  diagnostics: { args: []; result: string };
  exportDiagnostics: { args: []; result: string | null };
  revealData: { args: []; result: void };
  quit: { args: []; result: void };
}
export interface DesktopApi {
  platform: 'win32' | 'darwin' | 'linux' | string;
  invoke<K extends keyof ApiMap>(method: K, ...args: ApiMap[K]['args']): Promise<ApiMap[K]['result']>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  pathForFile(file: File): string;
}
export const busy = (status: string) =>
  ['starting', 'running', 'waiting', 'retrying', 'compacting', 'stopping'].includes(status);
export const emptyRuntime = (): Runtime => ({
  status: 'idle',
  messages: [],
  tools: [],
  steering: [],
  followUp: [],
  dialogs: [],
  notices: [],
  widgets: {},
  statuses: {},
  models: [],
  modelsLoaded: false,
  modelsLoading: false,
  thinkingLevels: [],
  connected: false,
  diagnostic: [],
  commands: [],
});
export function messageText(message: Pick<Message, 'content'>): string {
  return typeof message.content === 'string'
    ? message.content
    : (message.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
}
