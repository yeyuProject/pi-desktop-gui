// Isolated renderer regressions: real React controls with deterministic, delayed IPC.
// No Pi process, credentials, provider requests, or user configuration are touched.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import http from 'node:http';
import path from 'node:path';

const bundle = await build({
  stdin: {
    contents: `
      import React, { act, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { PiFeatures } from './src/PiFeatures';
      import { emptyRuntime } from './shared/types';
      const root = createRoot(document.getElementById('root'));
      let generation = 0;
      function Harness({ initial, generation }) {
        const [props, setProps] = useState(initial);
        window.updateFeature = (patch) => setProps((previous) => ({ ...previous, ...patch }));
        return <div data-feature-generation={generation}><PiFeatures {...props} /></div>;
      }
      window.idleRuntime = { ...emptyRuntime(), sessionId: 'settings-test', connected: true };
      window.mountFeature = (overrides = {}) => {
        const initial = {
          session: { id: 'settings-test', projectId: 'project', title: '设置测试', draft: '', attachments: [], updatedAt: 1, lastStatus: 'idle' },
          runtime: window.idleRuntime,
          initialTab: 'settings', close: () => {}, projectEnabled: true,
          storage: { writable: true },
          environment: { supported: true, compatibility: 'verified', version: '1.1.0', piPath: '/pi', agentDir: '/agent', authExists: false, modelsExist: false, errors: [] },
          ...overrides,
        };
        const next = ++generation;
        root.render(<Harness key={next} generation={next} initial={initial} />);
        return next;
      };
      // Drain the actual React work caused by a held IPC response, including rejected Promise.all reads.
      window.actFeature = async (action) => {
        const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        try {
          await act(action);
        } finally {
          globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
        }
      };
      window.releaseFeature = (key) => window.actFeature(async () => { window.mock.release(key); });
      window.clickActiveFeatureTab = (label) => window.actFeature(async () => {
        const button = [...document.querySelectorAll('nav button')].find((button) => button.textContent === label);
        if (!button || button.disabled || !button.classList.contains('active')) throw new Error('Expected enabled active tab: ' + label);
        button.click();
      });
    `,
    resolveDir: path.resolve('.'),
    loader: 'tsx',
    sourcefile: 'pi-settings-regression.tsx',
  },
  bundle: true,
  write: false,
  outdir: 'unused',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' },
});
if (process.argv.includes('--bundle-only')) {
  console.log('PASS Pi settings browser regression bundle');
  process.exit(0);
}
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
const server = http.createServer((request, response) => {
  if (request.url === '/test.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(js);
  } else if (request.url === '/test.css') {
    response.setHeader('content-type', 'text/css');
    response.end(css);
  } else {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/test.css"><div id="root"></div><script src="/test.js"></script>',
    );
  }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.PI_DESKTOP_BROWSER || undefined });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const mock = (window.mock = {
      calls: [],
      holds: [],
      waiting: [],
      failScope: false,
      failReads: [],
      failSave: false,
      providers: [
        { id: 'key-only', name: 'API Key provider', oauth: false, apiKey: true },
        { id: 'oauth-only', name: 'OAuth provider', oauth: true, apiKey: false },
        { id: 'minimax', name: 'MiniMax', authSource: 'environment', oauth: false, apiKey: true },
        { id: 'custom', name: 'Custom', authSource: 'models_json_key', oauth: false, apiKey: true },
      ],
      independentAuth: { minimax: 'environment', custom: 'models_json_key' },
      result: { applied: true },
      documents: {
        'settings:false': { retry: { enabled: true }, untouched: 'preserve me' },
        'settings:true': { retry: { enabled: false }, projectOnly: true },
        'models:false': { providers: {} },
        'mcp:false': { mcpServers: { demo: { command: 'demo', enabled: true } } },
      },
      release(key) {
        const index = this.waiting.findIndex((entry) => entry.key === key);
        if (index < 0) throw new Error('No pending IPC: ' + key);
        this.waiting.splice(index, 1)[0].resolve();
      },
    });
    window.desktop = {
      platform: 'linux',
      invoke: async (method, ...args) => {
        mock.calls.push({ method, args });
        const key =
          method + (method === 'configRead' || method === 'configSave' ? ':' + args[1] + ':' + args[2] : '');
        const value =
          method === 'configRead'
            ? {
                text: JSON.stringify(mock.documents[args[1] + ':' + args[2]] ?? {}),
                path: (args[2] ? '/project/.pi/' : '/agent/') + args[1] + '.json',
                revision: 'revision',
              }
            : undefined;
        if (mock.holds.includes(key)) {
          await new Promise((resolve) => mock.waiting.push({ key, resolve }));
        }
        if (method === 'configRead') {
          if (mock.failScope && args[2]) throw new Error('项目配置读取失败');
          if (mock.failReads.includes(key)) throw new Error('配置重新读取失败');
          return value;
        }
        if (method === 'configSave') {
          if (mock.failSave) throw new Error('写入失败');
          mock.documents[args[1] + ':' + args[2]] = JSON.parse(args[3].text);
          return mock.result;
        }
        if (method === 'providers') return mock.providers.map((provider) => ({ ...provider }));
        if (method === 'login' || method === 'logout') {
          mock.providers.find((provider) => provider.id === args[1]).authSource =
            method === 'login' ? 'stored' : mock.independentAuth[args[1]];
        }
        if (method === 'resources') return { resources: [], tools: [], activeTools: [], packages: [] };
        if (method === 'sessionTree') return [];
        if (method === 'usageSummary') {
          const period = { tokens: 0, cost: 0, missingTokens: 0, missingCost: 0, projects: [] };
          return { today: period, week: period, all: period };
        }
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Boolean(window.mountFeature));
  const tabLabels = {
    settings: '完整 Pi 设置',
    providers: '供应商与登录',
    mcp: 'MCP 服务器',
    prefs: '常用设置',
  };
  const mount = async (props = {}) => {
    const generation = await page.evaluate((props) => window.mountFeature(props), props);
    // root.render schedules work; an existing enabled field can belong to the preceding generation.
    await expect(page.locator('[data-feature-generation]')).toHaveAttribute(
      'data-feature-generation',
      String(generation),
    );
    await expect(nav(tabLabels[props.initialTab ?? 'settings'])).toHaveClass('active');
  };
  const modal = page.getByRole('dialog', { name: 'Pi 功能' });
  const json = modal.getByRole('textbox', { name: 'Pi 配置 JSON' });
  const nav = (name) => modal.locator('nav').getByRole('button', { name, exact: true });
  const readyJson = async (kind) => {
    await expect(json).toBeEnabled();
    await expect(modal.locator('.config-editor .settings-copy')).toContainText(kind + '.json');
  };
  const clickActiveTab = async (label) => {
    const reads = await page.evaluate(
      () => window.mock.calls.filter((call) => call.method === 'configRead').length,
    );
    // The no-op assertion must inspect the committed result, not the old value before a click update.
    await page.evaluate((label) => window.clickActiveFeatureTab(label), label);
    assert.equal(
      await page.evaluate(() => window.mock.calls.filter((call) => call.method === 'configRead').length),
      reads,
    );
  };
  await mount();
  await readyJson('settings');
  const original = await json.inputValue();
  await clickActiveTab('完整 Pi 设置');
  await expect(json).toHaveValue(original);
  await expect(json).toBeEnabled();
  await json.fill('{"retry":{"enabled":false},"untouched":"preserve me"}');
  await expect(nav('常用设置')).toBeDisabled();
  await page.evaluate(() => {
    window.mock.holds = ['configSave:settings:false'];
  });
  await modal.getByRole('button', { name: '保存并应用', exact: true }).click();
  await page.waitForFunction(() => window.mock.waiting.length === 1);
  await expect(json).toBeDisabled();
  await expect(nav('常用设置')).toBeDisabled();
  await page.evaluate(() => {
    window.mock.holds = [];
  });
  await page.evaluate(() => window.releaseFeature('configSave:settings:false'));
  await modal.getByText('已保存并重新连接 Pi。原配置已备份。', { exact: true }).waitFor();
  await expect(nav('常用设置')).toBeEnabled();
  console.log(
    'PASS same-tab click preserves document; save locks edits/navigation and unlocks after completion',
  );

  await mount({
    initialTab: 'prefs',
    runtime: { ...(await page.evaluate(() => window.idleRuntime)), status: 'running' },
  });
  const retry = modal.getByRole('checkbox', { name: '临时错误自动重试' });
  await expect(retry).toBeEnabled();
  await retry.check();
  await expect(nav('常用设置')).toBeDisabled();
  const formSave = modal.getByRole('button', { name: '保存并重新加载', exact: true });
  await expect(formSave).toBeEnabled();
  await page.evaluate(() => {
    window.mock.result = { applied: false, deferred: true };
  });
  await formSave.click();
  await modal.getByText(/配置已保存并备份.*相关会话空闲后加载/).waitFor();
  await page.evaluate(() => {
    window.mock.result = { applied: true };
  });
  await expect(retry).toBeEnabled();
  await expect(nav('常用设置')).toBeEnabled();
  const saved = await page.evaluate(() => window.mock.documents['settings:false']);
  assert.equal(saved.retry.enabled, true);
  assert.equal(saved.untouched, 'preserve me');
  console.log('PASS running tasks permit saving and explain deferred application');

  await page.evaluate(() => {
    window.mock.result = { applied: false, warning: '请检查 Pi 入口' };
  });
  await mount({
    environment: { supported: false },
    runtime: { ...(await page.evaluate(() => window.idleRuntime)), connected: false },
  });
  await readyJson('settings');
  await modal.getByText(/运行环境.*重新检测/).waitFor();
  await json.fill('{"offline":true}');
  await modal.getByRole('button', { name: '保存并应用', exact: true }).click();
  await modal.getByText(/配置已保存.*尚未应用到 Pi.*请检查 Pi 入口/).waitFor();
  await expect(nav('常用设置')).toBeEnabled();
  console.log('PASS missing Pi permits offline configuration and accurately reports saved-but-not-applied');

  await page.evaluate(() => {
    window.mock.holds = ['configRead:settings:false'];
  });
  await mount();
  await page.waitForFunction(() =>
    window.mock.waiting.some((entry) => entry.key === 'configRead:settings:false'),
  );
  await expect(modal.getByRole('combobox', { name: '配置范围' })).toBeDisabled();
  await expect(nav('MCP 服务器')).toBeEnabled();
  await nav('MCP 服务器').click();
  await expect(nav('MCP 服务器')).toHaveClass('active');
  await readyJson('mcp');
  await expect(json).toHaveValue(/mcpServers/);
  await page.evaluate(() => {
    window.mock.holds = [];
  });
  await page.evaluate(() => window.releaseFeature('configRead:settings:false'));
  await expect(json).toHaveValue(/mcpServers/);
  console.log(
    'PASS delayed old-tab reads cannot overwrite the current document; scope locked until read completes',
  );

  await mount();
  await readyJson('settings');
  const personal = await json.inputValue();
  await page.evaluate(() => {
    window.mock.failScope = true;
  });
  await modal.getByRole('combobox', { name: '配置范围' }).selectOption('project');
  await modal.getByRole('alert').filter({ hasText: '项目配置读取失败' }).waitFor();
  await expect(modal.getByRole('combobox', { name: '配置范围' })).toHaveValue('user');
  await expect(json).toHaveValue(personal);
  await page.evaluate(() => {
    window.mock.holds = ['configRead:settings:false'];
  });
  await modal.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.waitForFunction(() =>
    window.mock.waiting.some((entry) => entry.key === 'configRead:settings:false'),
  );
  await expect(json).toBeDisabled();
  await expect(modal.getByRole('combobox', { name: '配置范围' })).toBeDisabled();
  await page.evaluate(() => {
    window.mock.holds = [];
    window.mock.failScope = false;
  });
  await page.evaluate(() => window.releaseFeature('configRead:settings:false'));
  await readyJson('settings');
  await modal.getByRole('combobox', { name: '配置范围' }).selectOption('project');
  await expect(modal.getByRole('combobox', { name: '配置范围' })).toHaveValue('project');
  await expect(json).toHaveValue(/projectOnly/);
  console.log(
    'PASS failed scope read preserves both scope and document; successful retry changes them together',
  );

  await page.evaluate(() => {
    window.mock.holds = ['providers'];
  });
  await mount({ initialTab: 'providers' });
  await page.waitForFunction(() => window.mock.waiting.some((entry) => entry.key === 'providers'));
  await readyJson('models');
  await expect(nav('常用设置')).toBeEnabled();
  await page.evaluate(() => {
    window.mock.holds = [];
  });
  await page.evaluate(() => window.releaseFeature('providers'));
  await modal.getByRole('combobox', { name: '登录供应商' }).selectOption('key-only');
  await expect(modal.getByRole('button', { name: '浏览器登录', exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: '浏览器登录', exact: true })).toHaveAttribute(
    'title',
    /不支持/,
  );
  await expect(modal.getByRole('button', { name: '设置 API Key', exact: true })).toBeEnabled();
  await json.fill('{"providers":{},"unsavedProviderEdit":true}');
  await modal.getByRole('button', { name: '设置 API Key', exact: true }).click();
  await modal.getByText('凭据已保存', { exact: true }).waitFor();
  const providerSelect = modal.getByRole('combobox', { name: '登录供应商' });
  await expect(providerSelect.locator('option:checked')).toHaveText('API Key provider · 已保存凭据');
  await expect(json).toHaveValue(/unsavedProviderEdit/);
  await expect(nav('常用设置')).toBeDisabled();
  await modal.getByRole('button', { name: '放弃修改并重新读取', exact: true }).click();
  await readyJson('models');
  const logout = modal.getByRole('button', { name: '退出登录', exact: true });
  await logout.click();
  await expect(providerSelect.locator('option:checked')).toHaveText('API Key provider · 未配置');
  for (const [id, label] of [
    ['minimax', 'MiniMax · 环境变量凭据'],
    ['custom', 'Custom · models.json 凭据'],
  ]) {
    await providerSelect.selectOption(id);
    await expect(providerSelect.locator('option:checked')).toHaveText(label);
    await modal.getByRole('button', { name: '设置 API Key', exact: true }).click();
    await expect(providerSelect.locator('option:checked')).toHaveText(/已保存凭据/);
    await logout.click();
    await expect(providerSelect.locator('option:checked')).toHaveText(label);
    await expect(modal.locator('.feature-notice')).toContainText('当前来源显示在供应商名称后');
  }
  console.log(
    'PASS logout clears saved credentials and identifies remaining environment/models.json sources',
  );
  await nav('命令与快捷键').click();
  await modal.getByText(/终端主题.*尚未在桌面实现/).waitFor();
  console.log(
    'PASS slow provider lookup leaves local config usable; provider prerequisites and unsupported terminal UI explained',
  );
  for (const [initialTab, label] of [
    ['settings', '完整 Pi 设置'],
    ['providers', '供应商与登录'],
    ['mcp', 'MCP 服务器'],
  ]) {
    await mount({ initialTab });
    await readyJson(initialTab === 'providers' ? 'models' : initialTab);
    const before = await json.inputValue();
    await clickActiveTab(label);
    await expect(nav(label)).toHaveClass('active');
    await expect(json).toHaveValue(before);
    await expect(json).toBeEnabled();
  }
  console.log('PASS repeated active settings, providers and MCP tabs retain their documents');

  await mount();
  await readyJson('settings');
  await json.fill('{"savedAfterRetry":true}');
  await page.evaluate(() => {
    window.mock.failSave = true;
  });
  await modal.getByRole('button', { name: '保存并应用', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: '写入失败' }).waitFor();
  await expect(json).toHaveValue(/savedAfterRetry/);
  await expect(nav('常用设置')).toBeDisabled();
  await page.evaluate(() => {
    window.mock.failSave = false;
    window.mock.failReads = ['configRead:settings:false'];
  });
  await modal.getByRole('button', { name: '保存并应用', exact: true }).click();
  await modal.getByText(/配置已保存.*尚未应用到 Pi/).waitFor();
  await modal.getByRole('alert').filter({ hasText: '配置重新读取失败' }).waitFor();
  await expect(json).toBeDisabled();
  await expect(modal.getByRole('button', { name: '保存并应用', exact: true })).toBeDisabled();
  await expect(nav('常用设置')).toBeEnabled();
  await page.evaluate(() => {
    window.mock.failReads = [];
  });
  await modal.getByRole('button', { name: '重试读取', exact: true }).click();
  await readyJson('settings');
  await expect(json).toHaveValue(/savedAfterRetry/);
  console.log(
    'PASS write failure keeps edits; post-save read failure keeps saved notice and prevents stale-revision resave',
  );

  await page.evaluate(() => {
    window.mock.documents['settings:false'] = { retry: { enabled: true }, untouched: 'preserve me' };
    window.mock.result = { applied: true };
  });
  await mount({ initialTab: 'prefs' });
  await expect(retry).toBeEnabled();
  const projectScope = modal.getByRole('radio', { name: '仅当前项目', exact: true });
  const personalScope = modal.getByRole('radio', { name: '个人（所有项目）', exact: true });
  await page.evaluate(() => {
    window.mock.failScope = true;
  });
  await projectScope.click();
  await modal.getByRole('alert').filter({ hasText: '项目配置读取失败' }).waitFor();
  await expect(personalScope).toHaveAttribute('aria-checked', 'true');
  await expect(retry).toBeChecked();
  await page.evaluate(() => {
    window.mock.failScope = false;
    window.mock.holds = ['configRead:settings:true'];
  });
  await projectScope.click();
  await page.waitForFunction(() =>
    window.mock.waiting.some((entry) => entry.key === 'configRead:settings:true'),
  );
  await expect(retry).toBeDisabled();
  await expect(nav('MCP 服务器')).toBeEnabled();
  await nav('MCP 服务器').click();
  await expect(nav('MCP 服务器')).toHaveClass('active');
  await readyJson('mcp');
  await page.evaluate(() => {
    window.mock.holds = [];
    window.mock.failScope = true;
  });
  await page.evaluate(() => window.releaseFeature('configRead:settings:true'));
  await expect(json).toHaveValue(/mcpServers/);
  await expect(modal.getByRole('alert')).toHaveCount(0);
  console.log(
    'PASS common-settings failed scope remains personal; late errors after navigation cannot affect the new page',
  );

  await page.evaluate(() => {
    window.mock.failScope = false;
  });
  await mount({ initialTab: 'prefs' });
  await expect(retry).toBeEnabled();
  await projectScope.click();
  await expect(projectScope).toHaveAttribute('aria-checked', 'true');
  await expect(retry).not.toBeChecked();
  await retry.check();
  await page.evaluate(() => {
    window.mock.failReads = ['configRead:settings:true'];
  });
  await formSave.click();
  await modal.getByText('设置已保存，Pi 已重新加载。原文件已备份。', { exact: true }).waitFor();
  await modal.getByRole('alert').filter({ hasText: '配置重新读取失败' }).waitFor();
  await expect(retry).toBeDisabled();
  await expect(formSave).toBeDisabled();
  await expect(nav('MCP 服务器')).toBeEnabled();
  await page.evaluate(() => {
    window.mock.failReads = [];
  });
  await modal.getByRole('button', { name: '重新读取设置', exact: true }).click();
  await expect(retry).toBeEnabled();
  await expect(retry).toBeChecked();
  await expect(projectScope).toHaveAttribute('aria-checked', 'true');
  console.log('PASS common-settings save/read failure preserves saved status, scope and safe retry');

  for (const props of [{ storage: { writable: false } }]) {
    await mount(props);
    await readyJson('settings');
    await json.fill('{"safeLocalEdit":true}');
    await expect(nav('常用设置')).toBeDisabled();
    await expect(modal.getByRole('button', { name: '保存并应用', exact: true })).toBeDisabled();
  }
  await mount({
    runtime: { ...(await page.evaluate(() => window.idleRuntime)), crash: { cleanup: 'unconfirmed' } },
  });
  await readyJson('settings');
  await json.fill('{"repairConfiguration":true}');
  await expect(modal.getByRole('button', { name: '保存并应用', exact: true })).toBeEnabled();
  const providerCalls = await page.evaluate(
    () => window.mock.calls.filter((call) => call.method === 'providers').length,
  );
  await mount({ initialTab: 'providers', projectEnabled: false });
  await readyJson('models');
  await expect(modal.getByRole('button', { name: '设置 API Key', exact: true })).toBeDisabled();
  assert.equal(
    await page.evaluate(() => window.mock.calls.filter((call) => call.method === 'providers').length),
    providerCalls,
  );
  await mount({ projectEnabled: false });
  await readyJson('settings');
  const scope = modal.getByRole('combobox', { name: '配置范围' });
  const projectOption = scope.locator('option[value="project"]');
  // Playwright 1.64 disabled-state checks follow the enclosing label to its enabled select.
  // Inspect the option itself, then exercise the browser's native keyboard selection instead.
  await expect(projectOption).toHaveAttribute('disabled', '');
  await expect(projectOption).toHaveJSProperty('disabled', true);
  await expect(scope).toBeEnabled();
  await expect(scope).toHaveValue('user');
  const projectReads = await page.evaluate(
    () => window.mock.calls.filter((call) => call.method === 'configRead' && call.args[2] === true).length,
  );
  await scope.press('ArrowDown');
  await scope.press('End');
  await scope.press('Tab');
  await expect(scope).toHaveValue('user');
  assert.equal(
    await page.evaluate(
      () => window.mock.calls.filter((call) => call.method === 'configRead' && call.args[2] === true).length,
    ),
    projectReads,
  );
  await json.fill('{"personalOfflineEdit":true}');
  await expect(modal.getByRole('button', { name: '保存并应用', exact: true })).toBeEnabled();
  console.log(
    'PASS read-only storage blocks writes, process recovery permits configuration repair, and project trust protections remain',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
