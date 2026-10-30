import { launchApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { AgentService } from '../electron/agent.ts';
import { Workspace } from '../electron/workspace.ts';
import { readSessionFile } from '../electron/store.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { reportSessionSwitchBudget } from './session-switch-budget.mjs';
import {
  observeSessionSelections,
  sessionSelectionReady,
  sessionSelectionSnapshot,
} from './session-switch-measurement.mjs';

process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'session-ui');
// Real Pi loads both models. A/B have different identities so a stale model
// cannot accidentally satisfy the final rapid-return gate.
const modelsFile = path.join(f.agentDir, 'models.json');
const models = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
models.providers['local-e2e'].models.push({
  ...models.providers['local-e2e'].models[0],
  id: 'local-e2e-alt',
  name: '另一个本地验收模型',
});
await fs.writeFile(modelsFile, JSON.stringify(models));
// All trust and extension changes are confined to this disposable fixture.
const settingsFile = path.join(f.agentDir, 'settings.json');
await fs.writeFile(
  settingsFile,
  JSON.stringify({
    ...JSON.parse(await fs.readFile(settingsFile, 'utf8')),
    defaultProjectTrust: 'always',
  }),
);
const otherProject = {
  id: randomUUID(),
  name: '另一个验收项目',
  path: path.join(f.dir, 'other-project'),
  trusted: true,
  createdAt: Date.now(),
};
f.store.state.projects.push(otherProject);
for (const [directory, command] of [
  [f.agentDir, 'session-ui-process-cwd'],
  [path.join(f.projectDir, '.pi'), 'session-ui-project-only'],
  [path.join(otherProject.path, '.pi'), 'session-ui-other-project-only'],
]) {
  await fs.mkdir(path.join(directory, 'extensions'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'extensions', 'session-ui-context.js'),
    `export default function(pi) {
      pi.registerCommand(${JSON.stringify(command)}, { description: process.cwd(), handler: async () => {} });
    }`,
  );
}
const a = f.store.session(f.sessionId),
  b = f.store.createSession(f.projectId),
  standalone = f.store.createSession(),
  coldProject = f.store.createSession(f.projectId),
  other = f.store.createSession(otherProject.id),
  largeHistory = f.store.createSession(f.projectId);
b.model = { provider: 'local-e2e', id: 'local-e2e-alt' };
const fixtures = [
  { session: a, marker: 'SESSION_A_ONLY', command: 'session-ui-project-only' },
  { session: b, marker: 'SESSION_B_ONLY', command: 'session-ui-project-only' },
  { session: standalone, marker: 'SESSION_STANDALONE_ONLY' },
  { session: coldProject, marker: 'SESSION_COLD_PROJECT_ONLY', command: 'session-ui-project-only' },
  { session: other, marker: 'SESSION_OTHER_PROJECT_ONLY', command: 'session-ui-other-project-only' },
  { session: largeHistory, marker: 'SESSION_LARGE_HISTORY_ONLY', command: 'session-ui-project-only' },
];
const seed = new AgentService(f.store, new Workspace(f.dataDir));
const wait = async (condition) => {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 30000) throw new Error('Session UI fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
try {
  for (const fixture of fixtures) {
    fixture.cwd = await f.store.sessionDirectory(fixture.session.id);
    await seed.send(fixture.session.id, fixture.marker, [], 'steer');
    await wait(() => !seed.hasPendingWork);
  }
} finally {
  await seed.dispose();
}
// Extend a real Pi-created transcript with Pi's own append-only writer. No
// renderer/runtime overrides and no 250 network turns are needed for this fixture.
const largeTranscript = await readSessionFile(largeHistory.file);
const conversationMessages = largeTranscript.messages.filter((message) =>
  ['user', 'assistant'].includes(message.role),
);
assert.deepEqual(
  conversationMessages.map((message) => message.role),
  ['user', 'assistant'],
);
const historyWriter = SessionManager.open(largeHistory.file);
const historyMessageCount = 500;
const historyRecordCount =
  largeTranscript.messages.length + historyMessageCount - conversationMessages.length;
for (let index = conversationMessages.length; index < historyMessageCount; index++) {
  const template = conversationMessages[index % 2];
  historyWriter.appendMessage({
    ...template,
    timestamp: 1700000000000 + index,
    content: [
      {
        type: 'text',
        text:
          `历史消息 ${index + 1}: ${index % 2 ? '已检查修改和测试结果。' : '请检查本轮文件修改和边界情况。'}\n\n` +
          '- 保留当前项目和会话的上下文\n- 核对草稿、模型和发送状态\n\n' +
          (index === historyMessageCount - 1 ? 'SESSION_LARGE_HISTORY_ONLY' : `HISTORY_RECORD_${index}`),
      },
    ],
  });
}
const savedLargeMessages = (await readSessionFile(largeHistory.file)).messages;
assert.equal(savedLargeMessages.length, historyRecordCount);
assert.equal(
  savedLargeMessages.filter((message) => ['user', 'assistant'].includes(message.role)).length,
  historyMessageCount,
);
assert.equal(
  SessionManager.open(largeHistory.file)
    .buildSessionContext()
    .messages.filter((message) => ['user', 'assistant'].includes(message.role)).length,
  historyMessageCount,
);
const historyBytes = (await fs.stat(largeHistory.file)).size;
assert.ok(historyBytes < 2 * 1024 * 1024, 'The 500-message fixture must have bounded cost');
const requestsAfterSeeding = provider.requests.length;
let originalActivity = {};
for (const [index, { session }] of fixtures.entries()) {
  session.title = `切换验收 ${index + 1}`;
  session.draft = `${session.title} 的未发送草稿`;
  // Distinct, recent activity makes accidental browsing-driven reordering observable.
  session.updatedAt = Date.now() - (fixtures.length - index) * 60 * 60 * 1000;
  originalActivity[session.id] = session.updatedAt;
}
f.store.selectSession(a.id);
await f.store.save();
const packaged = process.argv.includes('--packaged');
let executablePath = process.env.PI_DESKTOP_EXE;
if (packaged && !executablePath)
  executablePath =
    process.platform === 'win32'
      ? path.resolve('release/win-unpacked/Pi Desktop.exe')
      : path.resolve(
          `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Pi Desktop.app/Contents/MacOS/Pi Desktop`,
        );
let app, page, testError, firstColdOpen, lastMeasurementSamples;
const errors = [];
const nodeLaunch = {};
const expectedSelection = (fixture, requireConnection = true) => ({
  id: fixture.session.id,
  projectId: fixture.session.projectId,
  cwd: fixture.cwd,
  title: fixture.session.title,
  draft: fixture.session.draft,
  marker: fixture.marker,
  markers: fixtures.map((item) => item.marker),
  modelId: fixture.session.model?.id ?? 'local-e2e',
  requireConnection,
});
let measurementRequest = 0;
const measurementSpec = (fixture, scenario, requireConnection = true, phase = 'browse') => ({
  requestId: `${scenario}-${++measurementRequest}`,
  scenario,
  phase,
  projectId: fixture.session.projectId,
  expected: expectedSelection(fixture, requireConnection),
  triggerSelector:
    phase === 'explicit-model-open'
      ? 'button[aria-label="选择模型"]'
      : phase === 'explicit-connect'
        ? '.run-meta button'
        : `.session-row[data-session-id="${fixture.session.id}"] > button`,
});
const armMeasurement = (requests, startMode = 'click') =>
  page.evaluate(observeSessionSelections, { requests, startMode });
const readMeasurement = async () => {
  const samples = await page.evaluate(() => window.switchMeasurement);
  // Preserve the resolved samples even when a correctness assertion below fails.
  lastMeasurementSamples = samples;
  for (const timing of samples) {
    assert.equal(timing.otherHistoryVisible, false, 'History must match the displayed session title/sidebar');
    assert.equal(
      timing.unsafeSendGateObserved,
      false,
      'A pending switch must not unlock the wrong send gate',
    );
    assert.equal(
      timing.unsafeModelGateObserved,
      false,
      'A pending switch must not unlock the wrong model gate',
    );
    assert.equal(timing.selectionRegressed, false, 'A completed final selection must not regress');
    if (timing.outcome !== 'completed') continue;
    for (const key of [
      'messageDomMs',
      'nextAnimationFrameMs',
      'authoritativeSelectionMs',
      'draftRestoredMs',
      'sendGateReadyMs',
      'selectionSettledMs',
    ])
      assert.ok(Number.isFinite(timing[key]) && timing[key] >= 0, `Missing or invalid ${key}`);
    if (timing.requireConnection)
      assert.ok(Number.isFinite(timing.runtimeReadyMs) && timing.runtimeReadyMs >= 0);
    if (timing.requireModels)
      assert.ok(Number.isFinite(timing.modelCatalogReadyMs) && timing.modelCatalogReadyMs >= 0);
    if (timing.startMode === 'explicit-ipc')
      assert.ok(Number.isFinite(timing.actionCompletedMs) && timing.actionCompletedMs >= 0);
    assert.equal(timing.settlement.complete, true, 'The resolving sample must satisfy every target gate');
    assert.equal(
      timing.settlement.targetHistoryPresent,
      true,
      'The target history must remain at completion',
    );
    assert.equal(
      timing.settlement.foreignHistoryPresent,
      false,
      'Completed selection must contain no foreign history',
    );
    assert.equal(timing.settlement.runtimeOwned, true, 'Readiness must belong to the intended runtime');
  }
  return samples;
};
const launch = async () => {
  // Keep this Node clock separate from all renderer navigation/click measurements.
  const nodeStarted = performance.now();
  ({ app, page } = await launchApp({ executablePath, dataDir: f.dataDir, errors: errors }));
  nodeLaunch.firstWindowMs = performance.now() - nodeStarted;

  await page.waitForFunction(() => Boolean(window.desktop && document.querySelector('#root')));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.focus();
  });
  await page.bringToFront();
  await page.evaluate(`window.sessionUiSnapshot = (${sessionSelectionSnapshot.toString()})`);
  await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    window.sessionUiNavigation = {
      timeOrigin: performance.timeOrigin,
      url: location.href,
      documentReadyStateAtObserverInstallation: document.readyState,
      navigationType: navigation?.type ?? null,
      domContentLoadedEventEndAtObserverInstallation: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEndAtObserverInstallation: navigation?.loadEventEnd ?? null,
    };
    window.sessionUiRuntimes = new Map();
    window.sessionUiRevision = 0;
    const unsubscribe = window.desktop.onEvent((event) => {
      if (event.type === 'state' && event.revision >= window.sessionUiRevision) {
        window.sessionUiState = event.state;
        window.sessionUiRevision = event.revision;
      }
      if (event.type === 'runtime' && event.runtime.sessionId)
        window.sessionUiRuntimes.set(event.runtime.sessionId, event.runtime);
      if (event.type === 'runtimePatch' && event.patch.sessionId) {
        const next = {
          ...window.sessionUiRuntimes.get(event.patch.sessionId),
          ...event.patch,
        };
        for (const key of event.patch.removed ?? []) delete next[key];
        window.sessionUiRuntimes.set(event.patch.sessionId, next);
      }
      if (event.type === 'runtimeRemoved') window.sessionUiRuntimes.delete(event.sessionId);
    });
    window.otherSessionBannerCount = 0;
    const observer = new MutationObserver(() => {
      if (
        [...document.querySelectorAll('.banner')].some((banner) =>
          banner.textContent.includes('另一个会话正在执行'),
        )
      )
        window.otherSessionBannerCount++;
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    window.sessionUiObservationCleanup = () => {
      observer.disconnect();
      unsubscribe();
    };
  });
  // The observer is attached after firstWindow, so this is an upper-bound DOM
  // observation from navigation origin, not an exact app-launch or paint time.
  await armMeasurement([measurementSpec(fixtures[0], 'first-cold-open', false)], 'navigation');
  await page.evaluate(async () => {
    window.sessionUiInitialResyncStartedAtMs = performance.now();
    // Exactly one initial read seeds public state; never poll bootstrap in a switch.
    const { state, runtime, revision } = await window.desktop.invoke('bootstrap');
    if (revision >= window.sessionUiRevision) {
      window.sessionUiState = state;
      window.sessionUiRevision = revision;
    }
    if (runtime.sessionId) window.sessionUiRuntimes.set(runtime.sessionId, runtime);
    window.sessionUiInitialResyncResolvedAtMs = performance.now();
  });
  [firstColdOpen] = await readMeasurement();
  nodeLaunch.firstColdOpenObservedMs = performance.now() - nodeStarted;
  firstColdOpen.initialStateResync = await page.evaluate(() => ({
    startedAtMs: window.sessionUiInitialResyncStartedAtMs,
    resolvedAtMs: window.sessionUiInitialResyncResolvedAtMs,
  }));
  firstColdOpen.navigation = await page.evaluate(() => window.sessionUiNavigation);
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
};
// Playwright 1.64 predicates must return synchronous booleans, never Promises.
const selectionSettled = (session, requireConnection = true) => {
  const fixture = fixtures.find((item) => item.session.id === session.id);
  return page.waitForFunction(sessionSelectionReady, expectedSelection(fixture, requireConnection));
};
const diagnostic = async () => JSON.parse(await page.evaluate(() => window.desktop.invoke('diagnostics')));
const sidebarOrder = () =>
  page.locator('.sidebar .session-row').evaluateAll((rows) => rows.map((row) => row.dataset.sessionId));
let originalOrder;
const assertBrowsingUnchanged = async () => {
  const state = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(state.sessions.map((session) => [session.id, session.updatedAt])),
    originalActivity,
    'Browsing and connecting must not change session activity timestamps',
  );
  assert.deepEqual(await sidebarOrder(), originalOrder, 'Browsing must not reorder sidebar sessions');
};
const measureSelection = async (fixture, requireConnection = true, scenario = 'correctness-only') => {
  await armMeasurement([measurementSpec(fixture, scenario, requireConnection)]);
  try {
    await page.locator(`.session-row[data-session-id="${fixture.session.id}"] > button`).first().click();
    const [timing] = await readMeasurement();
    await selectionSettled(fixture.session, requireConnection);
    return timing;
  } catch (error) {
    await page.evaluate(() => window.cancelSessionSwitchMeasurement?.()).catch(() => {});
    throw error;
  }
};
const measureModelOpen = async (fixture, scenario) => {
  const previousConnection = (await diagnostic()).sessionSwitch;
  const previousCommands = await page.evaluate(
    (id) => window.sessionUiRuntimes.get(id)?.commands ?? [],
    fixture.session.id,
  );
  const historyBeforeModelLookup = await fs.readFile(fixture.session.file);
  const spec = measurementSpec(fixture, scenario, false, 'explicit-model-open');
  spec.expected.requireModels = true;
  await armMeasurement([spec]);
  try {
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    const [timing] = await readMeasurement();
    await selectionSettled(fixture.session, false);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '模型与推理级别' }).waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected ?? false, fixture.session.id),
      false,
      'Model metadata loading must not connect the conversation',
    );
    assert.deepEqual(
      (await diagnostic()).sessionSwitch,
      previousConnection,
      'Metadata loading must not create a chat connection',
    );
    const commandsAfter = await page.evaluate(
      (id) => window.sessionUiRuntimes.get(id).commands,
      fixture.session.id,
    );
    if (previousConnection === undefined)
      assert.equal(commandsAfter.length, 0, 'Catalog loading must not load chat commands');
    else
      assert.deepEqual(
        commandsAfter,
        previousCommands,
        'Catalog loading must not replace retained chat commands',
      );
    const historyAfterModelLookup = await fs.readFile(fixture.session.file);
    assert.deepEqual(
      historyAfterModelLookup,
      historyBeforeModelLookup,
      'Catalog loading must preserve exact saved-history bytes',
    );
    timing.catalogIsolation = {
      historyBytesUnchanged: true,
      historySha256: createHash('sha256').update(historyAfterModelLookup).digest('hex'),
      chatCommandsUnchanged: true,
      chatCommandCountAfter: commandsAfter.length,
      chatConnectionDiagnosticUnchanged: true,
      pickerDetached: true,
    };
    return timing;
  } catch (error) {
    await page.evaluate(() => window.cancelSessionSwitchMeasurement?.()).catch(() => {});
    throw error;
  }
};
const measureExplicitConnection = async (fixture, scenario) => {
  await selectionSettled(fixture.session, false);
  const spec = {
    ...measurementSpec(fixture, scenario, true, 'explicit-connect'),
    activation: 'Playwright pointer click on the selected conversation’s .run-meta 重新连接 button',
  };
  const reconnect = page.locator('.run-meta').getByRole('button', { name: '重新连接', exact: true });
  assert.equal(
    await reconnect.count(),
    1,
    'The selected disconnected conversation must expose its real reconnect action',
  );
  await armMeasurement([spec]);
  try {
    await reconnect.click();
    const [timing] = await readMeasurement();
    await selectionSettled(fixture.session);
    return timing;
  } catch (error) {
    await page.evaluate(() => window.cancelSessionSwitchMeasurement?.()).catch(() => {});
    throw error;
  }
};
const within = async (operation, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const cleanupApp = async () => {
  if (!app) return;
  if (page && !page.isClosed())
    await within(
      page.evaluate(() => {
        window.cancelSessionSwitchMeasurement?.();
        window.sessionUiObservationCleanup?.();
        // Cleanup only: handle future exit requests and a request already shown by a failed close.
        window.desktop.onEvent((event) => {
          if (event.type === 'appDialog' && event.dialog.message === 'Pi 仍在执行任务')
            void window.desktop.invoke('respondAppDialog', event.dialog.id, 1).catch(() => {});
        });
        const existing = [...document.querySelectorAll('[data-app-dialog] button')].find(
          (button) => button.textContent === '停止并退出',
        );
        existing?.click();
      }),
      3000,
      'Installing exit cleanup',
    ).catch((error) => console.warn(error.message));
  try {
    await within(app.close(), 15000, 'Electron cleanup');
  } catch (error) {
    // Never leave CI waiting indefinitely, or replace the original assertion with a cleanup failure.
    try {
      app.process().kill('SIGKILL');
    } catch {}
    return error;
  }
};
try {
  await launch();
  const buildInfo = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  }));
  assert.equal(buildInfo.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version);
  if (packaged) assert.equal(buildInfo.packaged, true);
  const git = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      return null;
    }
  };
  const sha256 = async (file) => {
    try {
      return createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
    } catch {
      return null;
    }
  };
  const trackedDiff = git(['diff', '--binary', 'HEAD']);
  const buildFiles = {};
  if (buildInfo.packaged) buildFiles['app.asar'] = await sha256(buildInfo.appPath);
  else {
    const collect = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else buildFiles[path.relative(buildInfo.appPath, file)] = await sha256(file);
      }
    };
    await collect(path.join(buildInfo.appPath, 'dist'));
    await collect(path.join(buildInfo.appPath, 'dist-electron'));
  }
  const sourceIdentity = {
    checkoutCommit: git(['rev-parse', 'HEAD']),
    reportedBuildCommit: process.env.PI_DESKTOP_SOURCE_COMMIT ?? null,
    worktreeStatus: git(['status', '--porcelain']),
    trackedDiffSha256: trackedDiff === null ? null : createHash('sha256').update(trackedDiff).digest('hex'),
    buildFiles,
    runnerSha256: await sha256('scripts/test-session-ui.mjs'),
    observerSha256: await sha256('scripts/session-switch-measurement.mjs'),
    note: 'Checkout identity and dirty diff are separate from hashes of the actual loaded build; unavailable identity is null.',
  };
  assert.equal(
    await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected ?? false, a.id),
    false,
    'First app-open browsing must not start Pi',
  );
  assert.equal((await diagnostic()).sessionSwitch, undefined);
  const firstColdModelOpen = await measureModelOpen(fixtures[0], 'first-cold-open');
  const firstColdConnection = await measureExplicitConnection(fixtures[0], 'first-cold-open');
  await page.locator('.thread').getByText('SESSION_A_ONLY', { exact: true }).waitFor();
  for (const header of await page.locator('.project-row').all())
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  originalOrder = await sidebarOrder();
  assert.equal(originalOrder.length, fixtures.length);
  await assertBrowsingUnchanged();
  const originalPid = (await diagnostic()).sessionSwitch.pid;
  assert.ok(Number.isInteger(originalPid));
  const sessionPids = new Map([[a.id, originalPid]]);
  // Warm B explicitly so the hot-switch measurements only cover existing connections.
  await page.evaluate((id) => window.desktop.invoke('connect', id), b.id);
  const hotSwitches = [];
  const requestsBeforeSwitching = requestsAfterSeeding;
  assert.equal(
    provider.requests.length,
    requestsBeforeSwitching,
    'Initial browsing and model loading must not send a prompt',
  );
  for (let i = 0; i < 12; i++) {
    const target = fixtures[i % 2 ? 0 : 1];
    const timing = await measureSelection(target, true, 'same-project-hot-return');
    // lastSwitch describes the process's last connection, not this hot UI switch.
    // Read it only after selection settles, and use it solely to check PID ownership.
    const info = (await diagnostic()).sessionSwitch;
    assert.equal(info.mode, 'restart');
    if (sessionPids.has(target.session.id)) assert.equal(info.pid, sessionPids.get(target.session.id));
    else sessionPids.set(target.session.id, info.pid);
    await assertBrowsingUnchanged();
    if (i >= 2) hotSwitches.push({ sessionId: target.session.id, ...timing });
  }
  const durations = hotSwitches.map((sample) => sample.nextAnimationFrameMs);
  const measurement = {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    ...buildInfo,
    sourceIdentity,
    nodeLaunch: { clock: 'Node performance.now; never subtracted from renderer timestamps', ...nodeLaunch },
    durations,
    selectionSettledMs: hotSwitches.map((sample) => sample.selectionSettledMs),
    hotSwitches,
    activitySnapshot: { updatedAt: originalActivity, sidebarOrder: originalOrder },
    timingNotes: {
      durations: 'Click to target history DOM observation followed by the next rAF; not a paint measurement.',
      runtimeReadyMs:
        'Target-owned connected/idle state with its expected model. Exactly 0 means already-ready at click, not a zero-cost connection.',
      selectionSettledMs:
        'Click to a newer authoritative target state revision, correct heading/sidebar/history/draft and nonpending enabled send/model gates, plus target-owned idle runtime when required. This is observed renderer completion, not an IPC roundtrip.',
      firstColdOpen:
        'Initial renderer navigation origin to observation after firstWindow and one initial public bootstrap resync. Observer installation is recorded; already-visible DOM is an upper bound. Node launch timings use a separate clock.',
      modelCatalogReadyMs:
        'Real model-menu click to loaded target-owned catalog and its enabled expected current option. A disposable Pi metadata reader is allowed; the conversation remains disconnected.',
      explicitConnection:
        'Real selected-session .run-meta 重新连接 click to target-owned idle readiness and nonpending renderer completion. Separate from catalog opening and browsing; not a direct IPC-roundtrip measurement.',
    },
    maxMs: Math.max(...durations),
    budgetMs: 200,
  };
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    `test-results/session-ui-${process.platform}.json`,
    JSON.stringify(measurement, null, 2),
  );
  console.log('Session click-to-DOM/next-rAF/readiness measurements:', JSON.stringify(measurement));
  reportSessionSwitchBudget(measurement);
  assert.notEqual(sessionPids.get(a.id), sessionPids.get(b.id));
  console.log("PASS ten hot UI switches retain each chat's process, draft, activity time and sidebar order");

  // A is selected after the even number of switches. Its exit must not disturb B.
  process.kill(originalPid);
  await page.waitForFunction((id) => {
    const runtime = window.sessionUiRuntimes.get(id);
    return runtime?.connected === false && runtime.crash?.cleanup === 'confirmed';
  }, a.id);
  // The unexpected process exit is genuine activity. Establish its persisted/rendered baseline;
  // subsequent browsing and reconnection must leave that new activity order unchanged.
  // Status and activity enqueue separate saves. The first interrupted disk snapshot may
  // still contain the old timestamp, while state events already expose the completed exit.
  await page.waitForFunction(
    (id) => window.sessionUiState.sessions.find((session) => session.id === id)?.lastStatus === 'interrupted',
    a.id,
  );
  originalActivity = await page.evaluate(() =>
    Object.fromEntries(window.sessionUiState.sessions.map((session) => [session.id, session.updatedAt])),
  );
  await wait(async () => {
    const state = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
    if (state.sessions.find((session) => session.id === a.id)?.lastStatus !== 'interrupted') return false;
    return (
      state.sessions.length === Object.keys(originalActivity).length &&
      state.sessions.every((session) => session.updatedAt === originalActivity[session.id])
    );
  });
  await page.waitForFunction(
    (id) => document.querySelector('.project-group .session-row')?.dataset.sessionId === id,
    a.id,
  );
  originalOrder = await sidebarOrder();
  assert.equal(await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected, b.id), true);
  await measureSelection(fixtures[1]);
  assert.equal((await diagnostic()).sessionSwitch.pid, sessionPids.get(b.id));
  await assertBrowsingUnchanged();
  console.log('PASS an idle process exit in A leaves B connected to its original process');
  const exitedBrowse = await measureSelection(fixtures[0], false, 'process-exit-recovery');
  assert.equal(await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected, a.id), false);
  // Browsing an exited chat preserves its interrupted state until the user reconnects.
  const exitRecoveryModelOpen = await measureModelOpen(fixtures[0], 'process-exit-recovery');
  const exitRecoveryConnection = await measureExplicitConnection(fixtures[0], 'process-exit-recovery');
  const reconnectedPid = (await diagnostic()).sessionSwitch.pid;
  assert.notEqual(reconnectedPid, originalPid);
  assert.notEqual(reconnectedPid, sessionPids.get(b.id));
  sessionPids.set(a.id, reconnectedPid);
  await assertBrowsingUnchanged();
  console.log('PASS browsing an exited chat does not reconnect; explicit recovery affects only that chat');

  const crossDirectory = [];
  // Every cold target has saved real Pi history but has never been visited in this app process.
  // This exercises all cross-cwd directions without confusing a hot independent process with a restart.
  for (const [fixture, transition] of [
    [fixtures[2], 'project-to-standalone'],
    [fixtures[3], 'standalone-to-project'],
    [fixtures[4], 'project-to-project'],
  ]) {
    const { session, marker, cwd, command } = fixture;
    assert.equal(
      await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected ?? false, session.id),
      false,
      'The target must be cold before its first UI selection',
    );
    const timing = await measureSelection(fixture, false, 'cross-directory-first-visit');
    assert.equal(
      await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected ?? false, session.id),
      false,
      'Browsing saved history must not start a Pi process',
    );
    assert.equal((await diagnostic()).sessionSwitch, undefined);
    assert.equal(
      await page.locator('.stop-button, .elapsed, select[aria-label="运行中发送方式"]').count(),
      0,
    );
    // Menu metadata and the actual chat connection are distinct operations.
    const modelOpening = await measureModelOpen(fixture, 'cross-directory-first-visit');
    const explicitConnection = await measureExplicitConnection(fixture, 'cross-directory-first-visit');
    const { state, runtime } = await page.evaluate(
      (id) => ({
        state: window.sessionUiState,
        runtime: window.sessionUiRuntimes.get(id),
      }),
      session.id,
    );
    assert.equal(state.selectedSessionId, session.id);
    assert.equal(state.selectedProjectId, session.projectId);
    assert.equal(runtime.sessionId, session.id);
    assert.equal(runtime.cwd, cwd);
    assert.equal(
      runtime.commands.find((item) => item.name === 'session-ui-process-cwd')?.description,
      await fs.realpath(cwd),
      'The real Pi process must use the target cwd',
    );
    for (const projectCommand of ['session-ui-project-only', 'session-ui-other-project-only'])
      assert.equal(
        runtime.commands.some((item) => item.name === projectCommand),
        projectCommand === command,
      );
    for (const { session: expected } of fixtures)
      assert.equal(state.sessions.find((item) => item.id === expected.id).draft, expected.draft);
    await page.locator('.thread').getByText(marker, { exact: true }).waitFor();
    const info = (await diagnostic()).sessionSwitch;
    assert.equal(info.mode, 'restart');
    assert.ok(Number.isInteger(info.pid));
    assert.equal([...sessionPids.values()].includes(info.pid), false, 'Each session owns a separate process');
    sessionPids.set(session.id, info.pid);
    await assertBrowsingUnchanged();
    crossDirectory.push({ transition, sessionId: session.id, ...timing, modelOpening, explicitConnection });
  }
  // Return to each warmed directory and check its original independent process remains in place.
  const hotReturns = [];
  let fromCwd = fixtures[4].cwd;
  for (const fixture of [fixtures[2], fixtures[3], fixtures[4], fixtures[0], fixtures[1]]) {
    const crossDirectory = fromCwd !== fixture.cwd;
    const timing = await measureSelection(
      fixture,
      true,
      crossDirectory ? 'cross-directory-hot-return' : 'same-project-hot-return',
    );
    assert.equal((await diagnostic()).sessionSwitch.pid, sessionPids.get(fixture.session.id));
    await assertBrowsingUnchanged();
    hotReturns.push({ crossDirectory, fromCwd, targetCwd: fixture.cwd, ...timing });
    fromCwd = fixture.cwd;
  }
  assert.equal(
    provider.requests.length,
    requestsBeforeSwitching,
    'Browsing and reconnecting must not send a prompt',
  );
  await fs.writeFile(
    `test-results/session-ui-cross-directory-${process.platform}.json`,
    JSON.stringify(
      {
        platform: process.platform,
        ...buildInfo,
        sourceIdentity,
        crossDirectory,
        hotReturns,
        activitySnapshotAfterExit: { updatedAt: originalActivity, sidebarOrder: originalOrder },
      },
      null,
      2,
    ),
  );
  console.log(
    'Cross-directory click-to-DOM/next-rAF/readiness measurements:',
    JSON.stringify(crossDirectory),
  );
  console.log(
    'PASS cold browsing starts no Pi process; explicit model loading and hot return visits preserve cwd, drafts and activity',
  );

  const largeFixture = fixtures[5];
  assert.equal(
    await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected ?? false, largeHistory.id),
    false,
    'Large history must be unvisited before its cold browsing sample',
  );
  const largeColdBrowse = await measureSelection(largeFixture, false, 'large-history');
  assert.equal((await diagnostic()).sessionSwitch, undefined);
  assert.equal(
    await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.connected ?? false, largeHistory.id),
    false,
    'Reading 500 saved messages must not start Pi',
  );
  assert.equal(
    await page.evaluate(
      async (id) => (await window.desktop.invoke('readHistory', id)).length,
      largeHistory.id,
    ),
    historyRecordCount,
  );
  const largeModelOpen = await measureModelOpen(largeFixture, 'large-history');
  const largeConnection = await measureExplicitConnection(largeFixture, 'large-history');
  const largeRuntime = await page.evaluate((id) => window.sessionUiRuntimes.get(id), largeHistory.id);
  assert.equal(largeRuntime.sessionId, largeHistory.id);
  assert.equal(largeRuntime.cwd, largeFixture.cwd);
  assert.equal(
    largeRuntime.commands.find((command) => command.name === 'session-ui-process-cwd')?.description,
    await fs.realpath(largeFixture.cwd),
  );
  const largePid = (await diagnostic()).sessionSwitch.pid;
  assert.ok(Number.isInteger(largePid));
  assert.equal([...sessionPids.values()].includes(largePid), false);
  sessionPids.set(largeHistory.id, largePid);
  await assertBrowsingUnchanged();
  await measureSelection(fixtures[0]);
  const largeHotReturn = await measureSelection(largeFixture, true, 'large-history');
  assert.equal((await diagnostic()).sessionSwitch.pid, largePid);
  assert.equal(
    await page.evaluate(
      async (id) => (await window.desktop.invoke('readHistory', id)).length,
      largeHistory.id,
    ),
    historyRecordCount,
  );
  await assertBrowsingUnchanged();
  const largeHistoryScenario = {
    messageCount: historyMessageCount,
    transcriptMessageRecordCount: historyRecordCount,
    historyBytes,
    renderedMessageElementsAfterHotReturn: await page.locator('.thread [data-message-index]').count(),
    note: '500 messages are persisted and read through real Pi; the renderer retains its normal visible-history limit.',
    coldBrowse: largeColdBrowse,
    modelOpening: largeModelOpen,
    explicitConnection: largeConnection,
    hotReturn: largeHotReturn,
  };
  console.log('Large-history session-switch measurements:', JSON.stringify(largeHistoryScenario));

  // Establish B, then issue the requested A→B→A targets without waiting between them.
  await measureSelection(fixtures[1]);
  const rapidSpecs = [fixtures[0], fixtures[1], fixtures[0]].map((fixture) => ({
    ...measurementSpec(fixture, 'rapid-a-b-a'),
    activation: 'HTMLElement.click burst in one renderer task',
  }));
  await armMeasurement(rapidSpecs);
  try {
    await page.evaluate(
      (ids) => {
        for (const id of ids) {
          const target = document.querySelector(`.session-row[data-session-id="${id}"] > button`);
          if (!target || target.disabled) throw new Error(`Rapid target ${id} is not actionable`);
          target.click();
        }
      },
      [a.id, b.id, a.id],
    );
  } catch (error) {
    await page.evaluate(() => window.cancelSessionSwitchMeasurement?.()).catch(() => {});
    throw error;
  }
  const rapidSwitches = await readMeasurement();
  assert.deepEqual(
    rapidSwitches.map((sample) => sample.sessionId),
    [a.id, b.id, a.id],
  );
  assert.deepEqual(
    rapidSwitches.map((sample) => sample.outcome),
    ['superseded', 'superseded', 'completed'],
  );
  assert.equal(new Set(rapidSwitches.map((sample) => sample.requestId)).size, 3);
  // Recheck after queued frame work; stale A/B results must not replace the final A.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await selectionSettled(a);
  assert.equal((await diagnostic()).sessionSwitch.pid, sessionPids.get(a.id));
  assert.equal(await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.model?.id, a.id), 'local-e2e');
  assert.equal(
    await page.evaluate((id) => window.sessionUiRuntimes.get(id)?.model?.id, b.id),
    'local-e2e-alt',
  );
  await assertBrowsingUnchanged();
  assert.equal(
    provider.requests.length,
    requestsBeforeSwitching,
    'All measured browsing/model operations must send no prompt',
  );
  const scenarios = {
    firstColdOpen: {
      browsing: firstColdOpen,
      modelOpening: firstColdModelOpen,
      explicitConnection: firstColdConnection,
    },
    sameProjectHotReturn: { discardedWarmups: 2, samples: hotSwitches },
    crossDirectoryHotReturn: { samples: hotReturns.filter((sample) => sample.crossDirectory) },
    largeHistory: largeHistoryScenario,
    rapidABA: {
      activation:
        'Three HTMLElement.click activations in one renderer task; this exercises the real UI handlers without pointer-travel delay.',
      samples: rapidSwitches,
    },
  };
  await fs.writeFile(
    `test-results/session-ui-scenarios-${process.platform}.json`,
    JSON.stringify(
      {
        ...measurement,
        scenarios,
        supplementalColdDirectoryVisits: crossDirectory,
        processExitRecovery: {
          browsing: exitedBrowse,
          modelOpening: exitRecoveryModelOpen,
          explicitConnection: exitRecoveryConnection,
        },
        unrunPaths: [
          {
            path: 'automatic-process-eviction',
            status: 'not-run',
            reason: 'The script explicitly terminates one process; it does not exercise automatic eviction.',
          },
          {
            path: 'project-resource-reload',
            status: 'not-run',
            reason: 'No loaded extension/configuration file is changed during measurement.',
          },
        ],
        activitySnapshotAfterExit: { updatedAt: originalActivity, sidebarOrder: originalOrder },
      },
      null,
      2,
    ),
  );
  console.log('Rapid A→B→A session-switch measurements:', JSON.stringify(rapidSwitches));
  console.log(
    'PASS all five scenario groups retain target history, model ownership, drafts, process isolation and activity order',
  );
  assert.equal(await page.evaluate(() => window.otherSessionBannerCount), 0);
  console.log('PASS idle switches and cold reconnection never show an unrelated running-session banner');

  const fresh = await page.evaluate(() => window.desktop.invoke('newSession'));
  const task = 'FIRST_SEND_WITHOUT_PRECONNECT';
  await page.waitForFunction(
    ({ id, title }) =>
      window.sessionUiState?.selectedSessionId === id &&
      document.querySelector('.workspace-title h1')?.textContent === title &&
      Boolean(document.querySelector('textarea[aria-label="任务输入"]')) &&
      !document.querySelector('textarea[aria-label="任务输入"]').disabled,
    { id: fresh.id, title: fresh.title },
  );
  await page.getByRole('textbox', { name: '任务输入' }).fill(task);
  await page.waitForFunction(
    (id) =>
      window.sessionUiState?.selectedSessionId === id &&
      !window.sessionUiRuntimes.get(id)?.connected &&
      !document.querySelector('.send-button')?.disabled &&
      !document.querySelector('.send-button .spin'),
    fresh.id,
  );
  assert.equal((await diagnostic()).sessionSwitch, undefined);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.waitForFunction((id) => window.sessionUiRuntimes.get(id)?.status === 'completed', fresh.id);
  assert.equal(provider.requests.length, requestsBeforeSwitching + 1);
  assert.ok(JSON.stringify(provider.requests.at(-1).messages).includes(task));
  console.log('PASS a new chat starts Pi on its first send and completes without a prior connection');

  assert.deepEqual(errors, []);
} catch (error) {
  testError = error;
  if (page && !page.isClosed()) {
    await (async () => {
      await fs.mkdir('test-results', { recursive: true });
      const renderer = await page.evaluate(() => ({
        selectedSessionId: window.sessionUiState?.selectedSessionId,
        activity: window.sessionUiState?.sessions.map(({ id, updatedAt, lastStatus }) => ({
          id,
          updatedAt,
          lastStatus,
        })),
      }));
      const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
      await fs.writeFile(
        `test-results/session-ui-failure-${process.platform}.json`,
        JSON.stringify(
          {
            error: String(error),
            expectedActivity: originalActivity,
            renderer,
            lastMeasurementSamples,
            persistedActivity: persisted.sessions.map(({ id, updatedAt, lastStatus }) => ({
              id,
              updatedAt,
              lastStatus,
            })),
          },
          null,
          2,
        ),
      );
    })().catch(() => {});
    await fs
      .mkdir('test-results', { recursive: true })
      .then(() =>
        page.screenshot({ path: `test-results/session-ui-failure-${process.platform}.png`, timeout: 5000 }),
      )
      .catch(() => {});
  }
  throw error;
} finally {
  const cleanupError = await cleanupApp();
  await provider.close();
  if (cleanupError) {
    // eslint-disable-next-line no-unsafe-finally -- Preserve the original failure; fail teardown only after a successful test.
    if (!testError) throw cleanupError;
    console.warn('Cleanup after the original failure:', cleanupError.message);
  }
}

// Reuse the same --packaged target for image and transcript checks in the native CI jobs.
await import('./test-image-input-ui.mjs');
await import('./test-transcript-ui.mjs');
