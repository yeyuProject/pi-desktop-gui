import assert from 'node:assert/strict';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { transformSync } from 'esbuild';
import { handlerSource } from './ipc-handler-source';
import { isReusableSession } from '../../electron/session-maintenance';
import type { Store } from '../../electron/store';
import type { SessionAgents } from '../../electron/session-agents';
import type { AppEvent, Message, Session, StateSnapshot } from '../../shared/types';

// Load the actual main functions and handlers, rather than reproducing their
// scheduling in the test. Only Electron menu guards/dialog delivery are supplied.
const api = new API();
let source: ts.SourceFile;
try {
  const config = path.resolve('tsconfig.json');
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const parsed = snapshot.getProject(config)?.program.getSourceFile(path.resolve('electron/main.ts'));
  assert.ok(parsed);
  source = parsed;
  snapshot.dispose();
} finally {
  api.close();
}
function variable(name: string) {
  const matches = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => declaration.name.getText(source) === name);
  assert.equal(matches.length, 1, `Expected current ${name} declaration`);
  assert.ok(matches[0].initializer);
  return matches[0].initializer;
}
function declaration(name: string) {
  const matches = source.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(matches.length, 1, `Expected current ${name} function`);
  return matches[0].getText(source);
}
function handler(name: string) {
  return handlerSource(name, true);
}
const { code } = transformSync(
  `const create = (store, service, publish, isReusableSession, showAppDialog) => {
    const appDialogs = { size: 0 }, updates = { state: { installing: false } };
    let closing = false, quitting = false, activeOperations = 0;
    let stateRevision = 0;
    const stateSnapshot = ${variable('stateSnapshot').getText(source)};
    const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_channel, event) => publish(event) } };
    const watchSelectedProject = () => {};
    const send = ${variable('send').getText(source)};
    ${declaration('text')}
    const save = ${variable('save').getText(source)};
    ${declaration('newSession')}
    ${declaration('newSessionFromMenu')}
    return {
      create: ${handler('newSession')},
      select: ${handler('selectSession')},
      nativeCreate: newSessionFromMenu,
      confirm: ${handler('navigationState')},
      appDialogs,
    };
  };`,
  { loader: 'ts', format: 'cjs' },
);
const factory = new Function(`${code}\nreturn create;`)();
export function createMainNavigation(store: Store, agents: SessionAgents, send: (event: AppEvent) => void) {
  return factory(store, agents, send, isReusableSession, async () => ({ response: 0 })) as {
    create: (projectId?: string) => Promise<Session>;
    select: (id: string) => Promise<Message[]>;
    nativeCreate: () => Promise<void>;
    confirm: () => StateSnapshot;
    appDialogs: { size: number };
  };
}
