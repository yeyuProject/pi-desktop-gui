import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startReadmeServer } from './readme-server.mjs';
import { workbenchFixture } from '../tests/support/workbench-fixture.mjs';

// Renders the built UI with a mocked window.desktop to produce README screenshots. Run `npm run build` first.
const outDir = path.resolve(process.argv[2] ?? 'docs/assets/screenshots');
fs.mkdirSync(outDir, { recursive: true });

const server = await startReadmeServer();
let browser;
try {
  browser = await chromium.launch();
  const shots = [
    ['workspace-light', 'light', false],
    ['workspace-dark', 'dark', false],
    ['approval', 'light', true],
    ['goal-composer', 'light', false],
    ['workspace-codex-light', 'light', false, 'codex'],
    ['workspace-codex-dark', 'dark', false, 'codex'],
    ['workspace-claude-light', 'light', false, 'claude'],
    ['workspace-claude-dark', 'dark', false, 'claude'],
  ];
  for (const [name, theme, approval, uiStyle = 'classic'] of shots) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(workbenchFixture, { theme, approval, uiStyle });
    await page.goto(server.url);
    await page.getByText('修复登录表单的空邮箱校验').first().waitFor();
    await page
      .getByRole('button', { name: /工作区/ })
      .first()
      .click();
    await page.locator('aside').getByText('src/auth/validate.ts').click();
    await page.locator('.preview-toolbar').waitFor();
    if (name === 'goal-composer') {
      await page.getByRole('button', { name: 'Goal 目标管理', exact: true }).click();
      await page
        .getByRole('textbox', { name: '任务输入' })
        .fill('完善登录校验与错误提示，补齐边界测试并确认全部通过。');
      await page.getByRole('button', { name: 'Goal 上限', exact: true }).click();
      await page.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption('500k');
      await page.getByRole('button', { name: '确定上限' }).click();
    }
    await page.waitForTimeout(800);
    if (uiStyle !== 'classic')
      await page.locator('.thread').evaluate((node) => {
        node.scrollTop = 0;
      });
    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log('wrote', path.join(outDir, `${name}.png`));
    await page.close();
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
