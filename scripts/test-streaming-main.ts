import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { createGoalProvider } from '../tests/support/goal-provider';

process.env.PI_OFFLINE = '1';
const source = process.env.PI_STREAMING_SOURCE ?? '.';
const load = (file: string) => import(pathToFileURL(path.resolve(source, 'electron', file + '.ts')).href);
const [{ SessionAgents }, { Workspace }, { Store }, { RuntimePublisher }] = await Promise.all(
  ['session-agents', 'workspace', 'store', 'runtime-publisher'].map(load),
);
const originalFlush = RuntimePublisher.prototype.flush;
const flushes: number[] = [];
RuntimePublisher.prototype.flush = function (...args: unknown[]) {
  const start = performance.now();
  try {
    return originalFlush.apply(this, args);
  } finally {
    flushes.push(performance.now() - start);
  }
};
const results: Record<string, unknown>[] = [];
const originalRename = fs.rename;
try {
  for (const scenario of ['stream', 'goal'] as const) {
    const provider = scenario === 'stream' ? await createLocalProvider() : await createGoalProvider();
    if ('reset' in provider) provider.reset('performance');
    const fixture = await prepareRealPiFixture(provider.baseUrl, 'streaming-main-' + scenario);
    const store = new Store(fixture.dataDir);
    await store.load();
    for (let i = 0; i < 49; i++) store.createSession(fixture.projectId);
    store.state.selectedSessionId = fixture.sessionId;
    await store.save();
    const workspace = new Workspace(fixture.dataDir);
    const agents = new SessionAgents(store, workspace);
    const agent = agents.get(fixture.sessionId);
    const writes: { at: number; status: string }[] = [];
    let patches = 0,
      ipcBytes = 0,
      broadcasts = 0,
      stateBytes = 0,
      maxPartial = 0,
      maxPartialLength = 0,
      maxEstimatedOutput = 0;
    let parameterIpcBytes = 0,
      parameterStarted = 0,
      parameterEnded = 0;
    agents.on('runtimePatch', (patch: unknown) => {
      patches++;
      ipcBytes += Buffer.byteLength(JSON.stringify(patch));
      const preparing = agent.runtime.messages.some(
        (message: any) =>
          Array.isArray(message.content) &&
          message.content.some((block: any) => block.partialJson || block.partialJsonLength),
      );
      if (scenario === 'stream' && preparing && agent.runtime.tools.length === 0) {
        parameterIpcBytes += Buffer.byteLength(JSON.stringify(patch));
        parameterStarted ||= performance.now();
        parameterEnded = performance.now();
      }
      for (const message of agent.runtime.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          maxPartial = Math.max(maxPartial, block.partialJson?.length ?? 0);
          maxPartialLength = Math.max(maxPartialLength, block.partialJsonLength ?? 0);
        }
      }
      maxEstimatedOutput = Math.max(maxEstimatedOutput, agent.runtime.liveUsage?.outputTokens ?? 0);
    });
    agents.on('state', (state: unknown) => {
      broadcasts++;
      stateBytes += Buffer.byteLength(JSON.stringify(state));
    });
    try {
      await agent.connect(fixture.sessionId);
      flushes.length = 0;
      patches = ipcBytes = broadcasts = stateBytes = 0;
      parameterIpcBytes = parameterStarted = parameterEnded = 0;
      const start = performance.now();
      fs.rename = async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === path.join(fixture.dataDir, 'state.json') && agent.hasPendingWork)
          writes.push({ at: performance.now() - start, status: agent.runtime.status });
        return originalRename(...args);
      };
      await agent.send(
        fixture.sessionId,
        scenario === 'stream' ? 'E2E_STREAMING_PF' : '/goal 完成 200 次工具调用的本地测试',
        [],
        'steer',
      );
      const deadline = Date.now() + 120000;
      while (agent.hasPendingWork) {
        assert.ok(
          Date.now() < deadline,
          JSON.stringify({
            scenario,
            status: agent.runtime.status,
            error: agent.runtime.error,
            tools: agent.runtime.tools.length,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await store.flush();
      if (scenario === 'stream')
        assert.equal(
          (await fs.readFile(path.join(fixture.projectDir, 'streamed-200kb.txt'), 'utf8')).length,
          200000,
        );
      else {
        assert.equal(agent.runtime.goal?.status, 'completed');
        assert.equal(agent.runtime.tools.length, 200);
      }
      const sorted = flushes.toSorted((a, b) => a - b);
      results.push({
        scenario,
        milliseconds: performance.now() - start,
        patches,
        ipcBytes,
        parameterIpcBytes,
        parameterBytesPerSecond: parameterIpcBytes / ((parameterEnded - parameterStarted) / 1000),
        broadcasts,
        stateBytes,
        writes,
        maxPartial,
        maxPartialLength,
        maxEstimatedOutput,
        flushP95Ms: sorted[Math.floor(sorted.length * 0.95)],
        tools: agent.runtime.tools.length,
      });
    } finally {
      fs.rename = originalRename;
      await agents.dispose();
      await workspace.flush?.();
      await provider.close();
    }
  }
  const result = { node: process.version, platform: process.platform, results };
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    process.env.PI_STREAMING_RESULT ?? 'test-results/streaming-main.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  RuntimePublisher.prototype.flush = originalFlush;
  fs.rename = originalRename;
}
