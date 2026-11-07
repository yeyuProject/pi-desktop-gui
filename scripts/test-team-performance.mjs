import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createTeamProvider } from '../tests/support/team-provider.ts';
import { unregisterMacTestApp } from './mac-builds.mjs';

const provider = await createTeamProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'team-performance');
fixture.store.session(fixture.sessionId).teamEnabled = true;
fixture.store.state.settings.team.concurrency = 6;
await fixture.store.save();
let app, page;
const errors = [],
  results = [];
try {
  ({ app, page } = await launchApp({
    executablePath: process.env.PI_DESKTOP_EXE,
    dataDir: fixture.dataDir,
    errors,
  }));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960));
  const invoke = (method, ...args) =>
    page.evaluate(({ method, args }) => window.desktop.invoke(method, ...args), { method, args });
  const ready = (n) => expect.poll(() => provider.pending.length, { timeout: 45000 }).toBe(n);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () =>
    Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  for (const count of [3, 6]) {
    await invoke('send', fixture.sessionId, `${count} 个并行成员性能验证`, [], 'steer');
    await ready(1);
    provider.reply(provider.pending[0], {
      name: 'desktop_team_dispatch',
      args: {
        members: Array.from({ length: count }, (_, i) => ({
          name: `成员${i}`,
          role: 'scout',
          task: '独立输出调研汇报',
        })),
      },
    });
    await ready(count);
    await expect(page.locator('.team-strip')).toBeVisible();
    const renderStart = await metrics();
    const started = Date.now();
    await app.evaluate(() => {
      globalThis.teamCpuStart = process.cpuUsage();
    });
    await page.evaluate(() => {
      globalThis.teamPf = {
        patches: 0,
        longTasks: [],
        frames: [],
        previous: performance.now(),
        active: true,
      };
      globalThis.teamPf.off = window.desktop.onEvent((event) => {
        if (event.type === 'runtimePatch' && event.patch.team) globalThis.teamPf.patches++;
      });
      globalThis.teamPf.observer = new PerformanceObserver((list) => {
        globalThis.teamPf.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      globalThis.teamPf.observer.observe({ type: 'longtask', buffered: false });
      const frame = (now) => {
        globalThis.teamPf.frames.push(now - globalThis.teamPf.previous);
        globalThis.teamPf.previous = now;
        if (globalThis.teamPf.active) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const nodes = await page.locator('[data-message-index]').count();
    const indices = provider.pending;
    for (let chunk = 0; chunk < 75; chunk++) {
      for (const index of indices)
        provider.stream(index, `独立成员输出 ${chunk}：` + '调查结果。'.repeat(15) + '\n');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await page.waitForTimeout(1000);
    assert.equal(
      await page.locator('[data-message-index]').count(),
      nodes,
      'member streaming never adds leader message nodes',
    );
    const elapsedMs = Date.now() - started;
    const main = await app.evaluate(() => ({
      cpu: process.cpuUsage(globalThis.teamCpuStart),
      memory: process.memoryUsage(),
    }));
    const renderer = await page.evaluate(() => {
      const data = globalThis.teamPf;
      data.active = false;
      data.off();
      data.observer.disconnect();
      const frames = data.frames.sort((a, b) => a - b);
      return {
        patches: data.patches,
        longTasks: data.longTasks,
        frameP95Ms: frames[Math.floor(frames.length * 0.95)],
        frameMaxMs: frames.at(-1),
      };
    });
    assert.ok(
      renderer.patches <= Math.ceil(elapsedMs / 1000) + 1,
      'team summaries publish at most once per second',
    );
    const renderEnd = await metrics();
    results.push({
      rendererTaskMs: (renderEnd.TaskDuration - renderStart.TaskDuration) * 1000,
      rendererLayoutMs: (renderEnd.LayoutDuration - renderStart.LayoutDuration) * 1000,
      rendererStyleMs: (renderEnd.RecalcStyleDuration - renderStart.RecalcStyleDuration) * 1000,
      members: count,
      elapsedMs,
      mainCpuPercent: (main.cpu.user + main.cpu.system) / (elapsedMs * 10),
      mainRssMiB: main.memory.rss / 1048576,
      leaderMessageNodes: nodes,
      ...renderer,
    });
    for (const index of indices) provider.reply(index, '汇报完成。');
    await ready(1);
    provider.reply(provider.pending[0], '负责人核对完成。');
    await expect
      .poll(async () => (await invoke('bootstrap')).runtime.status, { timeout: 30000 })
      .toBe('completed');
  }
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    'test-results/team-performance.json',
    JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS 3/6 concurrent managed members, fixed leader node count, <=1Hz summaries',
    JSON.stringify(results),
  );
} finally {
  try {
    await closeApp(app);
  } finally {
    await provider.close();
    await unregisterMacTestApp(process.env.PI_DESKTOP_EXE, process.env.PI_DESKTOP_TEST_APP_ROOT);
  }
}
