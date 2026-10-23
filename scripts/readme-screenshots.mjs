import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startReadmeServer } from './readme-server.mjs';

// Renders the built UI with a mocked window.desktop to produce README screenshots. Run `npm run build` first.
const outDir = path.resolve(process.argv[2] ?? 'docs/assets/screenshots');
fs.mkdirSync(outDir, { recursive: true });

const mock = ({ theme, approval }) => {
  const now = Date.now();
  const t0 = now - 90_000;
  const patch = [
    '--- a/src/auth/validate.ts',
    '+++ b/src/auth/validate.ts',
    '@@ -8,9 +8,12 @@ export function validateLogin(form: LoginForm): ValidationResult {',
    '   const errors: ValidationResult = {};',
    '-  if (form.email == null) {',
    "+  const email = form.email?.trim() ?? '';",
    '+  if (!email) {',
    "     errors.email = '请输入邮箱';",
    '+  } else if (!EMAIL_PATTERN.test(email)) {',
    "+    errors.email = '邮箱格式不正确';",
    '   }',
    '   if (!form.password) {',
    "     errors.password = '请输入密码';",
  ].join('\n');
  const testPatch = [
    '--- a/tests/validate.test.ts',
    '+++ b/tests/validate.test.ts',
    "@@ -20,3 +20,11 @@ describe('validateLogin', () => {",
    '     expect(validateLogin(valid)).toEqual({});',
    '   });',
    '+',
    "+  it('rejects blank email', () => {",
    "+    expect(validateLogin({ ...valid, email: '   ' }).email).toBe('请输入邮箱');",
    '+  });',
    '+',
    "+  it('rejects malformed email', () => {",
    "+    expect(validateLogin({ ...valid, email: 'a@' }).email).toBe('邮箱格式不正确');",
    '+  });',
    ' });',
  ].join('\n');
  const model = {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    reasoning: true,
    contextWindow: 200000,
    input: ['text', 'image'],
  };
  const messages = [
    {
      role: 'user',
      content: '登录页提交空格邮箱时没有报错，帮我修一下 @src/auth/validate.ts，并补上测试。',
      timestamp: t0,
    },
    {
      role: 'assistant',
      timestamp: t0 + 4000,
      content: [
        { type: 'thinking', thinking: '先读取校验函数，确认当前只判断了 null，没有处理空白字符串和格式。' },
        { type: 'text', text: '先看一下当前的校验逻辑。' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/auth/validate.ts' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'read',
      content: 'export function validateLogin(form: LoginForm) { ... }',
      timestamp: t0 + 5000,
    },
    {
      role: 'assistant',
      timestamp: t0 + 9000,
      content: [
        {
          type: 'text',
          text: '问题在于只判断了 `null`，`"   "` 会直接通过。改为先 `trim()`，再补一条格式校验。',
        },
        { type: 'toolCall', id: 't2', name: 'edit', arguments: { path: 'src/auth/validate.ts' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 't2',
      toolName: 'edit',
      content: 'Successfully replaced text in src/auth/validate.ts.',
      timestamp: t0 + 10000,
    },
    {
      role: 'assistant',
      timestamp: t0 + 14000,
      content: [{ type: 'toolCall', id: 't3', name: 'edit', arguments: { path: 'tests/validate.test.ts' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 't3',
      toolName: 'edit',
      content: 'Successfully replaced text in tests/validate.test.ts.',
      timestamp: t0 + 15000,
    },
    {
      role: 'assistant',
      timestamp: t0 + 18000,
      content: [{ type: 'toolCall', id: 't4', name: 'bash', arguments: { command: 'npm test -- validate' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 't4',
      toolName: 'bash',
      content:
        ' ✓ tests/validate.test.ts (6 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)',
      timestamp: t0 + 22000,
    },
    {
      role: 'assistant',
      timestamp: t0 + 26000,
      content:
        '已修复，6 个测试全部通过。\n\n- `validate.ts`：邮箱先去除首尾空白再判断，并新增格式校验\n- `validate.test.ts`：补充空白邮箱和格式错误两个用例\n\n如果希望错误文案和设计稿一致，可以把文案集中到 `messages.ts`。',
    },
  ];
  const tools = [
    {
      id: 't1',
      name: 'read',
      args: { path: 'src/auth/validate.ts' },
      status: 'done',
      output: '',
      startedAt: t0 + 4000,
      durationMs: 40,
    },
    {
      id: 't2',
      name: 'edit',
      args: { path: 'src/auth/validate.ts' },
      status: 'done',
      output: 'Successfully replaced text in src/auth/validate.ts.',
      startedAt: t0 + 9000,
      durationMs: 60,
      patch,
    },
    {
      id: 't3',
      name: 'edit',
      args: { path: 'tests/validate.test.ts' },
      status: 'done',
      output: 'Successfully replaced text in tests/validate.test.ts.',
      startedAt: t0 + 14000,
      durationMs: 50,
      patch: testPatch,
    },
    {
      id: 't4',
      name: 'bash',
      args: { command: 'npm test -- validate' },
      status: 'done',
      output:
        ' ✓ tests/validate.test.ts (6 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)',
      startedAt: t0 + 18000,
      durationMs: 3400,
    },
  ];
  const project = {
    id: 'p1',
    name: 'acme-web',
    path: '/home/dev/acme-web',
    trusted: true,
    createdAt: t0 - 1e8,
  };
  const project2 = {
    id: 'p2',
    name: 'docs-site',
    path: '/home/dev/docs-site',
    trusted: true,
    createdAt: t0 - 2e8,
  };
  const mk = (id, title, projectId, ago, extra = {}) => ({
    id,
    projectId,
    title,
    draft: '',
    attachments: [],
    updatedAt: now - ago,
    lastStatus: 'completed',
    model: { provider: 'anthropic', id: 'claude-sonnet-5' },
    approvalMode: 'auto',
    ...extra,
  });
  const sessions = [
    mk('s1', '修复登录表单的空邮箱校验', 'p1', 1000, { stats: { tokens: 18420, cost: 0.06 } }),
    mk('s2', '梳理路由与权限中间件', 'p1', 3.6e6),
    mk('s3', '为结算页补充 E2E 测试', 'p1', 8.6e7),
    mk('s4', '迁移到新版文档主题', 'p2', 2e8),
    mk('s5', '解释一下 CRDT 的基本原理', undefined, 5e6),
  ];
  const settings = {
    piPath: 'pi',
    nodePath: 'node',
    agentDir: '~/.pi/agent',
    editorPath: '',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    thinking: 'medium',
    theme,
    fontScale: 1,
    sidebarWidth: 248,
    inspectorWidth: 400,
    inspectorSplit: 34,
    onboardingDone: true,
    notifyOnFinish: false,
    autoDownloadUpdates: true,
  };
  const runtime = {
    sessionId: 's1',
    status: 'completed',
    messages,
    tools,
    steering: [],
    followUp: [],
    dialogs: [],
    notices: [],
    widgets: {},
    statuses: {},
    models: [model],
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    model,
    thinking: 'medium',
    connected: true,
    cwd: project.path,
    stats: { tokens: 18420, cost: 0.06, contextPercent: 9, contextTokens: 18420, contextWindow: 200000 },
    diagnostic: [],
    commands: [],
    approvalMode: 'auto',
    approvalGrants: [],
  };
  const changes = {
    git: true,
    checkpoints: [],
    branch: 'fix/login-email',
    head: 'a1b2c3d',
    baselineAvailable: true,
    omitted: [],
    files: [
      {
        path: 'src/auth/validate.ts',
        status: '修改',
        staged: false,
        unstaged: true,
        existedBeforeRun: false,
      },
      {
        path: 'tests/validate.test.ts',
        status: '修改',
        staged: false,
        unstaged: true,
        existedBeforeRun: false,
      },
    ],
  };
  const files = [
    { path: 'src', name: 'src', directory: true },
    { path: 'tests', name: 'tests', directory: true },
    { path: 'package.json', name: 'package.json', directory: false, size: 1200 },
    { path: 'README.md', name: 'README.md', directory: false, size: 3200 },
  ];
  const state = {
    version: 1,
    appVersion: '0.14.0',
    projects: [project, project2],
    sessions,
    settings,
    selectedProjectId: 'p1',
    selectedSessionId: 's1',
  };
  const environment = {
    piPath: '/usr/local/bin/pi',
    version: '1.1.0',
    supported: true,
    compatibility: 'verified',
    nodePath: '/usr/local/bin/node',
    git: '2.47.0',
    bash: '/bin/bash',
    agentDir: '~/.pi/agent',
    authExists: true,
    modelsExist: true,
    errors: [],
  };
  const update = {
    state: 'idle',
    currentVersion: '0.14.0',
    installation: 'nsis',
    mode: 'auto',
    enabled: true,
    installing: false,
  };
  let stateRevision = 0;
  const handlers = {
    navigationState: () => structuredClone({ state, revision: ++stateRevision }),
    bootstrap: () =>
      structuredClone({
        state,
        revision: ++stateRevision,
        runtime,
        environment,
        dataDir: '/home/dev/.pi-desktop',
        storage: { writable: true },
        update,
      }),
    selectSession: () => messages,
    readHistory: () => messages,
    changes: () => changes,
    diff: (_p, file) => ({
      path: file,
      patch: file.includes('test') ? testPatch : patch,
      before: '',
      after: '',
    }),
    files: () => files,
    searchFiles: () => [],
    checkpoints: () => [],
    piSessions: () => [],
    sessionTree: () => [],
    attachmentInfo: () => [],
    projectRules: () => undefined,
    searchSessions: () => [],
    detect: () => environment,
    resources: () => ({ skills: [], prompts: [], extensions: [], themes: [], packages: [] }),
    providers: () => [],
    usageSummary: () => ({ days: [], total: { tokens: 0, cost: 0 } }),
  };
  if (approval) {
    messages.splice(messages.length - 1, 1);
    messages.splice(messages.length - 1, 1);
    tools[3] = { ...tools[3], status: 'running', output: '', durationMs: undefined };
    runtime.status = 'waiting';
    runtime.startedAt = now - 21000;
    runtime.approvalMode = 'confirm';
    sessions[0].approvalMode = 'confirm';
    sessions[0].lastStatus = 'waiting';
    runtime.tools = tools.slice(0, 3);
    runtime.dialogs = [
      {
        id: 'd1',
        method: 'select',
        title: '__PI_DESKTOP_APPROVAL__',
        options: ['允许一次', '本会话总是允许', '拒绝'],
        approval: {
          toolName: 'bash',
          kind: 'shell',
          summary: 'npm test -- validate',
          grant: { id: 'shell:npm test', kind: 'shell-prefix', toolName: 'bash', command: 'npm test' },
        },
      },
    ];
  }
  window.desktop = {
    platform: 'win32',
    invoke: async (method, ...args) => (handlers[method] ? handlers[method](...args) : undefined),
    onEvent: () => () => {},
    pathForFile: () => '',
  };
};

const server = await startReadmeServer();
let browser;
try {
  browser = await chromium.launch();
  const shots = [
    ['workspace-light', 'light', false],
    ['workspace-dark', 'dark', false],
    ['approval', 'light', true],
  ];
  for (const [name, theme, approval] of shots) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(mock, { theme, approval });
    await page.goto(server.url);
    await page.getByText('修复登录表单的空邮箱校验').first().waitFor();
    await page
      .getByRole('button', { name: /工作区/ })
      .first()
      .click();
    await page.locator('aside').getByText('src/auth/validate.ts').click();
    await page.locator('.preview-toolbar').waitFor();
    await page.waitForTimeout(800);
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
