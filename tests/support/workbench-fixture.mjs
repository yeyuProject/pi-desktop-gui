export const workbenchFixture = ({ theme, approval, uiStyle = 'classic', goal = false, stress = false }) => {
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
      durationMs: 4000,
      usage: { output: 200, totalTokens: 1200 },
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
  if (stress) {
    const quote = {
      id: 'visual-quote',
      role: 'assistant',
      turn: 1,
      messageTimestamp: t0 + 26000,
      section: 'text',
    };
    const quoted = `> [引用 第 1 轮 Pi 回复](pi-quote:${encodeURIComponent(JSON.stringify(quote))})\n> ${'请确认邮箱的空白处理与错误提示。'.repeat(40)}`;
    const prompt = Array.from(
      { length: 20 },
      (_, i) => `${i + 1}. 检查登录输入：${'VeryLongInputWithoutSpaces'.repeat(8)}`,
    ).join('\n');
    messages[0].content = [
      {
        type: 'text',
        text: `<skill name="review" location="/fixture/SKILL.md">\n检查输入、测试和错误提示。\n\`\`\`js\nconst long = '${'x'.repeat(400)}';\n\`\`\`\n</skill>\n\n${quoted}\n\n${prompt}\n\n<project_file path="src/auth/${'long-directory/'.repeat(8)}validate.ts" lines="1-10">\n${'const input = "wide"; '.repeat(60)}\n</project_file>`,
      },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',
      },
    ];
    for (let i = 0; i < 5; i++)
      messages.push(
        { role: 'user', content: `继续核对第 ${i + 2} 项输入校验。`, timestamp: t0 + 30000 + i * 2000 },
        {
          role: 'assistant',
          content: `第 ${i + 2} 项已核对。\n\n\`\`\`js\nconst result = '${'wide_code_'.repeat(80)}'; // 测试\n\`\`\``,
          timestamp: t0 + 31000 + i * 2000,
        },
      );
  }
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
    uiStyle,
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
  if (goal) {
    messages[0].goalStart = true;
    runtime.goal = {
      id: 'visual-goal',
      revision: 1,
      status: goal === 'completed' ? 'completed' : 'paused',
      objective: '完善登录校验，补齐测试并确认修改结果。',
      tokensUsed: 18420,
      tokenBudget: 500000,
      continuations: 1,
      timeUsedMs: 21300,
      billedTokensUsed: 18420,
      costUsed: 0.06,
      createdAt: t0,
      updatedAt: now,
      plan: [
        { text: '检查登录表单校验', status: 'completed' },
        { text: '补充边界测试', status: 'completed' },
        { text: '核对修改结果', status: 'pending' },
      ],
    };
  }
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
    sideChatRead: () => ({
      sessionId: 's1',
      omittedTurns: 0,
      messages: [
        { id: 'side-q', role: 'user', content: '为什么要先 trim()？', timestamp: t0 + 27000 },
        {
          id: 'side-a',
          role: 'assistant',
          content: '先去掉首尾空白，再判断邮箱是否为空。这样只输入空格也会收到清楚的提示。',
          timestamp: t0 + 28000,
        },
      ],
    }),
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
          grant: {
            id: 'shell-exact:bash:npm test',
            kind: 'shell-exact',
            toolName: 'bash',
            command: 'npm test',
          },
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
