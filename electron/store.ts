import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AppState,
  ImageAttachment,
  IndexRecovery,
  Message,
  Session,
  StorageStatus,
} from '../shared/types';
import { validateImages } from './images';
import { MAX_IMAGE_BYTES, MAX_IMAGE_COUNT } from '../shared/images';
import { emptyState, parseState } from './store-state';
import { compareAppVersions, stableVersion } from '../shared/app-update';
import { sessionUsage } from './pi/session-usage';
import type { SessionUsage } from '../shared/usage';
import { isReusableSession } from './session-lifecycle';
export { defaultSettings } from './store-state';

const BACKUP_INTERVAL = 10 * 60 * 1000;
export class Store extends EventEmitter {
  state = emptyState();
  storage: StorageStatus = { writable: true };
  private writing = Promise.resolve();
  private deferredSave?: {
    timer: NodeJS.Timeout;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  private imageFiles = new WeakMap<ImageAttachment, string>();
  private writtenImages = new Set<string>();
  // Keep stable IDs for late draft IPC, but never infer this status from loaded blank rows.
  private transientSessions = new Set<string>();
  constructor(
    readonly dir: string,
    private readonly appVersion?: string,
  ) {
    super();
  }
  private file(name: string) {
    return path.join(this.dir, name);
  }
  private writeFailure(error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    this.storage = {
      ...this.storage,
      writable: false,
      problem: `无法写入本地数据目录，发送与保存已暂停。请检查磁盘剩余空间和目录权限后重新启动${code ? `（${code}）` : ''}。`,
    };
    this.emit('storage', this.storage);
  }
  assertWritable() {
    if (!this.storage.writable) throw new Error(this.storage.problem);
  }
  async load() {
    this.transientSessions.clear();
    this.state = emptyState();
    this.storage = { writable: true };
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch (error) {
      this.writeFailure(error);
    }
    let contents: string | undefined;
    try {
      contents = await fs.readFile(this.file('state.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.writeFailure(error);
    }
    if (contents !== undefined) {
      let valid: ReturnType<typeof parseState> | undefined;
      let raw: unknown;
      try {
        raw = JSON.parse(contents);
      } catch {}
      if (
        raw &&
        typeof raw === 'object' &&
        'version' in raw &&
        typeof raw.version === 'number' &&
        Number.isInteger(raw.version) &&
        raw.version > 2
      ) {
        const writer = 'appVersion' in raw ? stableVersion(raw.appVersion) : undefined;
        this.storage = {
          writable: false,
          newerFormat: { version: raw.version, appVersion: writer },
          problem: `本地数据来自更新的 Pi Desktop${writer ? `，请使用 v${writer} 或更高版本` : '，请更新应用后再打开'}。当前仅以只读方式打开，原文件不会被改写。`,
        };
        return this.storage;
      }
      try {
        valid = await this.parseStoredState(raw);
      } catch {
        if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 2) {
          this.storage = {
            writable: false,
            problem:
              '无法完整读取本地索引或草稿图片，已停止写入以保留原数据。请检查数据目录中的 state.json 和 draft-images，恢复缺失文件后重启。',
          };
          return this.storage;
        }
      }
      if (valid) this.state = valid.state;
      if (valid && this.appVersion) {
        try {
          await this.backupBeforeUpgrade(contents, valid.state.appVersion);
        } catch (error) {
          this.writeFailure(error);
        }
      }
      if (!valid || valid.discardedProjects || valid.discardedSessions || valid.repairedSettings) {
        const recovery = {
          corruptFile: this.file(`state.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.json`),
          discardedProjects: valid?.discardedProjects ?? 0,
          discardedSessions: valid?.discardedSessions ?? 0,
          repairedSettings: valid?.repairedSettings ?? 0,
          restarted: !valid,
        };
        this.storage.recovery = recovery;
        if (this.storage.writable) {
          try {
            await fs.rename(this.file('state.json'), recovery.corruptFile);
          } catch (error) {
            recovery.corruptFile = this.file('state.json');
            this.writeFailure(error);
          }
        } else {
          recovery.corruptFile = this.file('state.json');
        }
        if (!valid) await this.restoreBackup(recovery);
      }
    }
    // A previous recovery may have preserved the corrupt file and exited before its first save.
    // The missing current index must not overwrite the existing backups with an empty state.
    if (contents === undefined) await this.restoreBackup();
    if (this.storage.writable) {
      const probe = this.file(`.write-probe-${randomUUID()}`);
      try {
        await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
        await fs.unlink(probe);
      } catch (error) {
        this.writeFailure(error);
      }
    }
    return this.storage;
  }
  private async restoreBackup(recovery?: IndexRecovery) {
    let unreadableImages = false;
    for (let i = 1; i <= 3; i++) {
      const backup = this.file(`state.backup-${i}.json`);
      try {
        const raw = JSON.parse(await fs.readFile(backup, 'utf8'));
        let parsed: ReturnType<typeof parseState>;
        try {
          parsed = await this.parseStoredState(raw);
        } catch (error) {
          if (raw?.version === 2) unreadableImages = true;
          throw error;
        }
        const backupAt = (await fs.stat(backup)).mtimeMs;
        this.state = parsed.state;
        this.storage.recovery = {
          ...recovery,
          recoveredFrom: backup,
          backupAt,
          discardedProjects: parsed.discardedProjects,
          discardedSessions: parsed.discardedSessions,
          repairedSettings: parsed.repairedSettings,
          restarted: false,
        };
        return;
      } catch {}
    }
    if (unreadableImages)
      this.storage = {
        ...this.storage,
        writable: false,
        problem:
          '备份引用的草稿图片无法读取或校验，已停止写入以保留原数据。请恢复数据目录中的 draft-images 后重启。',
      };
  }
  private async backupBeforeUpgrade(contents: string, previous?: string) {
    const version = stableVersion(previous);
    if (version && compareAppVersions(version, this.appVersion!) >= 0) return;
    // Older releases did not record appVersion; preserve that file without inventing its version.
    await this.replace(`state.pre-${version ?? 'unversioned'}.json`, contents);
    const backups = await Promise.all(
      (await fs.readdir(this.dir))
        .filter((name) => /^state\.pre-(?:\d+\.\d+\.\d+|unversioned)\.json$/.test(name))
        .map(async (name) => ({ name, modified: (await fs.stat(this.file(name))).mtimeMs })),
    );
    backups.sort((a, b) => b.modified - a.modified);
    for (const backup of backups.slice(3)) await fs.unlink(this.file(backup.name));
  }
  private async replace(name: string, contents: string | Buffer) {
    const temporary = this.file(name + '.tmp');
    await fs.writeFile(temporary, contents, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, this.file(name));
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  private async parseStoredState(raw: any) {
    if (raw?.version !== 2) return parseState(raw);
    if (!Array.isArray(raw.sessions)) throw new Error('本地索引格式不受支持');
    for (const session of raw.sessions) {
      if (!Array.isArray(session?.images)) continue;
      if (session.images.length > MAX_IMAGE_COUNT) throw new Error('草稿图片数量无效');
      for (let index = 0; index < session.images.length; index++) {
        const { file, ...metadata } = session.images[index];
        if (typeof file !== 'string' || !/^[a-f0-9]{64}\.bin$/.test(file))
          throw new Error('草稿图片索引无效，原文件已保留');
        const imagePath = this.file(path.join('draft-images', file));
        if ((await fs.stat(imagePath)).size > MAX_IMAGE_BYTES) throw new Error('草稿图片超过大小限制');
        const bytes = await fs.readFile(imagePath);
        if (createHash('sha256').update(bytes).digest('hex') + '.bin' !== file)
          throw new Error('草稿图片校验失败，原文件已保留');
        const image = { ...metadata, data: bytes.toString('base64') };
        validateImages([image]);
        session.images[index] = image;
        this.imageFiles.set(image, file);
        this.writtenImages.add(file);
      }
      validateImages(session.images);
    }
    return parseState({ ...raw, version: 1 });
  }
  /** Coalesce typing, while save/flush remain immediate durability barriers. */
  scheduleSave() {
    if (!this.deferredSave) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => {
        void this.save().catch(() => {});
      }, 300);
      this.deferredSave = { timer, promise, resolve, reject };
    }
    return this.deferredSave.promise;
  }
  private async backup(contents: string) {
    const latest = await fs.stat(this.file('state.backup-1.json')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (latest && Date.now() - latest.mtimeMs < BACKUP_INTERVAL) return;
    for (let i = 2; i >= 1; i--) {
      const source = this.file(`state.backup-${i}.json`),
        target = `state.backup-${i + 1}.json`;
      try {
        const stat = await fs.stat(source);
        await this.replace(target, await fs.readFile(source, 'utf8'));
        await fs.utimes(this.file(target), stat.atime, stat.mtime);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await this.replace('state.backup-1.json', contents);
  }
  save() {
    const deferred = this.deferredSave;
    this.deferredSave = undefined;
    if (deferred) clearTimeout(deferred.timer);
    if (this.appVersion && this.storage.writable) this.state.appVersion = this.appVersion;
    // Capture the projection now, before joining the existing atomic-write queue. Current
    // state and backups must describe the same acknowledged save, not later mutations.
    const images = new Map<string, string>();
    const state = this.persistentState();
    const contents = JSON.stringify(
      {
        ...state,
        version: 2,
        sessions: state.sessions.map((session) => ({
          ...session,
          images: session.images?.map((image) => {
            let file = this.imageFiles.get(image);
            if (!file) {
              file = createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') + '.bin';
              this.imageFiles.set(image, file);
            }
            images.set(file, image.data);
            const { data: _data, ...metadata } = image;
            return { ...metadata, file };
          }),
        })),
      },
      null,
      2,
    );
    const write = async () => {
      this.assertWritable();
      try {
        if (images.size) await fs.mkdir(this.file('draft-images'), { recursive: true });
        for (const [file, data] of images) {
          if (this.writtenImages.has(file)) continue;
          // Immutable content-addressed files keep current and backup indexes consistent.
          await this.replace(path.join('draft-images', file), Buffer.from(data, 'base64'));
          this.writtenImages.add(file);
        }
        await this.replace('state.json', contents);
        await this.backup(contents);
      } catch (error) {
        this.writeFailure(error);
        throw new Error(this.storage.problem, { cause: error });
      }
    };
    this.writing = this.writing.catch(() => {}).then(write);
    if (deferred) void this.writing.then(deferred.resolve, deferred.reject);
    return this.writing;
  }
  flush() {
    return this.deferredSave ? this.save() : this.writing;
  }
  isTransientSession(id: string) {
    return this.transientSessions.has(id);
  }
  promoteSession(id: string) {
    const session = this.session(id);
    this.transientSessions.delete(id);
    return session;
  }
  private promoteSessionData() {
    for (const session of this.state.sessions)
      if (this.transientSessions.has(session.id) && !isReusableSession(session))
        this.transientSessions.delete(session.id);
  }
  durableSessions() {
    this.promoteSessionData();
    return this.state.sessions.filter((session) => !this.transientSessions.has(session.id));
  }
  private projectState(state: AppState, includeSelected: boolean): AppState {
    this.promoteSessionData();
    const sessions = state.sessions.filter(
      (session) =>
        !this.transientSessions.has(session.id) ||
        (includeSelected && session.id === state.selectedSessionId),
    );
    const current = state.sessions.find((session) => session.id === state.selectedSessionId);
    const requestedScope = current ? current.projectId : state.selectedProjectId;
    const scope = state.projects.some((project) => project.id === requestedScope)
      ? requestedScope
      : undefined;
    const selected =
      sessions.find((session) => session.id === state.selectedSessionId) ??
      sessions.find((session) => session.projectId === scope);
    return {
      ...state,
      sessions,
      selectedSessionId: selected?.id,
      selectedProjectId: selected ? selected.projectId : scope,
    };
  }
  persistentState() {
    return this.projectState(this.state, false);
  }
  visibleState(state = this.state) {
    return this.projectState(state, true);
  }
  createPlaceholder(projectId?: string, unavailable: (id: string) => boolean = () => false) {
    if (projectId !== undefined) this.project(projectId);
    this.promoteSessionData();
    // A caller may discover activity not yet represented in the session fields.
    // Fail safe: that ID is now formal, even if the operation later fails.
    for (const session of this.state.sessions)
      if (this.transientSessions.has(session.id) && unavailable(session.id))
        this.transientSessions.delete(session.id);
    const existing = this.state.sessions.find(
      (session) => session.projectId === projectId && this.transientSessions.has(session.id),
    );
    if (existing) {
      this.selectSession(existing.id);
      return existing;
    }
    const session = this.createSession(projectId);
    this.transientSessions.add(session.id);
    return session;
  }
  removeSessions(ids: Iterable<string>) {
    const removed = new Set(ids);
    this.state.sessions = this.state.sessions.filter((session) => !removed.has(session.id));
    for (const id of removed) this.transientSessions.delete(id);
  }
  createSession(projectId?: string) {
    if (projectId !== undefined) this.project(projectId);
    const session: Session = {
      id: randomUUID(),
      projectId,
      title: projectId ? '新会话' : '新对话',
      draft: '',
      attachments: [],
      updatedAt: Date.now(),
      lastStatus: 'idle',
    };
    this.state.sessions.unshift(session);
    this.selectSession(session.id);
    return session;
  }
  selectSession(id: string) {
    const session = this.session(id);
    this.state.selectedSessionId = id;
    this.state.selectedProjectId = session.projectId;
    session.unread = false;
  }
  async sessionDirectory(id: string) {
    const session = this.session(id);
    if (session.projectId) return this.project(session.projectId).path;
    if (session.cwd) return session.cwd;
    const directory = path.join(this.dir, 'chats', 'chat-' + encodeURIComponent(id));
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }
  project(id: string) {
    const p = this.state.projects.find((p) => p.id === id);
    if (!p) throw new Error('项目不存在');
    return p;
  }
  session(id: string) {
    const s = this.state.sessions.find((s) => s.id === id);
    if (!s) throw new Error('会话不存在');
    return s;
  }
}

export async function readSessionFile(
  file: string,
): Promise<{ cwd: string; name?: string; messages: Message[]; stats: SessionUsage }> {
  const stat = await fs.stat(file);
  if (stat.size > 64 * 1024 * 1024) throw new Error('会话文件超过 64 MiB，请在 Pi 中压缩或导出后再导入');
  const raw = await fs.readFile(file, 'utf8');
  const entries: any[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      if (i < lines.length - 1) throw new Error('会话文件包含损坏的 JSON 记录');
    }
  }
  const header = entries.find((e) => e.type === 'session');
  if (!header || typeof header.cwd !== 'string') throw new Error('不是有效的 Pi 会话文件');
  const byId = new Map(entries.filter((e) => e.id && e.type !== 'session').map((e) => [e.id, e]));
  let cursor = entries.findLast((e) => e.id && e.type !== 'session');
  const branch: any[] = [],
    seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    cursor = byId.get(cursor.parentId);
  }
  branch.reverse();
  return {
    cwd: header.cwd,
    name: entries.findLast((e) => e.type === 'session_info')?.name,
    messages: branch.flatMap((e): Message[] => {
      if (e.type === 'message' && e.message) return [e.message];
      if (e.type === 'custom_message')
        return [
          {
            role: 'custom',
            customType: e.customType,
            content: e.content ?? [],
            display: e.display,
            details: e.details,
            timestamp: new Date(e.timestamp).getTime(),
          },
        ];
      if (e.type === 'branch_summary' && e.summary)
        return [
          {
            role: 'branchSummary',
            content: [],
            summary: e.summary,
            fromId: e.fromId,
            timestamp: new Date(e.timestamp).getTime(),
          },
        ];
      return [];
    }),
    stats: sessionUsage(entries),
  };
}
