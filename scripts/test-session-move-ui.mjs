import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'session-move-ui');
const session = f.store.createSession();
session.title = '移动验收';
session.draft = '保留草稿';
session.pinned = true;
const timestamp = session.updatedAt;
await f.store.save();
let app;
try {
  const launched = await launchApp({ dataDir: f.dataDir });
  app = launched.app;
  const page = launched.page;
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  const row = page.locator(`[data-session-id="${session.id}"]`);
  await row.locator('.icon-button').click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  const modal = page.getByRole('dialog', { name: '移动会话', exact: true });
  await modal.locator('input[type=radio]:not(:disabled)').first().check();
  await modal.getByRole('button', { name: '移动', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  await page.locator(`[data-drop-target="${f.projectId}"] [data-session-id="${session.id}"]`).waitFor();
  const state = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  const moved = state.sessions.find((s) => s.id === session.id);
  assert.equal(moved.projectId, f.projectId);
  assert.equal(moved.draft, '保留草稿');
  assert.equal(moved.pinned, true);
  assert.equal(moved.updatedAt, timestamp);
  // Drag back to standalone: no history means no confirmation.
  const bounds = await row.boundingBox();
  const target = await page.locator('[data-drop-target="standalone"]').boundingBox();
  await page.mouse.move(bounds.x + 40, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 30, target.y + 12, { steps: 15 });
  await page.mouse.up();
  await page.locator(`[data-drop-target="standalone"] [data-session-id="${session.id}"]`).waitFor();
  // Generate actual Pi history, then migrate through its installed bridge.
  await page.getByRole('textbox', { name: '任务输入' }).fill('移动历史验收');
  await page.locator('.send-button').click();
  await page.waitForFunction(() => !document.querySelector('.stop-button'), { timeout: 60000 });
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).sessions.find(
      (s) => s.id === session.id,
    );
    if (saved.file && !['running', 'starting', 'retrying'].includes(saved.lastStatus)) break;
    await page.waitForTimeout(100);
  }
  assert.ok(saved.file);
  await app.evaluate(({ shell }) => {
    shell.trashItem = async (file) => {
      globalThis.movedTrash = file;
    };
  });
  await row.locator('.icon-button').click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  const historyModal = page.getByRole('dialog', { name: '移动会话', exact: true });
  await historyModal.locator('input[type=radio]:not(:disabled)').first().check();
  await historyModal.getByRole('button', { name: '移动', exact: true }).click();
  await historyModal.waitFor({ state: 'detached', timeout: 60000 });
  const migrated = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).sessions.find(
    (s) => s.id === session.id,
  );
  const header = JSON.parse((await fs.readFile(migrated.file, 'utf8')).split('\n')[0]);
  assert.equal(path.resolve(header.cwd), path.resolve(f.projectDir));
  assert.equal(path.resolve(header.parentSession), path.resolve(saved.file));
  assert.equal(await app.evaluate(() => globalThis.movedTrash), saved.file);
  assert.deepEqual(launched.errors, []);
  console.log('Session move menu, persistence and pointer UI passed');
} finally {
  await closeApp(app);
  await provider.close();
}
