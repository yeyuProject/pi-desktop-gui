import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { WorkspaceWatcher } from '../electron/workspace-watch';
import type { Project } from '../shared/types';
const exec = promisify(execFile);
const { Workspace } = await import(
  pathToFileURL(path.resolve(process.env.PI_CHECKPOINT_SOURCE ?? '.', 'electron/workspace.ts')).href
);
if (process.env.PI_SCALE_PHASE === 'cleanup') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-checkpoint-cleanup-'));
  try {
    const data = path.join(root, 'data');
    const directory = path.join(data, 'baselines', 'checkpoints');
    await fs.mkdir(directory, { recursive: true });
    const files = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`file-${i}.txt`, 'a'.repeat(40)]),
    );
    for (let session = 0; session < 50; session++) {
      const sessionId = 'session-' + session;
      const repo = `session-${sessionId}-objects.git`;
      await fs.mkdir(path.join(directory, repo, 'objects'), { recursive: true });
      for (let turn = 1; turn <= 20; turn++) {
        const record = {
          version: 3,
          projectId: 'scale',
          sessionId,
          id: `${sessionId}-${turn}`,
          turn,
          time: Date.now(),
          repo,
          files: turn === 1 ? files : {},
          modes: {},
          dirty: [],
          omitted: [],
          fingerprint: '',
          branch: '',
          branchHistory: '',
          head: '',
          cursor: 0,
          ...(turn > 1 ? { baseId: `${sessionId}-${turn - 1}`, removed: [] } : {}),
        };
        await fs.writeFile(path.join(directory, record.id + '.json'), JSON.stringify(record));
      }
    }
    globalThis.gc?.();
    const workspace = new Workspace(data);
    const before = process.memoryUsage().rss;
    let peak = before,
      maxDelay = 0,
      last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxDelay = Math.max(maxDelay, now - last - 10);
      last = now;
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    let cleanup: Promise<void> | undefined;
    const deferred = Boolean((workspace as any).watchProject);
    if (!deferred) cleanup = workspace.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const startup = { rssIncreaseBytes: peak - before, maximumDelayMs: maxDelay };
    peak = process.memoryUsage().rss;
    maxDelay = 0;
    const start = performance.now();
    await (cleanup ?? workspace.cleanup());
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(timer);
    const result = {
      node: process.version,
      platform: process.platform,
      sessions: 50,
      turns: 20,
      files: 5000,
      deferred,
      startup,
      cleanup: { milliseconds: performance.now() - start, peakRssBytes: peak, maximumDelayMs: maxDelay },
    };
    await fs.mkdir('test-results', { recursive: true });
    await fs.writeFile(
      process.env.PI_SCALE_RESULT ?? 'test-results/checkpoint-cleanup.json',
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('pi-checkpoint-cleanup-'))
      await fs.rm(root, { recursive: true, force: true });
  }
  process.exit(0);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-checkpoint-scale-'));
const project: Project = {
  id: randomUUID(),
  name: 'scale',
  path: path.join(root, 'project'),
  trusted: true,
  createdAt: Date.now(),
};
const count = Number(process.env.PI_SCALE_FILES ?? 20000);
const samples = Number(process.env.PI_SCALE_SAMPLES ?? 100);
const originalLstat = fs.lstat;
let lstatCalls = 0;
let watcher: Awaited<ReturnType<typeof WorkspaceWatcher.watch>> | undefined;
try {
  await fs.mkdir(project.path);
  await exec('git', ['init', '-q', project.path], { windowsHide: true });
  for (let at = 0; at < count; at += 128)
    await Promise.all(
      Array.from({ length: Math.min(128, count - at) }, (_, offset) =>
        fs.writeFile(path.join(project.path, `file-${at + offset}.txt`), 'before\n'),
      ),
    );
  const workspace = new Workspace(path.join(root, 'data'));
  const sessionId = randomUUID();
  await workspace.captureCheckpoint(project, sessionId, 1);
  if (workspace.watchProject) {
    workspace.watchProject(project.id);
    watcher = await WorkspaceWatcher.watch(project, () => {}, undefined, {
      changed: (paths) => workspace.changedPaths(project.id, paths),
      failed: () => workspace.watchProject(undefined),
    });
  }
  const timings: number[] = [];
  (fs as any).lstat = (...args: any[]) => {
    lstatCalls++;
    return (originalLstat as any)(...args);
  };
  const statSamples: number[] = [];
  for (let index = 0; index <= samples; index++) {
    const statsBefore = lstatCalls;
    let start = performance.now();
    await workspace.beginTool(project, sessionId, String(index), 'bash', { command: 'echo hi' });
    const before = performance.now() - start;
    await exec(
      process.platform === 'win32' ? 'cmd.exe' : 'bash',
      process.platform === 'win32' ? ['/d', '/c', 'echo hi'] : ['-c', 'echo hi'],
      { cwd: project.path, windowsHide: true },
    );
    start = performance.now();
    await workspace.endTool(project, sessionId, String(index));
    if (index) {
      timings.push(before + performance.now() - start);
      statSamples.push(lstatCalls - statsBefore);
    }
  }
  timings.sort((a, b) => a - b);
  await fs.writeFile(path.join(project.path, 'file-0.txt'), 'changed\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await workspace.beginTool(project, sessionId, 'external', 'bash', { command: 'echo hi' });
  await workspace.endTool(project, sessionId, 'external');
  workspace.watchProject?.(undefined);
  const start = performance.now();
  await workspace.beginTool(project, sessionId, 'fallback', 'bash', { command: 'echo hi' });
  await workspace.endTool(project, sessionId, 'fallback');
  const result = {
    node: process.version,
    platform: process.platform,
    files: count,
    samples,
    lstatPerBoundaryPair: { minimum: Math.min(...statSamples), maximum: Math.max(...statSamples) },
    p95Ms: timings[Math.floor(timings.length * 0.95)],
    maxMs: timings.at(-1),
    fallbackMs: performance.now() - start,
    rss: process.memoryUsage().rss,
  };
  await workspace.endSessionTools(project, sessionId);
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    process.env.PI_SCALE_RESULT ?? 'test-results/checkpoint-scale.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  fs.lstat = originalLstat;
  watcher?.dispose();
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('pi-checkpoint-scale-'))
    await fs.rm(root, { recursive: true, force: true });
}
