import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../electron/agent';
import { Store } from '../electron/store';
import { Workspace } from '../electron/workspace';

test('real Pi model selection works before a chat connects, preserves project defaults, and sends no prompts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-model-catalog-'));
  const agentDir = path.join(directory, 'agent');
  const projectDir = path.join(directory, 'project');
  await fs.mkdir(agentDir);
  await fs.mkdir(path.join(projectDir, '.pi', 'extensions'), { recursive: true });
  await fs.writeFile(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        catalog: {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          apiKey: 'local-metadata-only',
          models: [
            {
              id: 'basic',
              name: 'Basic',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 1024,
            },
            {
              id: 'reasoning',
              name: 'Reasoning',
              reasoning: true,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 1024,
              compat: { supportsReasoningEffort: true },
            },
          ],
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'catalog', defaultModel: 'basic' }),
  );
  await fs.writeFile(
    path.join(projectDir, '.pi', 'settings.json'),
    JSON.stringify({ defaultModel: 'reasoning' }),
  );
  const observed = path.join(directory, 'extension-events.jsonl');
  await fs.writeFile(
    path.join(projectDir, '.pi', 'extensions', 'observe.js'),
    `import fs from 'node:fs';
export default function(pi) {
  pi.registerProvider('project-catalog', {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'project-only-secret',
    models: [{ id: 'project-only', name: 'Project only', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  pi.on('before_agent_start', () => fs.appendFileSync(${JSON.stringify(observed)}, 'prompt\\n'));
  pi.on('session_start', () => fs.appendFileSync(${JSON.stringify(observed)}, 'start\\n'));
}`,
  );
  const store = new Store(path.join(directory, 'desktop'));
  await store.load();
  Object.assign(store.state.settings, {
    piPath:
      process.env.PI_TEST_PATH ||
      path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    nodePath: process.execPath,
    agentDir,
    provider: '',
    modelId: '',
  });
  store.state.projects.push({
    id: 'project',
    name: 'project',
    path: projectDir,
    trusted: true,
    createdAt: Date.now(),
  });
  const session = store.createSession('project');
  const service = new AgentService(store, new Workspace(store.dir));
  const services = [service];
  t.after(async () => {
    await Promise.all(services.map((item) => item.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  t.after(() => {
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  });

  const statuses: string[] = [];
  service.on('runtime', (runtime) => statuses.push(runtime.status));
  const settingsBefore = await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8');
  const piPath = store.state.settings.piPath;
  store.state.settings.piPath = path.join(directory, 'missing-cli.js');
  await assert.rejects(service.readModels(session.id), /未找到 Pi/);
  assert.match(service.runtime.error ?? '', /未找到 Pi/);
  assert.equal(service.runtime.modelsLoaded, false);
  assert.equal(service.runtime.modelsLoading, false);
  assert.equal(service.runtime.connected, false);
  store.state.settings.piPath = piPath;
  const began = performance.now();
  await service.readModels(session.id);
  t.diagnostic(`First model catalog: ${Math.round(performance.now() - began)} ms`);
  assert.equal(service.runtime.connected, false);
  assert.equal(service.runtime.model?.id, 'reasoning', 'Pi applies project-level model defaults');
  assert.equal(service.runtime.models.length, 3);
  assert.ok(service.runtime.models.some((model) => model.provider === 'project-catalog'));
  assert.doesNotMatch(JSON.stringify(service.runtime.models), /secret|Authorization|apiKey/);
  assert.equal(session.file, undefined, 'reading the model catalog creates no session log');
  assert.equal(service.runtime.commands.length, 0, 'reading models does not load chat capabilities');
  assert.equal(service.diagnostics().pendingOperations, 0);
  assert.equal(service.runtime.modelsLoading, false);
  assert.equal(service.runtime.error, undefined, 'a successful metadata retry clears the previous error');
  assert.ok(
    statuses.every((status) => status === 'idle'),
    'reading metadata does not run a task',
  );

  await service.setModel(session.id, 'catalog', 'basic');
  assert.equal(service.runtime.model?.id, 'basic');
  assert.deepEqual(service.runtime.thinkingLevels, ['off']);
  assert.equal(service.runtime.connected, false);
  await assert.rejects(service.setThinking(session.id, 'high'), /所选模型不支持/);
  await service.setModel(session.id, 'catalog', 'reasoning');
  assert.ok(service.runtime.thinkingLevels.includes('high'));
  await service.setThinking(session.id, 'high');
  assert.equal(service.runtime.thinking, 'high');
  assert.equal(session.thinking, 'high');
  assert.equal(session.file, undefined);
  assert.doesNotMatch(await fs.readFile(observed, 'utf8'), /prompt/);
  assert.equal(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'), settingsBefore);

  session.model = { provider: 'catalog', id: 'removed-model' };
  await service.readModels(session.id);
  assert.equal(service.runtime.modelsLoaded, true);
  assert.equal(
    service.runtime.models.length,
    3,
    'a retired preference does not prevent choosing another model',
  );
  assert.equal(service.runtime.model, undefined, 'a missing saved model is not silently replaced');
  assert.equal(session.model.id, 'removed-model');
  await assert.rejects(service.setModel(session.id, 'catalog', 'missing-model'), /Model not found/);
  assert.equal(session.model.id, 'removed-model');
  await service.setModel(session.id, 'catalog', 'basic');

  const standalone = store.createSession();
  const other = new AgentService(store, new Workspace(store.dir));
  services.push(other);
  store.state.settings.provider = '';
  store.state.settings.modelId = '';
  await other.readModels(standalone.id);
  assert.equal(
    other.runtime.model?.id,
    'basic',
    'a different working directory never inherits the project override',
  );
  assert.equal(other.runtime.connected, false);
  assert.equal(
    other.runtime.models.some((model) => model.provider === 'project-catalog'),
    false,
  );

  const imported = store.createSession();
  imported.cwd = projectDir;
  imported.file = path.join(directory, 'imported.jsonl');
  const history =
    [
      { type: 'session', version: 3, id: imported.id, cwd: projectDir, timestamp: new Date().toISOString() },
      { type: 'model_change', id: 'm1', parentId: null, provider: 'catalog', modelId: 'reasoning' },
      { type: 'thinking_level_change', id: 't1', parentId: 'm1', thinkingLevel: 'high' },
      {
        type: 'message',
        id: 'u1',
        parentId: 't1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Previous message' }],
          timestamp: Date.now(),
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n';
  await fs.writeFile(imported.file, history);
  const historical = new AgentService(store, new Workspace(store.dir));
  services.push(historical);
  await historical.readModels(imported.id);
  assert.equal(historical.runtime.model?.id, 'reasoning', 'Pi restores the historical branch selection');
  assert.equal(historical.runtime.thinking, 'high');
  assert.ok(historical.runtime.thinkingLevels.includes('high'));
  assert.equal(historical.runtime.connected, false);
  assert.equal(await fs.readFile(imported.file, 'utf8'), history, 'the source history is untouched');
  assert.equal(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'), settingsBefore);

  const missing = store.createSession();
  missing.file = path.join(directory, 'already-removed.jsonl');
  const orphaned = new AgentService(store, new Workspace(store.dir));
  services.push(orphaned);
  await orphaned.readModels(missing.id);
  assert.equal(orphaned.runtime.modelsLoaded, true);
  assert.equal(orphaned.runtime.connected, false);
  assert.equal(orphaned.runtime.error, undefined);
  assert.ok(orphaned.runtime.models.length > 0, 'a missing transcript still loads the model catalog');

  for (const code of ['ENOENT', 'EACCES', 'EIO']) {
    await t.test(`transcript copy ${code} cleans its temporary directory`, async (t) => {
      const recorded: string[] = [];
      const mkdtemp = fs.mkdtemp;
      const copyFile = fs.copyFile;
      t.mock.method(fs, 'mkdtemp', async (...args: Parameters<typeof fs.mkdtemp>) => {
        const dir = await mkdtemp(...args);
        if (String(args[0]).includes('pi-desktop-models-')) recorded.push(String(dir));
        return dir;
      });
      const failure = Object.assign(new Error(`copy ${code}`), { code });
      t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
        if (args[0] === imported.file) throw failure;
        return copyFile(...args);
      });
      t.after(async () => {
        for (const dir of recorded) await fs.rm(dir, { recursive: true, force: true });
      });
      const probe = new AgentService(store, new Workspace(store.dir));
      services.push(probe);
      if (code === 'ENOENT') {
        await probe.readModels(imported.id);
        assert.equal(probe.runtime.modelsLoaded, true);
        assert.equal(probe.runtime.error, undefined);
      } else {
        await assert.rejects(probe.readModels(imported.id), (error) => error === failure);
        assert.equal(probe.runtime.modelsLoaded, false);
        assert.match(probe.runtime.error ?? '', new RegExp(code));
      }
      assert.equal(probe.runtime.modelsLoading, false);
      assert.equal(probe.runtime.connected, false);
      assert.equal(recorded.length, 1, 'copy is attempted after creating a directory');
      for (const dir of recorded)
        await assert.rejects(fs.lstat(dir), { code: 'ENOENT' }, 'the probe directory is cleaned');
      assert.equal(await fs.readFile(imported.file!, 'utf8'), history);
    });
  }
});
