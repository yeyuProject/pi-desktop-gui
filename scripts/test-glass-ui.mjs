import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runInNewContext } from 'node:vm';
import { expect } from 'playwright/test';
import { Store } from '../electron/store.ts';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { workbenchFixture } from '../tests/support/workbench-fixture.mjs';

export async function prepareGlassFixture(dir, material) {
  const window = {};
  runInNewContext(`(${workbenchFixture.toString()})({ theme: 'light', stress: true })`, {
    window,
    structuredClone,
  });
  const { state, runtime } = await window.desktop.invoke('bootstrap');
  const store = new Store(dir);
  await store.load();
  for (const project of state.projects) {
    project.path = path.join(dir, project.id);
    await fs.mkdir(project.path, { recursive: true });
  }
  runtime.cwd = state.projects[0].path;
  const settings = { ...store.state.settings, ...state.settings, agentDir: path.join(dir, 'pi') };
  if (material === undefined) delete settings.material;
  if (material !== undefined) settings.material = material;
  store.state = { ...state, settings };
  await store.save();
  return runtime;
}

// The real settings IPC and app lifecycle stay in use. Only the transcript is synthetic in the benchmark.
export async function loadGlassFixture({ app, page }, runtime, materialEnvironment) {
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(
    ({ ipcMain, BrowserWindow }, { runtime, materialEnvironment }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1280, 820);
      globalThis.glassFixtureRuntime = runtime;
      const original = ipcMain._invokeHandlers.get('desktop:invoke');
      ipcMain.removeHandler('desktop:invoke');
      ipcMain.handle('desktop:invoke', async (event, method, args) => {
        if (method === 'readHistory') return globalThis.glassFixtureRuntime.messages;
        const result = await original(event, method, args);
        if (method !== 'bootstrap') return result;
        return {
          ...result,
          runtime: globalThis.glassFixtureRuntime,
          materialEnvironment: materialEnvironment ?? result.materialEnvironment,
        };
      });
    },
    { runtime, materialEnvironment },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.bringToFront();
}

async function blurLayers(page, includeHidden = false) {
  return page.evaluate(
    (includeHidden) =>
      [...document.querySelectorAll('*')].flatMap((element) => {
        if (!includeHidden && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
          return [];
        return [null, '::before', '::after'].flatMap((pseudo) => {
          const style = getComputedStyle(element, pseudo);
          if (style.backdropFilter === 'none' || (pseudo && style.content === 'none')) return [];
          return [element.tagName + '.' + [...element.classList].join('.') + (pseudo ?? '')];
        });
      }),
    includeHidden,
  );
}

/**
 * 1. 读取实际文字或图标的前景色，找出它占用的像素区域。
 * 2. 隐去前景绘制并截屏，保留原有渐变、模糊、阴影与透明度。
 * 3. 读取截屏里对应位置的背景像素，记录最低对比度。
 */
async function sampleContrast(page, locators) {
  const samples = [];
  // 1. 颜色从正在显示的元素读取，连同祖先透明度一并记下来。
  for (const [label, locator] of Object.entries(locators)) {
    await expect(locator, label).toBeVisible();
    samples.push({
      label,
      ...(await locator.evaluate((element) => {
        const css = getComputedStyle(element);
        const icon = element instanceof SVGElement;
        const range = document.createRange();
        range.selectNodeContents(element);
        const bounds =
          icon || element instanceof HTMLTextAreaElement
            ? [element.getBoundingClientRect()]
            : [...range.getClientRects()];
        let opacity = 1;
        for (let parent = element; parent; parent = parent.parentElement)
          opacity *= Number(getComputedStyle(parent).opacity);
        element.setAttribute('data-glass-contrast-sample', '');
        return {
          color: icon ? css.stroke : css.webkitTextFillColor,
          opacity,
          bounds: bounds.map(({ x, y, width, height }) => ({ x, y, width, height })),
        };
      })),
    });
  }
  // 2. 保留当前布局和表面，避免拿 CSS 变量代替合成后的背景像素。
  const mask = await page.addStyleTag({
    content: `
      [data-glass-contrast-sample], [data-glass-contrast-sample] * {
        -webkit-text-fill-color: transparent !important;
        text-shadow: none !important;
      }
      svg[data-glass-contrast-sample], svg[data-glass-contrast-sample] * {
        fill: none !important;
        stroke: none !important;
      }
    `,
  });
  try {
    const png = await page.screenshot({ scale: 'css', animations: 'disabled', caret: 'hide' });
    // 3. 在每段文字和图标所在区域取样，透明前景先与该像素合成。
    return await page.evaluate(
      async ({ png, samples }) => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + png;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
        const luminance = (rgb) =>
          rgb.reduce((value, channel, i) => {
            const s = channel / 255;
            return (
              value + [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)
            );
          }, 0);
        return samples.map(({ label, color, opacity, bounds }) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const rgba = ctx.getImageData(0, 0, 1, 1).data;
          const alpha = (rgba[3] / 255) * opacity;
          const ratios = [];
          for (const { x, y, width, height } of bounds) {
            for (const row of [0.25, 0.5, 0.75]) {
              for (const column of [0.1, 0.3, 0.5, 0.7, 0.9]) {
                const px = Math.floor(x + width * column);
                const py = Math.floor(y + height * row);
                if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
                const offset = 4 * (py * image.width + px);
                const bg = [...pixels.slice(offset, offset + 3)];
                const a = luminance(bg);
                const b = luminance(bg.map((channel, i) => channel * (1 - alpha) + rgba[i] * alpha));
                ratios.push((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
              }
            }
          }
          return { label, color, samples: ratios.length, minimum: Math.min(...ratios) };
        });
      },
      { png: png.toString('base64'), samples },
    );
  } finally {
    await mask.evaluate((element) => element.remove());
    await page.locator('[data-glass-contrast-sample]').evaluateAll((elements) => {
      for (const element of elements) element.removeAttribute('data-glass-contrast-sample');
    });
  }
}

/**
 * 1. 以旧设置启动，打开玻璃并通过真实设置 IPC 写盘，再退出重启。
 * 2. 换肤、打开浮层和拖动侧栏，核对模糊层、截图与实际背景上的对比度。
 * 3. 分别模拟 GPU、电源和降低透明度，核对降级后的状态及文字。
 */
async function verifyGlassUI(screenshotsOnly) {
  const output = path.resolve(
    process.env.PI_GLASS_UI_OUTPUT ||
      (screenshotsOnly ? 'test-results/glass-screenshots' : 'test-results/glass-ui'),
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-glass-ui-'));
  const report = { viewport: [1280, 820], themes: {}, screenshots: [], fallbacks: [] };
  let app, page;
  const errors = [];
  const runtime = await prepareGlassFixture(dir, screenshotsOnly ? 'glass' : undefined);
  for (let turn = 7; turn <= 24; turn++) {
    const timestamp = runtime.messages.at(-1).timestamp + 1000;
    runtime.messages.push(
      { role: 'user', content: `继续核对第 ${turn} 项输入校验。`, timestamp },
      {
        role: 'assistant',
        content: `第 ${turn} 项已核对。\n\n\`\`\`js\nconst result = ${turn}; // 测试\n\`\`\``,
        timestamp: timestamp + 300,
      },
    );
  }
  const usable = { gpuCompositing: true, onBattery: false };
  const root = () => page.locator('html');
  const bootstrap = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
  const settings = () => page.getByRole('dialog', { name: '设置', exact: true });
  const appearance = async () => {
    await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
    await settings().getByRole('button', { name: '外观与编辑器', exact: true }).click();
  };
  const closeSettings = async () => {
    await settings().locator(':scope > footer').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(settings()).toHaveCount(0);
  };
  const option = (name) =>
    settings().getByRole('group', { name: '材质' }).getByRole('button', { name, exact: true });
  const changeEnvironment = (materialEnvironment) =>
    app.evaluate(
      ({ BrowserWindow }, materialEnvironment) =>
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'materialEnvironment',
          materialEnvironment,
        }),
      materialEnvironment,
    );
  const launch = async () => {
    ({ app, page } = await launchApp({ dataDir: dir, errors }));
    await loadGlassFixture({ app, page }, runtime, usable);
    await expect(page.locator('.message.assistant').last()).toContainText('第 24 项已核对。');
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  };
  const capture = async (label) => {
    const file = `${label}.png`;
    await expect(root()).toHaveAttribute('data-material', 'glass');
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(output, file), animations: 'disabled', scale: 'css' });
    report.screenshots.push(file);
  };
  await fs.mkdir(output, { recursive: true });
  try {
    report.stage = 'launch';
    await launch();
    if (screenshotsOnly) {
      report.stage = 'screenshots';
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => window.desktop.invoke('saveSettings', { theme }), theme);
        await expect(root()).toHaveAttribute('data-theme', theme);
        await capture(theme);
      }
      assert.deepEqual(errors, []);
      console.log(`UI20 screenshots: ${output}`);
      return;
    }

    // 1. 只给渲染器指定测试用能力，设置保存仍使用原来的处理函数。
    report.stage = 'switch and save';
    await appearance();
    await expect(option('实色')).toHaveAttribute('aria-pressed', 'true');
    assert.deepEqual(await blurLayers(page), []);
    await option('玻璃').click();
    await expect(root()).toHaveAttribute('data-material', 'glass');
    await expect(option('玻璃')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await bootstrap()).state.settings.material).toBe('glass');
    await closeSettings();
    report.stage = 'restart';
    await closeApp(app);
    await launch();
    await expect(root()).toHaveAttribute('data-material', 'glass');
    assert.equal((await bootstrap()).state.settings.material, 'glass');
    report.restartedWithGlass = true;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const panel = page.locator('.turn-panel');
    await page.locator('.turn-rail').hover();
    await expect(panel).toHaveCSS('opacity', '1');
    await panel.evaluate((element) => {
      const sample = (event) => {
        if (event.target !== element || event.propertyName !== 'opacity') return;
        element.dataset.filterDuringFade = getComputedStyle(element).backdropFilter;
        element.removeEventListener('transitionstart', sample);
      };
      element.addEventListener('transitionstart', sample);
    });
    await page.mouse.move(1, 1);
    await expect(panel).toHaveAttribute('data-filter-during-fade', 'blur(18px) saturate(1.6)');
    await expect(panel).toHaveCSS('backdrop-filter', 'none');

    // 2. 先查主工作区，再查菜单和弹窗，防止只测到四个常驻表面。
    const trigger = page.locator('.sidebar-view-trigger');
    const menu = page.getByRole('menu', { name: '侧栏显示方式' });
    for (const [label, theme, scheme] of [
      ['light', '浅色', 'light'],
      ['dark', '深色', 'dark'],
      ['system-light', '跟随系统', 'light'],
      ['system-dark', '跟随系统', 'dark'],
    ]) {
      report.stage = `theme ${label}`;
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await appearance();
      await settings().getByRole('button', { name: theme, exact: true }).click();
      await expect(root()).toHaveAttribute('data-theme', label.startsWith('system') ? 'system' : label);
      await expect(settings()).toHaveCSS('backdrop-filter', 'blur(18px) saturate(1.6)');
      const dialogLayers = await blurLayers(page);
      assert.ok(dialogLayers.length <= 5, `${label} dialog: ${dialogLayers.join(', ')}`);
      const modal = await sampleContrast(page, { modal: settings().locator('h2') });
      await closeSettings();
      const input = page.getByRole('textbox', { name: '任务输入' });
      await input.fill('确认登录校验和相关测试。');
      await input.blur();
      const sidebarLayers = await blurLayers(page);
      assert.ok(sidebarLayers.some((layer) => layer.includes('.sidebar')));
      assert.ok(sidebarLayers.some((layer) => layer.includes('.workspace-header')));
      assert.ok(sidebarLayers.some((layer) => layer.includes('.composer')));
      if (process.platform !== 'darwin')
        assert.ok(sidebarLayers.some((layer) => layer.includes('.native-titlebar')));
      assert.ok(sidebarLayers.length <= 4, `${label} workspace: ${sidebarLayers.join(', ')}`);
      const reply = page.getByText('第 24 项已核对。', { exact: true });
      // The restored view can leave the reply mounted but clipped by the scroll container.
      await reply.scrollIntoViewIfNeeded();
      await expect(reply).toBeInViewport({ ratio: 1 });
      const contrast = await sampleContrast(page, {
        ...(process.platform === 'darwin' ? {} : { titlebar: page.locator('.native-titlebar-title') }),
        sidebar: page.locator('.sidebar-brand-label'),
        sidebarIcon: trigger.locator('svg'),
        workspaceHeader: page.locator('.workspace-title h1'),
        workspaceBreadcrumb: page.locator('.workspace-title .breadcrumb'),
        composer: input,
        reply,
      });
      if (label === 'light' || label === 'dark') await capture(label);
      await trigger.click();
      await expect(menu).toHaveCSS('backdrop-filter', 'blur(18px) saturate(1.6)');
      const menuLayers = await blurLayers(page);
      assert.equal(menuLayers.length, sidebarLayers.length + 1);
      assert.ok(menuLayers.length <= 5, `${label} menu: ${menuLayers.join(', ')}`);
      const popup = await sampleContrast(page, {
        popup: menu.getByText('分组', { exact: true }),
      });
      report.themes[label] = {
        sidebarLayers,
        menuLayers,
        dialogLayers,
        contrast: [...contrast, ...popup, ...modal],
      };
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    }

    report.stage = 'resize';
    const handle = page.getByRole('separator', { name: '项目侧栏宽度' });
    const bounds = await handle.boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 32, y, { steps: 4 });
    await expect(root()).toHaveAttribute('data-resizing', '');
    assert.deepEqual(await blurLayers(page, true), []);
    await page.evaluate(() => {
      document.addEventListener(
        'pointerup',
        () => {
          const root = document.documentElement;
          const start = performance.now();
          globalThis.glassResizeRecovery = new Promise((resolve) => {
            const observer = new MutationObserver(() => {
              if (root.hasAttribute('data-resizing')) return;
              observer.disconnect();
              resolve(performance.now() - start);
            });
            observer.observe(root, { attributes: true, attributeFilter: ['data-resizing'] });
          });
        },
        { capture: true, once: true },
      );
    });
    await page.mouse.up();
    await expect.poll(async () => root().getAttribute('data-resizing')).toBeNull();
    await expect.poll(async () => (await blurLayers(page)).length).toBeGreaterThan(0);
    const recoveryMs = await page.evaluate(() => globalThis.glassResizeRecovery);
    assert.ok(recoveryMs >= 140, `Blur resumed only ${recoveryMs} ms after pointer release`);
    report.resize = { blurredDuringDrag: 0, recoveryMs };

    // 3. 模拟能力变化时应保留用户选择，真实媒体查询由 Chromium 更新。
    report.stage = 'fallbacks';
    await appearance();
    const checkFallback = async (reason) => {
      await expect(settings().locator('[data-material-status]')).toHaveText(reason);
      await expect(option('玻璃')).toHaveAttribute('aria-pressed', 'true');
      await expect(root()).not.toHaveAttribute('data-material', 'glass');
      assert.deepEqual(await blurLayers(page, true), []);
      report.fallbacks.push(reason);
    };
    await changeEnvironment({ ...usable, gpuCompositing: false });
    await checkFallback('当前设备未启用显卡加速，已改用实色');
    await changeEnvironment(usable);
    await expect(root()).toHaveAttribute('data-material', 'glass');
    // Playwright's public emulateMedia options do not expose reduced transparency.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    assert.equal(
      await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches),
      true,
    );
    await checkFallback('系统已开启降低透明度');
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
    });
    await expect(root()).toHaveAttribute('data-material', 'glass');
    const powerOption = settings().getByRole('checkbox', { name: '使用电池时改用实色' });
    await expect(powerOption).toBeChecked();
    await changeEnvironment({ ...usable, onBattery: true });
    await checkFallback('使用电池时已改用实色');
    await powerOption.uncheck();
    await expect(root()).toHaveAttribute('data-material', 'glass');
    await powerOption.check();
    await expect(root()).not.toHaveAttribute('data-material', 'glass');
    await changeEnvironment(usable);
    await expect(root()).toHaveAttribute('data-material', 'glass');

    for (const theme of ['护眼米黄', '豆沙绿', '深蓝']) {
      await settings().getByRole('button', { name: theme, exact: true }).click();
      await expect(option('玻璃')).toBeDisabled();
      await expect(option('玻璃')).toHaveAttribute('title', '这套主题只支持实色');
      await expect(root()).not.toHaveAttribute('data-material', 'glass');
    }
    await settings().getByRole('button', { name: '浅色', exact: true }).click();
    await option('实色').click();
    await expect.poll(async () => (await bootstrap()).state.settings.material ?? 'solid').toBe('solid');
    await expect(root()).not.toHaveAttribute('data-material', 'glass');
    assert.deepEqual(await blurLayers(page, true), []);
    assert.deepEqual(errors, []);
    for (const [theme, values] of Object.entries(report.themes))
      for (const { label, samples, minimum } of values.contrast)
        assert.ok(
          samples > 0 && minimum >= 4.5,
          `${theme} ${label}: ${samples} samples, ${minimum.toFixed(3)}:1`,
        );
    report.stage = 'passed';
    console.log(`UI20 glass checks passed. Evidence: ${output}`);
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    try {
      await closeApp(app);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 4 });
    }
  }
}

if (import.meta.main) await verifyGlassUI(process.argv.includes('--screenshots-only'));
