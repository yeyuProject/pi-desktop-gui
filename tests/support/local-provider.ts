import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../../electron/store';
const exec = promisify(execFile);

/** Local deterministic OpenAI-compatible endpoint, used with the unmodified Pi CLI. */
export async function createLocalProvider(options: { holdSlowResponses?: boolean } = {}) {
  const requests: any[] = [];
  const heldSlowResponses = new Set<http.ServerResponse>();
  const heldInitialUsageResponses = new Map<
    http.ServerResponse,
    { advance: () => void; finish: () => void }
  >();
  const heldUsageResponses = new Map<http.ServerResponse, () => void>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const lastUser = body.messages.findLastIndex((m: any) => m.role === 'user');
    const content = body.messages[lastUser]?.content;
    const prompt =
      typeof content === 'string' ? content : (content ?? []).map((b: any) => b.text ?? '').join('');
    const errorScenario = [
      ['E2E_401', 401, 'authentication_error', 'Invalid API key sk-test12345678901234567890 (local test)'],
      ['E2E_429', 429, 'rate_limit_exceeded', 'Too many requests (local test)'],
      ['E2E_QUOTA', 429, 'insufficient_quota', 'Account quota exceeded (local test)'],
      ['E2E_OVERFLOW', 400, 'context_length_exceeded', 'Maximum context length exceeded (local test)'],
      ['E2E_MODEL', 404, 'model_not_found', 'Model not found (local test)'],
    ].find(([marker]) => prompt.startsWith(String(marker)));
    if (errorScenario) {
      const [, status, type, message] = errorScenario;
      res.writeHead(Number(status), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type, code: type } }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (delta: any, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'local-e2e', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const done = (reason = 'stop') => {
      chunk({}, reason);
      if (prompt.startsWith('E2E_USAGE'))
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-local',
            object: 'chat.completion.chunk',
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
            },
          })}\n\n`,
        );
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const tool = (name: string, args: any) => {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_' + randomUUID().slice(0, 8),
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      done('tool_calls');
    };
    const results = body.messages.slice(lastUser + 1).filter((m: any) => m.role === 'tool');
    if (prompt.includes('E2E_MCP') && results.length === 0) return tool('mcp__desktop__ping', {});
    if (prompt.includes('E2E_EDIT') && results.length === 0)
      return tool('edit', { path: '输入 文件.txt', edits: [{ oldText: '输入文件', newText: '已编辑文件' }] });
    if (prompt.includes('E2E_FILES')) {
      if (results.length === 0) return tool('read', { path: '输入 文件.txt' });
      if (results.length === 1)
        return tool('write', { path: '输出结果.txt', content: '真实 Pi 工具执行成功\n' });
      if (results.length === 2) {
        const shell = body.tools.some((t: any) => t.function?.name === 'powershell') ? 'powershell' : 'bash';
        return tool(shell, {
          command:
            shell === 'powershell'
              ? "if ((Get-Content -LiteralPath '输出结果.txt' -Raw -Encoding UTF8).Trim() -ne '真实 Pi 工具执行成功') { throw 'Unexpected file content' }; Write-Output 'PI_TOOL_TEST_PASS'"
              : "test -f '输出结果.txt' && printf 'PI_TOOL_TEST_PASS\\n'",
        });
      }
      const answer =
        '已经完成文件读取和写入，并运行验证命令。\n\n- 读取 `输入 文件.txt`\n- 创建 `输出结果.txt`\n- 命令结果：`PI_TOOL_TEST_PASS`\n\n以上操作由真实 Pi 工具执行，回复来自本地测试接口。';
      chunk({ role: 'assistant', content: '' });
      for (const text of answer.match(/.{1,8}|\n/g) ?? []) {
        if (res.destroyed) return;
        chunk({ content: text });
        await new Promise((r) => setTimeout(r, 18));
      }
      done();
      return;
    }
    if ((prompt.includes('E2E_STOP') || prompt.includes('E2E_CRASH')) && results.length === 0) {
      const shell = body.tools.some((t: any) => t.function?.name === 'powershell') ? 'powershell' : 'bash';
      return tool(shell, {
        command:
          (prompt.includes('E2E_CRASH')
            ? shell === 'powershell'
              ? "Set-Content -LiteralPath 'crash-partial.txt' -Value 'PARTIAL'; "
              : "printf 'PARTIAL' > crash-partial.txt; "
            : '') +
          (shell === 'powershell'
            ? `Write-Output 'WAITING_FOR_STOP'; Start-Sleep -Seconds ${prompt.includes('E2E_ORPHAN') ? 2 : 30}; Set-Content -LiteralPath 'should-not-exist.txt' -Value 'NOT_STOPPED'`
            : `printf 'WAITING_FOR_STOP\\n'; sleep ${prompt.includes('E2E_ORPHAN') ? 2 : 30}; printf 'NOT_STOPPED' > should-not-exist.txt`),
      });
    }
    if (prompt.startsWith('E2E_USAGE_LIVE')) {
      if (results.length === 0) {
        chunk({ role: 'assistant', content: '开始检查。' });
        heldInitialUsageResponses.set(res, {
          advance: () => {
            if (!res.destroyed) chunk({ content: '正在读取文件。' });
          },
          finish: () => {
            if (!res.destroyed) tool('read', { path: '输入 文件.txt' });
          },
        });
        res.once('close', () => heldInitialUsageResponses.delete(res));
        return;
      }
      chunk({ role: 'assistant', content: '文件已经读取。' });
      heldUsageResponses.set(res, () => {
        if (!res.destroyed) {
          chunk({ content: '检查完成。' });
          done();
        }
      });
      res.once('close', () => heldUsageResponses.delete(res));
      return;
    }
    if (prompt.includes('E2E_SLOW') || prompt.includes('E2E_SIDE_HOLD')) {
      if (options.holdSlowResponses) {
        // A fixture-controlled gate: only client cancellation or provider.close ends this stream.
        // Tests can wait for unrelated startup without racing the default 20-second response.
        heldSlowResponses.add(res);
        res.once('close', () => heldSlowResponses.delete(res));
        chunk({ role: 'assistant', content: '开始流式回复。' });
        return;
      }
      chunk({ role: 'assistant', content: '开始流式回复。' });
      const timer = setTimeout(() => {
        if (!res.destroyed) {
          chunk({ content: '完成。' });
          done();
        }
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (prompt.startsWith('E2E_USAGE_SIDE')) {
      chunk({ role: 'assistant', content: '侧边回答：' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      chunk({ content: '这是独立的问答结果。' });
      done();
      return;
    }
    chunk({ role: 'assistant', content: 'OK' });
    done();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    get heldSlowResponseCount() {
      return heldSlowResponses.size;
    },
    get heldUsageResponseCount() {
      return heldUsageResponses.size;
    },
    get heldInitialUsageResponseCount() {
      return heldInitialUsageResponses.size;
    },
    advanceInitialUsageResponses() {
      for (const response of heldInitialUsageResponses.values()) response.advance();
    },
    finishInitialUsageResponses() {
      for (const [response, callbacks] of heldInitialUsageResponses) {
        heldInitialUsageResponses.delete(response);
        callbacks.finish();
      }
    },
    releaseUsageResponses() {
      for (const [response, release] of heldUsageResponses) {
        heldUsageResponses.delete(response);
        release();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function prepareRealPiFixture(baseUrl: string, label: string) {
  const root = path.resolve('work', label);
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, '中文项目 space-'));
  const projectDir = path.join(dir, 'project');
  const dataDir = path.join(dir, 'app-data');
  const agentDir = path.join(dir, 'pi-agent');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
  await fs.copyFile(
    path.resolve('tests/support/pi-extension.js'),
    path.join(agentDir, 'extensions', 'gui-e2e.js'),
  );
  await fs.writeFile(path.join(projectDir, '输入 文件.txt'), '这是 E2E 测试的输入文件。\n');
  await fs.writeFile(path.join(projectDir, '已有修改.txt'), 'committed\n');
  await exec('git', ['init'], { cwd: projectDir, windowsHide: true });
  await exec('git', ['add', '.'], { cwd: projectDir, windowsHide: true });
  await exec(
    'git',
    [
      '-c',
      'user.name=Pi GUI Test',
      '-c',
      'user.email=pi-test@example.invalid',
      'commit',
      '-m',
      'test baseline',
    ],
    { cwd: projectDir, windowsHide: true },
  );
  await fs.writeFile(path.join(projectDir, '已有修改.txt'), 'before agent run\n');
  await fs.writeFile(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'local-e2e': {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'local-test-only',
          models: [
            {
              id: 'local-e2e',
              name: '本地验收接口',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 32768,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'local-e2e',
      defaultModel: 'local-e2e',
      retry: { enabled: false },
      compaction: { enabled: false },
      quietStartup: true,
    }),
  );
  const store = new Store(dataDir);
  await store.load();
  const projectId = randomUUID(),
    sessionId = randomUUID();
  store.state.projects = [
    { id: projectId, name: 'Pi GUI 验收项目', path: projectDir, trusted: true, createdAt: Date.now() },
  ];
  store.state.sessions = [
    {
      id: sessionId,
      projectId,
      title: '新会话',
      draft: '',
      attachments: [],
      lastStatus: 'idle',
      updatedAt: Date.now(),
    },
  ];
  store.state.selectedProjectId = projectId;
  store.state.selectedSessionId = sessionId;
  store.state.settings = {
    ...store.state.settings,
    piPath: path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    nodePath: process.execPath,
    agentDir,
    provider: 'local-e2e',
    modelId: 'local-e2e',
    theme: 'light',
    onboardingDone: true,
  };
  await store.save();
  return { dir, projectDir, dataDir, agentDir, projectId, sessionId, store };
}
