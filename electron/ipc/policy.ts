import type { ApiMap, Settings } from '../../shared/types';

interface IpcPolicy {
  access: 'read' | 'write';
  operation: 'untracked' | 'tracked' | 'engine' | 'configuration' | 'settings';
  duringDialog?: boolean;
  duringUpdate?: boolean;
  workspace?: 'session' | 'project' | 'checkpoint' | 'branch' | 'message';
}
const read = { access: 'read', operation: 'untracked' } as const;
const write = { access: 'write', operation: 'tracked' } as const;
const engineRead = { access: 'read', operation: 'engine' } as const;
const engineWrite = { access: 'write', operation: 'engine' } as const;
const configuration = { access: 'write', operation: 'configuration' } as const;

// Every IPC method gets one entry. Adding an ApiMap method without deciding its
// storage, quit/update and workspace behavior is a compile error.
export const IPC_POLICIES: Record<keyof ApiMap, IpcPolicy> = {
  retryStorage: read,
  rendererReady: read,
  clearLocalData: engineRead,
  appDialogsReady: { ...read, duringUpdate: true, duringDialog: true },
  respondAppDialog: { ...read, duringUpdate: true, duringDialog: true },
  showAppMenu: read,
  bootstrap: { ...read, duringUpdate: true, duringDialog: true },
  navigationState: { ...read, duringUpdate: true, duringDialog: true },
  checkUpdate: read,
  downloadUpdate: read,
  installUpdate: read,
  addProject: write,
  renameProject: write,
  removeProject: write,
  trustProject: write,
  newSession: write,
  importSession: write,
  selectSession: engineRead,
  renameSession: write,
  deleteSession: engineWrite,
  pinSession: write,
  searchSessions: read,
  piSessions: read,
  openPiSession: engineWrite,
  setSessionModel: engineWrite,
  setSessionThinking: engineWrite,
  messageAction: { ...engineWrite, workspace: 'message' },
  abortRetry: { ...read, operation: 'tracked', duringDialog: true },
  setApprovalMode: write,
  revokeApproval: write,
  checkpoints: read,
  checkpointPreview: read,
  revertCheckpoint: { ...engineWrite, workspace: 'checkpoint' },
  revertChanges: { ...engineWrite, workspace: 'project' },
  setEntryLabel: engineWrite,
  saveDraft: { ...write, duringDialog: true },
  sideChatRead: read,
  sideChatSend: write,
  sideChatStop: read,
  sideChatClear: write,
  sideChatContinue: write,
  saveDraftGoal: { ...write, duringDialog: true },
  flushDraft: { ...write, duringDialog: true },
  consumeDraft: write,
  saveView: { ...write, duringDialog: true },
  readHistory: { ...read, duringDialog: true },
  readDraftImages: { ...read, duringDialog: true },
  detect: read,
  choosePath: read,
  saveSettings: { ...write, operation: 'settings' },
  connect: { ...engineWrite, workspace: 'session' },
  readModels: engineWrite,
  recover: { ...engineWrite, workspace: 'session' },
  testConnection: { ...engineWrite, workspace: 'session' },
  send: { ...engineWrite, workspace: 'session' },
  openGoal: engineWrite,
  goalAction: engineWrite,
  pickImages: write,
  projectImage: read,
  sessionTree: engineRead,
  branchSession: { ...engineWrite, workspace: 'branch' },
  compact: { ...engineWrite, workspace: 'session' },
  piOption: engineWrite,
  exportSession: engineRead,
  shareSession: engineWrite,
  reloadPi: configuration,
  resources: engineRead,
  promptRead: engineRead,
  promptSave: configuration,
  promptDelete: configuration,
  usageSummary: { ...read, operation: 'tracked' },
  cleanupEmptySessions: engineWrite,
  toggleResource: configuration,
  packageAction: configuration,
  providers: engineRead,
  login: { ...engineWrite, workspace: 'session' },
  logout: { ...engineWrite, workspace: 'session' },
  cancelLogin: { ...write, operation: 'tracked' },
  configRead: read,
  configSave: configuration,
  revealSessionDirectory: write,
  openPiTerminal: { ...engineWrite, workspace: 'session' },
  editDraft: write,
  stop: { ...read, operation: 'tracked', duringDialog: true },
  stopAll: { ...read, operation: 'tracked', duringDialog: true },
  clearQueue: { ...read, operation: 'tracked', duringDialog: true },
  forceStop: { ...read, operation: 'tracked', duringDialog: true },
  respond: { ...read, operation: 'tracked', duringDialog: true },
  files: read,
  searchFiles: read,
  preview: read,
  attachmentInfo: read,
  projectRules: read,
  editProjectRules: read,
  createAgentRules: { ...engineWrite, workspace: 'project' },
  changes: read,
  diff: read,
  cancelDiff: { ...read, duringDialog: true },
  openFile: read,
  openResource: read,
  referenceDropped: write,
  openLink: read,
  copy: { ...read, duringUpdate: true, duringDialog: true },
  copyImage: { ...read, duringDialog: true },
  exportOutput: read,
  diagnostics: { ...read, duringUpdate: true, duringDialog: true },
  exportDiagnostics: read,
  revealData: read,
  quit: { ...read, duringDialog: true },
};

export function invocationPolicy(method: keyof ApiMap, args: unknown[], settings: Settings) {
  const policy = IPC_POLICIES[method];
  const patch =
    policy.operation === 'settings' && args[0] && typeof args[0] === 'object'
      ? (args[0] as Record<string, unknown>)
      : undefined;
  const changesEngineSettings =
    !!patch &&
    (['piPath', 'nodePath', 'agentDir', 'provider', 'modelId', 'thinking'] as const).some(
      (key) => key in patch && patch[key] !== settings[key],
    );
  return {
    ...policy,
    tracked: policy.operation !== 'untracked',
    configuration: policy.operation === 'configuration' || changesEngineSettings,
    workspace:
      policy.workspace === 'branch'
        ? args[1] === 'navigate'
          ? 'session'
          : undefined
        : policy.workspace === 'message'
          ? args[1] !== 'fork'
            ? 'session'
            : undefined
          : policy.workspace,
  };
}
