import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Project } from '../shared/types';
import type { CheckpointSummary } from '../shared/checkpoints';
import {
  changedSnapshotFiles,
  createSnapshotRepo,
  hashBlobs,
  storeBlobs,
  updateSnapshotIndex,
} from './snapshot';
import { allFiles, info, snapshotCandidates, snapshotStorageBytes } from './workspace';
import { isWindows } from './platform';
import { normalizePiToolPath } from './pi/tool-path';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';

export interface SnapshotData {
  version: 3;
  projectId: string;
  fingerprint: string;
  time: number;
  repo: string;
  files: Record<string, string>;
  modes: Record<string, number>;
  dirty: string[];
  omitted: string[];
}
export interface CheckpointRecord extends SnapshotData {
  id: string;
  sessionId: string;
  turn: number;
  timestamp?: number;
  branch: string;
  branchHistory: string;
  head: string;
  cursor: number;
  invalidReason?: string;
}
interface StoredCheckpoint extends CheckpointRecord {
  baseId?: string;
  removed?: string[];
}
interface Activity {
  cursor: number;
  paths: string[];
  source: 'pi' | 'manual';
}
interface SessionTracking {
  lastTurn: number;
  cursor: number;
  known: Record<string, string>;
  activity: Activity[];
}
type ToolBoundary = {
  projectId: string;
  root: string;
  sessionId: string;
  names?: string[];
  before: Record<string, string>;
  overlapping: boolean;
};
const safeId = (value: string) => {
  if (!/^[\w-]{1,128}$/.test(value)) throw new Error('检查点标识无效，请重新打开会话');
  return value;
};
const fingerprint = (blob: string, mode: number) => (isWindows ? blob : `${blob}:${mode}`);
const STORAGE_LIMIT = 200 * 1024 * 1024;
const CLEANUP_INTERVAL = 10 * 60 * 1000;

export function checkpointRevision(now: Record<string, string>, paths: string[]) {
  return createHash('sha256')
    .update(
      paths
        .slice()
        .sort()
        .map((name) => `${name}\0${now[name] ?? '<missing>'}\0`)
        .join(''),
    )
    .digest('hex');
}

/** Session-local metadata and tool boundaries; content objects are shared by all its turns. */
export class Checkpoints {
  readonly directory: string;
  private tracking = new Map<string, SessionTracking>();
  private tools = new Map<string, ToolBoundary>();
  private operation: Promise<unknown> = Promise.resolve();
  private cached?: { sessionId: string; records: CheckpointRecord[] };
  private hashes?: { sessionId: string; files: Map<string, { stamp: string; id: string; mode: number }> };
  // Observed hashes need not exist in the object store. Never use them to skip storeBlobs in capture.
  private scanHashes = new Map<string, { root: string; files: Map<string, { stamp: string; id: string }> }>();
  private storage?: { bytes: number; files: Map<string, number> };
  private lastCleanup = 0;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'baselines', 'checkpoints');
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation
      .catch(() => {})
      .then(async () => {
        try {
          return await operation();
        } catch (error) {
          // A failed write may leave temporary files or objects that were not accounted for.
          this.storage = undefined;
          throw error;
        }
      });
    this.operation = next;
    return next;
  }
  private account(file: string, size: number) {
    if (!this.storage) return;
    this.storage.bytes += size - (this.storage.files.get(file) ?? 0);
    if (size) this.storage.files.set(file, size);
    else this.storage.files.delete(file);
  }
  private async measureFiles(files: string[]) {
    if (!this.storage) return;
    await Promise.all(
      files.map(async (file) => {
        try {
          this.account(file, (await fs.stat(file)).size);
        } catch (error) {
          // hash-object may reuse a blob from the project's alternates without writing a loose object.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.account(file, 0);
        }
      }),
    );
  }
  private async removeStored(file: string, recursive = false) {
    await fs.rm(file, { recursive, force: true });
    this.account(file, 0);
    if (recursive && this.storage)
      for (const stored of this.storage.files.keys())
        if (stored.startsWith(file + path.sep)) this.account(stored, 0);
  }
  private recordPath(id: string) {
    return path.join(this.directory, safeId(id) + '.json');
  }
  private statePath(sessionId: string) {
    return path.join(this.directory, `session-${safeId(sessionId)}.state`);
  }
  repoPath(record: CheckpointRecord) {
    if (record.repo !== `session-${safeId(record.sessionId)}-objects.git`)
      throw new Error('检查点对象目录无效，请保留本地数据后重新建立检查点');
    return path.join(this.directory, record.repo);
  }
  private async state(sessionId: string) {
    safeId(sessionId);
    let state = this.tracking.get(sessionId);
    if (state) return state;
    try {
      state = JSON.parse(await fs.readFile(this.statePath(sessionId), 'utf8')) as SessionTracking;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('检查点的轮次记录无法读取，请先保留数据并重新打开会话');
    }
    state ??= { lastTurn: 0, cursor: 0, known: {}, activity: [] };
    this.tracking.set(sessionId, state);
    return state;
  }
  private async saveState(sessionId: string, state: SessionTracking) {
    await fs.mkdir(this.directory, { recursive: true });
    const destination = this.statePath(sessionId);
    const content = JSON.stringify(state);
    await fs.writeFile(destination + '.tmp', content, { mode: 0o600 });
    await fs.rename(destination + '.tmp', destination);
    this.account(destination + '.tmp', 0);
    this.account(destination, Buffer.byteLength(content));
  }
  async nextTurn(sessionId: string) {
    return (await this.state(sessionId)).lastTurn + 1;
  }
  async records(sessionId?: string): Promise<CheckpointRecord[]> {
    if (sessionId) safeId(sessionId);
    if (sessionId && this.cached?.sessionId === sessionId) return this.cached.records;
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const stored: StoredCheckpoint[] = [];
    for (const name of entries) {
      if (!/^[\w-]+-\d+\.json$/.test(name) || (sessionId && !name.startsWith(sessionId + '-'))) continue;
      const cached = !sessionId
        ? this.cached?.records.find((record) => record.id + '.json' === name)
        : undefined;
      if (cached) {
        stored.push(cached);
        continue;
      }
      const record = JSON.parse(
        await fs.readFile(path.join(this.directory, name), 'utf8'),
      ) as StoredCheckpoint;
      if (
        record.version === 3 &&
        record.sessionId &&
        (!sessionId || record.sessionId === sessionId) &&
        record.id + '.json' === name
      )
        stored.push(record);
    }
    const records = new Map<string, CheckpointRecord>();
    for (const { baseId, removed, ...record } of stored.sort((a, b) => a.turn - b.turn)) {
      if (baseId) {
        const base = records.get(baseId);
        if (!base || base.sessionId !== record.sessionId)
          throw new Error('检查点文件列表不完整，无法安全恢复这一轮');
        record.files = { ...base.files, ...record.files };
        record.modes = { ...base.modes, ...record.modes };
        for (const name of removed ?? []) {
          delete record.files[name];
          delete record.modes[name];
        }
      }
      records.set(record.id, record);
    }
    const result = [...records.values()];
    if (sessionId) this.cached = { sessionId, records: result };
    return result;
  }
  async get(sessionId: string, id?: string) {
    const records = await this.records(sessionId);
    return id ? records.find((record) => record.id === id) : records.at(-1);
  }
  private async write(record: CheckpointRecord, previous?: CheckpointRecord | null) {
    const base =
      previous === undefined
        ? (await this.records(record.sessionId)).filter((item) => item.turn < record.turn).at(-1)
        : previous;
    const stored: StoredCheckpoint = base
      ? {
          ...record,
          baseId: base.id,
          files: Object.fromEntries(
            Object.entries(record.files).filter(([name, blob]) => base.files[name] !== blob),
          ),
          modes: Object.fromEntries(
            Object.entries(record.modes).filter(([name, mode]) => base.modes[name] !== mode),
          ),
          removed: Object.keys(base.files).filter((name) => !(name in record.files)),
        }
      : record;
    const destination = this.recordPath(record.id);
    const content = JSON.stringify(stored);
    await fs.writeFile(destination + '.tmp', content, { mode: 0o600 });
    await fs.rename(destination + '.tmp', destination);
    this.account(destination + '.tmp', 0);
    this.account(destination, Buffer.byteLength(content));
    if (this.cached?.sessionId === record.sessionId)
      this.cached.records = [...this.cached.records.filter((item) => item.id !== record.id), record].sort(
        (a, b) => a.turn - b.turn,
      );
  }
  private async observe(
    sessionId: string,
    now: Record<string, string>,
    source: 'pi' | 'manual',
    names?: string[],
  ) {
    const state = await this.state(sessionId);
    const paths = (names ?? [...new Set([...Object.keys(state.known), ...Object.keys(now)])]).filter(
      (name) => state.known[name] !== now[name],
    );
    if (paths.length) {
      state.activity.push({ cursor: ++state.cursor, paths, source });
      for (const name of paths) {
        if (now[name] === undefined) delete state.known[name];
        else state.known[name] = now[name];
      }
      await this.saveState(sessionId, state);
    }
    return state;
  }
  async scan(project: Project, names?: string[]) {
    const selected = names ?? (await allFiles(project));
    const { files, omitted } = await snapshotCandidates(project.path, selected);
    if (omitted.length && names)
      throw new Error('无法安全读取工具将修改的文件，已停止执行，请检查文件路径和权限');
    const ids = await hashBlobs(
      project.path,
      files.map((file) => file.name),
    );
    return Object.fromEntries(files.map((file, i) => [file.name, fingerprint(ids[i], file.mode)]));
  }
  private async scanSession(project: Project, sessionId: string, names?: string[]) {
    if (names) return this.scan(project, names);
    const state = await this.state(sessionId);
    const candidates = [...new Set([...(await allFiles(project)), ...Object.keys(state.known)])];
    const { files, omitted } = await snapshotCandidates(project.path, candidates);
    if (omitted.some((name) => name in state.known))
      throw new Error('部分文件无法读取，无法确认命令执行前后的文件变化，请检查文件权限后重试');
    const previous = this.scanHashes.get(sessionId);
    const cached = previous?.root === project.path ? previous.files : undefined;
    const changed = files.filter((file) => cached?.get(file.name)?.stamp !== file.stamp);
    const ids = await hashBlobs(
      project.path,
      changed.map((file) => file.name),
    );
    const updated = new Map(changed.map((file, index) => [file.name, ids[index]]));
    const current = new Map(
      files.map((file) => [
        file.name,
        { stamp: file.stamp, id: updated.get(file.name) ?? cached!.get(file.name)!.id },
      ]),
    );
    this.scanHashes.set(sessionId, { root: project.path, files: current });
    return Object.fromEntries(
      files.map((file) => [file.name, fingerprint(current.get(file.name)!.id, file.mode)]),
    );
  }
  capture(project: Project, sessionId: string, turn: number, timestamp?: number) {
    return this.serialize(() => this.captureUnlocked(project, sessionId, turn, timestamp));
  }
  private async captureUnlocked(
    project: Project,
    sessionId: string,
    turn: number,
    timestamp?: number,
  ): Promise<CheckpointSummary | undefined> {
    safeId(sessionId);
    if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('检查点轮次无效');
    let meta;
    try {
      meta = await info(project.path);
    } catch {
      return undefined;
    }
    const state = await this.state(sessionId);
    if (turn <= state.lastTurn) throw new Error('该轮检查点已经存在，请刷新会话后重试');
    const repo = `session-${sessionId}-objects.git`;
    await fs.mkdir(this.directory, { recursive: true });
    try {
      await fs.access(path.join(this.directory, repo, 'HEAD'));
    } catch {
      await createSnapshotRepo(path.join(this.directory, repo), project.path);
      if (this.storage)
        await snapshotStorageBytes(path.join(this.directory, repo), (file, size) => this.account(file, size));
    }
    const cached =
      this.hashes?.sessionId === sessionId
        ? this.hashes.files
        : new Map<string, { stamp: string; id: string; mode: number }>();
    const names = await allFiles(project);
    // Git's private raw-byte index performs the full native stat scan. POSIX still needs lstat for
    // permission bits that Git does not track; Windows uses the changed-path list for safe path checks.
    const changedNames =
      cached.size && isWindows
        ? new Set(await changedSnapshotFiles(path.join(this.directory, repo), project.path))
        : undefined;
    if (changedNames) {
      // Windows Git may miss same-size edits whose mtime was restored. A boundary scan's
      // observed content change must invalidate the stored blob even if the index reports clean.
      const observed = this.scanHashes.get(sessionId);
      if (observed?.root === project.path)
        for (const [name, file] of observed.files)
          if (cached.get(name)?.id !== file.id) changedNames.add(name);
      // The native index may see unchanged children after their directory is replaced by a
      // junction to the original location. Recheck every parent directory before reusing a blob.
      const parents = new Set<string>();
      for (const name of names) {
        const parts = name.split('/');
        for (let index = 1; index < parts.length; index++) parents.add(parts.slice(0, index).join('/'));
      }
      const unsafe = new Set<string>();
      await Promise.all(
        [...parents].map(async (directory) => {
          try {
            if ((await fs.lstat(path.resolve(project.path, directory))).isSymbolicLink())
              unsafe.add(directory);
          } catch {
            unsafe.add(directory);
          }
        }),
      );
      for (const name of names)
        if ([...unsafe].some((directory) => name.startsWith(directory + '/'))) changedNames.add(name);
    }
    const candidates = await snapshotCandidates(
      project.path,
      changedNames ? names.filter((name) => changedNames.has(name) || !cached.has(name)) : names,
    );
    const files = [
      ...(changedNames
        ? names
            .filter((name) => cached.has(name) && !changedNames.has(name))
            .map((name) => ({ name, mode: cached.get(name)!.mode, stamp: cached.get(name)!.stamp }))
        : []),
      ...candidates.files,
    ];
    const omitted = candidates.omitted;
    const changed = files.filter(
      (file) =>
        !cached.has(file.name) || cached.get(file.name)?.stamp !== file.stamp || changedNames?.has(file.name),
    );
    const stored = await storeBlobs(
      path.join(this.directory, repo),
      project.path,
      changed.map((file) => file.name),
    );
    await this.measureFiles(
      [...new Set(stored)]
        .map((id) => path.join(this.directory, repo, 'objects', id.slice(0, 2), id.slice(2)))
        .filter((file) => !this.storage?.files.has(file)),
    );
    const updated = new Map(changed.map((file, index) => [file.name, stored[index]]));
    const ids = files.map((file) => updated.get(file.name) ?? cached.get(file.name)!.id);
    const present = new Set(files.map((file) => file.name));
    const removed = [...cached.keys()]
      .filter((name) => !present.has(name))
      .map((name) => ({ name, id: cached.get(name)!.id }));
    await updateSnapshotIndex(
      path.join(this.directory, repo),
      project.path,
      changed.map((file) => ({ ...file, id: updated.get(file.name)! })),
      removed,
      !cached.size,
    );
    await this.measureFiles([path.join(this.directory, repo, 'index')]);
    this.hashes = {
      sessionId,
      files: new Map(
        files.map((file, index) => [file.name, { stamp: file.stamp, id: ids[index], mode: file.mode }]),
      ),
    };
    this.scanHashes.set(sessionId, { root: project.path, files: this.hashes.files });
    const now = Object.fromEntries(files.map((file, i) => [file.name, fingerprint(ids[i], file.mode)]));
    if (state.lastTurn) await this.observe(sessionId, now, 'manual');
    else state.known = now;
    const status = meta.status;
    const dirty: string[] = [];
    const statusEntries = status.split('\0');
    for (let i = 0; i < statusEntries.length; i++) {
      const entry = statusEntries[i];
      if (!entry) continue;
      const relative = path
        .relative(project.path, path.resolve(meta.gitRoot, entry.slice(3)))
        .replaceAll('\\', '/');
      dirty.push(relative);
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    const record: CheckpointRecord = {
      version: 3,
      id: `${sessionId}-${turn}`,
      projectId: project.id,
      sessionId,
      turn,
      timestamp,
      fingerprint: meta.fingerprint,
      branch: meta.branch,
      branchHistory: meta.branchHistory,
      head: meta.head,
      time: Date.now(),
      repo,
      files: Object.fromEntries(files.map((file, i) => [file.name, ids[i]])),
      modes: Object.fromEntries(files.map((file) => [file.name, file.mode])),
      dirty,
      omitted,
      cursor: state.cursor,
    };
    await this.write(record);
    state.lastTurn = turn;
    await this.saveState(sessionId, state);
    await this.cleanupUnlocked(sessionId);
    if (!(await this.get(sessionId, record.id)))
      throw new Error('本轮检查点超过 200 MiB 的保留上限，请缩小项目范围后重试');
    return this.summary(record, meta);
  }
  bind(project: Project, sessionId: string, id: string, timestamp: number) {
    return this.serialize(() => this.bindUnlocked(project, sessionId, id, timestamp));
  }
  private async bindUnlocked(project: Project, sessionId: string, id: string, timestamp: number) {
    const record = await this.get(sessionId, id);
    if (!record || record.projectId !== project.id) throw new Error('检查点已不存在，请重新发送任务');
    record.timestamp = timestamp;
    await this.write(record);
  }
  summary(
    record: CheckpointRecord,
    meta: { branch: string; head: string; branchHistory?: string },
  ): CheckpointSummary {
    const invalidReason =
      record.invalidReason ||
      (record.branch !== meta.branch ||
      (meta.branchHistory !== undefined && record.branchHistory !== meta.branchHistory)
        ? 'Git 分支已切换，此检查点已失效'
        : undefined);
    return {
      id: record.id,
      sessionId: record.sessionId,
      turn: record.turn,
      timestamp: record.timestamp,
      time: record.time,
      available: !invalidReason,
      invalidReason,
      includesCommitted: record.head !== meta.head,
    };
  }
  async list(project: Project, sessionId: string, metadata?: Awaited<ReturnType<typeof info>> | null) {
    const records = (await this.records(sessionId)).filter((record) => record.projectId === project.id);
    if (!records.length) return [];
    let meta = metadata;
    try {
      if (meta === undefined) meta = await info(project.path);
    } catch {}
    if (!meta) {
      return records.map((record) => ({
        ...this.summary(record, { branch: '', head: '' }),
        available: false,
        invalidReason: '当前项目无法读取 Git 状态',
      }));
    }
    for (const record of records)
      if (
        !record.invalidReason &&
        (record.branch !== meta.branch || record.branchHistory !== meta.branchHistory)
      ) {
        record.invalidReason = 'Git 分支已切换，此检查点已失效';
      }
    return records.map((record) => this.summary(record, meta));
  }
  async manualPaths(record: CheckpointRecord, now: Record<string, string>) {
    const state = await this.state(record.sessionId);
    const manual = new Set(
      state.activity
        .filter((event) => event.cursor > record.cursor && event.source === 'manual')
        .flatMap((event) => event.paths),
    );
    for (const name of new Set([...Object.keys(state.known), ...Object.keys(now)]))
      if (state.known[name] !== now[name]) manual.add(name);
    return manual;
  }
  beginTool(
    project: Project,
    sessionId: string,
    toolId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    return this.serialize(() => this.beginToolUnlocked(project, sessionId, toolId, name, args));
  }
  private async beginToolUnlocked(
    project: Project,
    sessionId: string,
    toolId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    const command = name === 'bash' || name === 'powershell';
    const write = name === 'edit' || name === 'write';
    if (!command && !write) return;
    let names: string[] | undefined;
    if (write) {
      if (typeof args.path !== 'string') throw new Error('写入工具缺少文件路径，无法建立撤销记录');
      const relative = path
        .relative(project.path, normalizePiToolPath(project.path, args.path))
        .replaceAll('\\', '/');
      // Outside/sensitive tool approvals remain possible, but they cannot be attributed or reverted here.
      const { omitted } = await snapshotCandidates(project.path, [relative]);
      if (omitted.length) return;
      names = [relative];
    }
    if (!(await this.get(sessionId))) return;
    const before = await this.scanSession(project, sessionId, names);
    await this.observe(sessionId, before, 'manual', names);
    const root = await canonicalWritePath(project.path);
    const others = [...this.tools.values()].filter(
      (tool) =>
        tool.sessionId !== sessionId &&
        (isWithinDirectory(root, tool.root) || isWithinDirectory(tool.root, root)),
    );
    for (const tool of others) tool.overlapping = true;
    this.tools.set(`${sessionId}:${toolId}`, {
      projectId: project.id,
      root,
      sessionId,
      names,
      before,
      overlapping: others.length > 0,
    });
  }
  endTool(project: Project, sessionId: string, toolId: string) {
    return this.serialize(() => this.endToolUnlocked(project, sessionId, toolId));
  }
  endSessionTools(project: Project, sessionId: string) {
    return this.serialize(async () => {
      const pending = [...this.tools.entries()].filter(([, boundary]) => boundary.sessionId === sessionId);
      if (!pending.length) return;
      for (const [key] of pending) this.tools.delete(key);
      // Termination is confirmed, but partial writes have no reliable tool result.
      await this.observe(sessionId, await this.scanSession(project, sessionId), 'manual');
    });
  }
  private async endToolUnlocked(project: Project, sessionId: string, toolId: string) {
    const key = `${sessionId}:${toolId}`,
      boundary = this.tools.get(key);
    if (!boundary) return;
    this.tools.delete(key);
    const after = await this.scanSession(project, sessionId, boundary.names);
    const changed = (
      boundary.names ?? [...new Set([...Object.keys(boundary.before), ...Object.keys(after)])]
    ).filter((name) => boundary.before[name] !== after[name]);
    // Concurrent commands can observe another chat's edits. Keep ambiguous paths
    // unchecked in the undo preview instead of claiming they belong to this turn.
    await this.observe(sessionId, after, boundary.overlapping ? 'manual' : 'pi', changed);
  }
  cleanup(cleanupBaselines?: () => Promise<void>) {
    return this.serialize(async () => {
      await cleanupBaselines?.();
      await this.cleanupUnlocked();
    });
  }
  private async cleanupUnlocked(sessionId?: string) {
    const now = Date.now();
    const full = !sessionId || !this.storage || now - this.lastCleanup >= CLEANUP_INTERVAL;
    const parent = path.dirname(this.directory);
    if (full) {
      this.storage = { bytes: 0, files: new Map() };
      await snapshotStorageBytes(parent, (file, size) => this.account(file, size));
    }
    const records = await this.records(full ? undefined : sessionId);
    const legacy: { file: string; repo: string; time: number }[] = [];
    for (const name of full ? await fs.readdir(parent).catch(() => [] as string[]) : []) {
      if (!/^[\w-]+\.json$/.test(name)) continue;
      const file = path.join(parent, name);
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as SnapshotData;
      if (value.version === 3 && value.projectId + '.json' === name && /^[\w-]+-\d+\.git$/.test(value.repo))
        legacy.push({ file, repo: path.join(parent, value.repo), time: value.time });
    }
    const remove = new Set<string>();
    const grouped = new Map<string, CheckpointRecord[]>();
    for (const record of records)
      grouped.set(record.sessionId, [...(grouped.get(record.sessionId) ?? []), record]);
    for (const group of grouped.values())
      for (const record of group.slice(0, Math.max(0, group.length - 20))) remove.add(record.id);
    for (const record of records) if (now - record.time > 7 * 86400000) remove.add(record.id);
    const discard = async () => {
      // Materialize the earliest retained turn before deleting any parent in its delta chain.
      for (const [sessionId, group] of grouped) {
        const discarded = group.filter((record) => remove.has(record.id));
        if (!discarded.length) continue;
        const live = group.filter((record) => !remove.has(record.id));
        for (let index = 0; index < live.length; index++)
          await this.write(live[index], index ? live[index - 1] : null);
        for (const record of discarded) await this.removeStored(this.recordPath(record.id));
        grouped.set(sessionId, live);
        if (this.cached?.sessionId === sessionId) this.cached.records = live;
        const repo = this.repoPath(group[0]);
        if (!live.length) {
          await this.removeStored(repo, true);
          if (this.hashes?.sessionId === sessionId) this.hashes = undefined;
          this.scanHashes.delete(sessionId);
          const state = await this.state(sessionId);
          state.known = {};
          state.activity = [];
          await this.saveState(sessionId, state);
          continue;
        }
        const retained = new Set(live.flatMap((record) => Object.values(record.files)));
        const objects = path.join(repo, 'objects');
        const candidates = new Set(discarded.flatMap((record) => Object.values(record.files)));
        // Normal retention only considers objects from the removed turns. A full sweep also
        // reclaims loose objects left behind by interrupted captures.
        if (full)
          for (const prefix of await fs.readdir(objects)) {
            if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
            for (const suffix of await fs.readdir(path.join(objects, prefix)))
              if (/^[0-9a-f]+$/.test(suffix)) candidates.add(prefix + suffix);
          }
        for (const id of candidates)
          if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id) && !retained.has(id))
            await this.removeStored(path.join(objects, id.slice(0, 2), id.slice(2)));
        const state = await this.state(sessionId);
        state.activity = state.activity.filter(
          (event) => event.cursor > Math.min(...live.map((record) => record.cursor)),
        );
        await this.saveState(sessionId, state);
      }
    };
    if (remove.size) await discard();
    if (!full) {
      // Enforce the quota every turn. Reconcile once before evicting across sessions.
      if (this.storage!.bytes > STORAGE_LIMIT) await this.cleanupUnlocked();
      return;
    }
    const oldest = records.slice().sort((a, b) => a.time - b.time);
    legacy.sort((a, b) => a.time - b.time);
    while (this.storage!.bytes > STORAGE_LIMIT) {
      const record = oldest.find((item) => !remove.has(item.id));
      if (legacy.length && (!record || legacy[0].time <= record.time)) {
        const expired = legacy.shift()!;
        await this.removeStored(expired.file);
        await this.removeStored(expired.repo, true);
        continue;
      }
      if (!record) break;
      remove.add(record.id);
      await discard();
    }
    this.lastCleanup = now;
  }
}
