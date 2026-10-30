import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startReadmeServer } from './readme-server.mjs';

// Records docs/assets/screenshots/demo.gif from the built UI with a scripted, mocked window.desktop.
// Needs `npm run build` first and ffmpeg on PATH.
const output = path.resolve(process.argv[2] ?? 'docs/assets/screenshots/demo.gif');
const width = 1280;
const height = 800;
const fps = 15;

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
} catch {
  throw new Error('生成演示 GIF 需要 ffmpeg，请先安装并加入 PATH，再运行 npm run demo-gif。');
}

const mock = () => {
  const listeners = new Set();
  let stateRevision = 0;
  const emit = (event) => {
    if (event.type === 'state') event = { ...event, revision: ++stateRevision };
    listeners.forEach((listener) => listener(structuredClone(event)));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = Date.now();
  const model = {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    reasoning: true,
    contextWindow: 200000,
    input: ['text', 'image'],
  };
  const source = [
    'export function validateLogin(form: LoginForm): ValidationResult {',
    '  const errors: ValidationResult = {};',
    '  if (form.email == null) {',
    "    errors.email = '请输入邮箱';",
    '  }',
    '  if (!form.password) {',
    "    errors.password = '请输入密码';",
    '  }',
    '  return errors;',
    '}',
  ].join('\n');
  const patches = {
    'src/auth/validate.ts': [
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
    ].join('\n'),
    'tests/validate.test.ts': [
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
    ].join('\n'),
  };
  const testOutput =
    ' ✓ tests/validate.test.ts (6 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)';
  const reply =
    '已修复，6 个测试全部通过。\n\n- `validate.ts`：邮箱先去除首尾空白再判断，并新增格式校验\n- `validate.test.ts`：补充空白邮箱和格式错误两个用例';
  const mk = (id, title, projectId, ago) => ({
    id,
    projectId,
    title,
    draft: '',
    attachments: [],
    updatedAt: now - ago,
    lastStatus: 'completed',
    model: { provider: 'anthropic', id: 'claude-sonnet-5' },
    approvalMode: 'auto',
  });
  const state = {
    version: 1,
    appVersion: '0.14.0',
    projects: [
      { id: 'p1', name: 'acme-web', path: '/home/dev/acme-web', trusted: true, createdAt: now - 1e8 },
      { id: 'p2', name: 'docs-site', path: '/home/dev/docs-site', trusted: true, createdAt: now - 2e8 },
    ],
    sessions: [
      { ...mk('s1', '新对话', 'p1', 0), lastStatus: 'idle' },
      mk('s2', '梳理路由与权限中间件', 'p1', 3.6e6),
      mk('s3', '为结算页补充 E2E 测试', 'p1', 8.6e7),
      mk('s4', '迁移到新版文档主题', 'p2', 2e8),
      mk('s5', '解释一下 CRDT 的基本原理', undefined, 5e6),
    ],
    settings: {
      piPath: 'pi',
      nodePath: 'node',
      agentDir: '~/.pi/agent',
      editorPath: '',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      thinking: 'medium',
      theme: 'light',
      fontScale: 1,
      sidebarWidth: 232,
      inspectorWidth: 380,
      inspectorSplit: 34,
      onboardingDone: true,
      notifyOnFinish: false,
      autoDownloadUpdates: true,
    },
    selectedProjectId: 'p1',
    selectedSessionId: 's1',
  };
  const runtime = {
    sessionId: 's1',
    status: 'idle',
    messages: [],
    tools: [],
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
    cwd: '/home/dev/acme-web',
    stats: { tokens: 0, cost: 0, contextPercent: 0, contextTokens: 0, contextWindow: 200000 },
    diagnostic: [],
    commands: [],
    approvalMode: 'auto',
    approvalGrants: [],
  };
  let changed = [];
  let checkpoint;
  const pushRuntime = (tokens, contextTokens, outputEstimate) => {
    if (tokens !== undefined)
      runtime.stats = {
        ...runtime.stats,
        tokens,
        contextTokens,
        cost: tokens * 3.3e-6,
        contextPercent: (contextTokens / 200000) * 100,
      };
    if (outputEstimate === undefined) delete runtime.liveUsage;
    else runtime.liveUsage = { outputTokens: outputEstimate };
    emit({ type: 'runtime', runtime });
  };
  const touch = (file) => {
    changed.push({ path: file, status: '修改', staged: false, unstaged: true, existedBeforeRun: false });
    emit({ type: 'workspaceChanged', projectId: 'p1', changedPaths: [file] });
  };
  const assistant = (content) => runtime.messages.push({ role: 'assistant', content, timestamp: Date.now() });
  const startTool = (id, name, args) => {
    assistant([{ type: 'toolCall', id, name, arguments: args }]);
    runtime.tools.push({ id, name, args, status: 'running', output: '', startedAt: Date.now() });
  };
  const finishTool = (id, output, patch) => {
    const tool = runtime.tools.find((t) => t.id === id);
    Object.assign(tool, { status: 'done', output, durationMs: Date.now() - tool.startedAt, patch });
    runtime.messages.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: tool.name,
      content: output,
      timestamp: Date.now(),
    });
  };

  async function run(text, attachments) {
    const t = Date.now();
    const session = state.sessions[0];
    // The renderer only resets the composer when the stored draft changes, as it does after a real send.
    emit({ type: 'state', state });
    await sleep(50);
    Object.assign(session, {
      draft: '',
      attachments: [],
      title: text.slice(0, 28),
      lastStatus: 'running',
      updatedAt: t,
    });
    emit({ type: 'state', state });
    const files = attachments.map(
      (a) => `\n\n<project_file path=${JSON.stringify(a)}>\n${source}\n</project_file>`,
    );
    runtime.messages.push({ role: 'user', content: text + files.join(''), timestamp: t });
    Object.assign(runtime, { status: 'running', startedAt: t });
    checkpoint = {
      id: 'c1',
      sessionId: 's1',
      turn: 1,
      timestamp: t,
      time: t,
      available: true,
      includesCommitted: false,
    };
    pushRuntime(0, 2100, 0);
    await sleep(900);
    runtime.messages.push({
      role: 'assistant',
      timestamp: Date.now(),
      content: [
        { type: 'thinking', thinking: '只判断了 null，空白字符串会直接通过，需要先 trim 再校验格式。' },
        {
          type: 'text',
          text: '问题在于只判断了 `null`，`"   "` 会直接通过。改为先 `trim()`，再补一条格式校验。',
        },
      ],
    });
    pushRuntime(5200, 5200);
    await sleep(900);
    startTool('t1', 'edit', { path: 'src/auth/validate.ts' });
    pushRuntime(10600, 5400);
    await sleep(700);
    finishTool('t1', 'Successfully replaced text in src/auth/validate.ts.', patches['src/auth/validate.ts']);
    touch('src/auth/validate.ts');
    pushRuntime(10600, 5600);
    await sleep(700);
    startTool('t2', 'edit', { path: 'tests/validate.test.ts' });
    pushRuntime(16600, 6000);
    await sleep(700);
    finishTool(
      't2',
      'Successfully replaced text in tests/validate.test.ts.',
      patches['tests/validate.test.ts'],
    );
    touch('tests/validate.test.ts');
    pushRuntime(16600, 6200);
    await sleep(600);
    startTool('t3', 'bash', { command: 'npm test -- validate' });
    pushRuntime(23300, 6700);
    await sleep(1600);
    finishTool('t3', testOutput);
    pushRuntime(23300, 7000);
    await sleep(400);
    runtime.messages.push({ role: 'assistant', content: '', timestamp: Date.now() });
    for (let i = 4; i < reply.length + 4; i += 4) {
      runtime.messages.at(-1).content = reply.slice(0, i);
      pushRuntime(undefined, undefined, Math.ceil(i / 3));
      await sleep(45);
    }
    runtime.status = 'completed';
    session.lastStatus = 'completed';
    pushRuntime(30500, 7200);
    emit({ type: 'state', state });
  }

  const handlers = {
    navigationState: () => structuredClone({ state, revision: ++stateRevision }),
    bootstrap: () =>
      structuredClone({
        state,
        revision: ++stateRevision,
        runtime,
        environment: {
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
        },
        dataDir: '/home/dev/.pi-desktop',
        storage: { writable: true },
        update: {
          state: 'idle',
          currentVersion: '0.14.0',
          installation: 'nsis',
          mode: 'auto',
          enabled: true,
          installing: false,
        },
      }),
    saveDraft: (_id, draft, attachments) => Object.assign(state.sessions[0], { draft, attachments }),
    consumeDraft: () => {},
    send: (_id, text, attachments) => void run(text.trim(), attachments),
    selectSession: () => structuredClone(runtime.messages),
    readHistory: () => structuredClone(runtime.messages),
    changes: () => ({
      git: true,
      checkpoints: checkpoint ? [checkpoint] : [],
      branch: 'fix/login-email',
      head: 'a1b2c3d',
      baselineAvailable: true,
      omitted: [],
      files: structuredClone(changed),
    }),
    diff: (_p, file) => ({ path: file, patch: patches[file] ?? '', before: '', after: '' }),
    checkpoints: () => (checkpoint ? [checkpoint] : []),
    checkpointPreview: () => ({
      ...checkpoint,
      files: changed.map((f) => ({ ...f, manual: false, selected: true })),
      omitted: [],
      revision: 'r1',
    }),
    revertCheckpoint: (_s, _id, paths) => {
      changed = changed.filter((f) => !paths.includes(f.path));
      return paths;
    },
    searchFiles: (_p, query) =>
      ['src/auth/validate.ts', 'src/auth/login-form.tsx', 'tests/validate.test.ts'].filter((f) =>
        f.includes(query),
      ),
    attachmentInfo: (_p, specs) => specs.map((spec) => ({ spec, bytes: 1180, lines: 38 })),
    files: () => [
      { path: 'src', name: 'src', directory: true },
      { path: 'tests', name: 'tests', directory: true },
      { path: 'package.json', name: 'package.json', directory: false, size: 1200 },
    ],
    piSessions: () => [],
    sessionTree: () => [],
    searchSessions: () => [],
    projectRules: () => undefined,
  };
  window.desktop = {
    platform: 'win32',
    invoke: async (method, ...args) => (handlers[method] ? handlers[method](...args) : undefined),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pathForFile: () => '',
  };

  // Headless Chromium draws no pointer, so render one that follows real mouse input.
  addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div');
    cursor.innerHTML =
      '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-100px, -100px)',
      filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.25))',
    });
    const ring = document.createElement('div');
    Object.assign(ring.style, {
      position: 'fixed',
      width: '28px',
      height: '28px',
      marginLeft: '-14px',
      marginTop: '-14px',
      borderRadius: '50%',
      background: 'rgba(56,110,90,.35)',
      zIndex: '2147483646',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity .25s, transform .25s',
    });
    document.body.append(ring, cursor);
    addEventListener(
      'mousemove',
      (e) => (cursor.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 2}px)`),
      true,
    );
    addEventListener(
      'mousedown',
      (e) => {
        Object.assign(ring.style, {
          left: e.clientX + 'px',
          top: e.clientY + 'px',
          opacity: '1',
          transform: 'scale(.6)',
        });
        requestAnimationFrame(() => Object.assign(ring.style, { opacity: '0', transform: 'scale(1.4)' }));
      },
      true,
    );
  });
};

const frames = [];
const server = await startReadmeServer();
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.goto(server.url);
  const composer = page.getByRole('textbox', { name: '任务输入' });
  await composer.waitFor();
  await page
    .getByRole('button', { name: /工作区/ })
    .first()
    .click();
  await page.getByText('工作区干净').waitFor();
  await page.mouse.move(width * 0.55, height * 0.45);
  await page.waitForTimeout(300);

  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, time: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'png',
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  const pause = (ms) => page.waitForTimeout(ms);
  async function moveTo(locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Element is not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  }
  async function clickOn(locator) {
    await moveTo(locator);
    await pause(150);
    await page.mouse.down();
    await page.mouse.up();
  }

  await pause(600);
  await clickOn(composer);
  await page.keyboard.type('修复空格邮箱也能通过登录校验的问题，并补上测试 ', { delay: 70 });
  await page.keyboard.type('@valid', { delay: 35 });
  const fileOption = page.locator('.file-picker [role=option]', { hasText: 'src/auth/validate.ts' });
  await fileOption.waitFor();
  await pause(600);
  await clickOn(fileOption);
  await page
    .locator('.composer .attachments')
    .getByRole('button', { name: 'src/auth/validate.ts', exact: true })
    .waitFor();
  if ((await composer.inputValue()).includes('@valid')) throw new Error('文件引用未从草稿中展开');
  await pause(900);
  await clickOn(page.getByRole('button', { name: '发送任务' }));
  await page.getByText('本轮已结束').waitFor({ timeout: 30000 });
  await pause(900);
  await clickOn(page.locator('.change-row', { hasText: 'src/auth/validate.ts' }));
  await page.locator('.preview-toolbar').waitFor();
  await pause(2200);
  const thread = page.locator('.message', { hasText: '修复空格邮箱' }).first();
  await page.mouse.move(width * 0.4, height * 0.4, { steps: 12 });
  for (let i = 0; i < 40 && (await thread.boundingBox()).y < 70; i++) {
    await page.mouse.wheel(0, -120);
    await pause(40);
  }
  await pause(500);
  await moveTo(thread);
  await pause(500);
  await clickOn(page.getByRole('button', { name: '撤销此轮起的文件修改' }));
  const restore = page.getByRole('button', { name: /恢复 2 个文件/ });
  await restore.waitFor();
  await pause(1200);
  await clickOn(restore);
  await page.getByText('文件已恢复').waitFor();
  await pause(1100);
  await clickOn(page.getByRole('dialog').getByRole('button', { name: '关闭' }));
  await page.getByText('工作区干净').waitFor();
  await pause(2500);
  await cdp.send('Page.stopScreencast');
  if (errors.length) throw new Error(errors.join('; '));
  if (!frames.length) throw new Error('没有录到界面画面，请确认构建成功后重新生成演示 GIF。');
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-demo-'));
try {
  const list = [];
  frames.forEach((frame, i) => {
    const name = `f${String(i).padStart(5, '0')}.png`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(frame.data, 'base64'));
    const next = frames[i + 1]?.time ?? frame.time + 2;
    list.push(`file '${name}'`, `duration ${Math.max(next - frame.time, 0.001).toFixed(3)}`);
  });
  list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.png'`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      path.join(dir, 'frames.txt'),
      '-vf',
      `fps=${fps},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      '-loop',
      '0',
      output,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  console.log(
    `wrote ${output} (${frames.length} frames, ${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MiB)`,
  );
} finally {
  // mkdtemp created this exact directory; never remove a user-selected output directory.
  if (
    path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
    !path.basename(dir).startsWith('pi-demo-')
  )
    // eslint-disable-next-line no-unsafe-finally -- Refuse cleanup outside the exact temporary directory, including after a failed render.
    throw new Error('演示帧目录不在预期临时目录中，已停止清理。');
  fs.rmSync(dir, { recursive: true, force: true });
}
