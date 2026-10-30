import { launchApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentService } from '../electron/agent.ts';
import { Workspace } from '../electron/workspace.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

// Real Pi, an isolated native session and a local provider; never calls the user's model service.
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'transcript-ui');
if (process.env.PI_DESKTOP_TEST_PI) {
  f.store.state.settings.piPath = path.resolve(process.env.PI_DESKTOP_TEST_PI);
  await f.store.save();
}
const settingsFile = path.join(f.agentDir, 'settings.json');
const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
await fs.writeFile(
  settingsFile,
  JSON.stringify({ ...settings, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } }),
);
const seed = new AgentService(f.store, new Workspace(f.dataDir));
try {
  for (const prompt of [
    'EARLY_TRANSCRIPT_MARKER\n' + '保留历史记录。'.repeat(2000),
    'LATEST_TRANSCRIPT_MARKER',
  ]) {
    await seed.send(f.sessionId, prompt, [], 'steer');
    const started = Date.now();
    while (seed.hasPendingWork) {
      if (Date.now() - started > 25000) throw new Error('Transcript seed timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
} finally {
  await seed.dispose();
}
const executable =
  process.env.PI_DESKTOP_EXE ||
  (process.argv.includes('--packaged')
    ? path.resolve(
        process.platform === 'win32'
          ? 'release/win-unpacked/Pi Desktop.exe'
          : `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Pi Desktop.app/Contents/MacOS/Pi Desktop`,
      )
    : undefined);
const output = path.resolve('output/playwright', `transcript-${process.platform}`);
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [];
const launch = async () => {
  ({ app, page } = await launchApp({
    executablePath: executable,
    dataDir: f.dataDir,
    pageTimeout: 25000,
    errors: errors,
  }));

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
};
const close = async () => {
  await page
    ?.evaluate(async () => {
      const { state } = await window.desktop.invoke('bootstrap');
      await window.desktop.invoke('stop', state.selectedSessionId);
    })
    .catch(() => {});
  await app?.close().catch(() => {});
  app = undefined;
};
const send = async (text) => {
  await page.getByRole('textbox', { name: '任务输入' }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .completed').waitFor();
};
try {
  await launch();
  const compacted = await page.evaluate(
    (id) => window.desktop.invoke('compact', id, 'Retain important local test context.'),
    f.sessionId,
  );
  assert.ok(compacted.summary);
  assert.ok(compacted.tokensBefore > 0);

  await send('E2E_FILES');
  const summary = page
    .locator('.message.assistant')
    .filter({ hasText: '已经完成文件读取和写入，并运行验证命令。' });
  await summary.waitFor();
  await page.locator('.message.user').filter({ hasText: 'EARLY_TRANSCRIPT_MARKER' }).waitFor();
  await page.locator('.message.user').filter({ hasText: 'LATEST_TRANSCRIPT_MARKER' }).waitFor();
  console.log('PASS real Pi compaction retains the complete visible conversation');
  await page.screenshot({ path: path.join(output, 'final-summary.png'), animations: 'disabled' });
  console.log('PASS real Pi tool results and final summary remain visible after compaction');
  const requestsBeforeRestart = provider.requests.length;
  await close();
  await launch();
  await page
    .locator('.message.assistant')
    .filter({ hasText: '已经完成文件读取和写入，并运行验证命令。' })
    .waitFor();
  await page.locator('.message.user').filter({ hasText: 'EARLY_TRANSCRIPT_MARKER' }).waitFor();
  assert.equal(
    provider.requests.length,
    requestsBeforeRestart,
    'opening saved history must not send a model request',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        packaged: Boolean(executable),
        checks: [
          'full history after compaction',
          'tools and final summary',
          'restart history without model requests',
        ],
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log('PASS saved history restores the same summary after restart without a model request');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await close();
  await provider.close();
}
