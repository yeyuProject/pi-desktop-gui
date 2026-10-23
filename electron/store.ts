import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type {
  AppState,
  ImageAttachment,
  DraftImage,
  IndexRecovery,
  Message,
  Session,
  StorageStatus,
} from '../shared/types';
import { validateImages } from './images';
import { imageDataBytes, MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_IMAGES_BYTES } from '../shared/images';
import { matchesDraft } from '../shared/draft';
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
  private imageFiles = new WeakMap<DraftImage, string>();
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
    this.imageFiles = new WeakMap();
    this.writtenImages.clear();
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
      let total = 0;
      for (let index = 0; index < session.images.length; index++) {
        const { file, ...metadata } = session.images[index];
        if (typeof file !== 'string' || !/^[a-f0-9]{64}\.bin$/.test(file))
          throw new Error('草稿图片索引无效，原文件已保留');
        const imagePath = this.file(path.join('draft-images', file));
        const stat = await fs.stat(imagePath);
        if (!stat.isFile() || !stat.size || stat.size > MAX_IMAGE_BYTES)
          throw new Error('草稿图片格式无效或超过大小限制');
        if (
          typeof metadata.id !== 'string' ||
          typeof metadata.name !== 'string' ||
          metadata.name.length > 512 ||
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(metadata.mimeType)
        )
          throw new Error('草稿图片格式无效');
        total += stat.size;
        const image = {
          id: metadata.id,
          name: metadata.name,
          mimeType: metadata.mimeType,
          file,
          bytes: stat.size,
        };
        session.images[index] = image;
        this.imageFiles.set(image, file);
      }
      if (total > MAX_IMAGES_BYTES) throw new Error('草稿图片超过总大小限制');
    }
    return parseState({ ...raw, version: 1 });
  }
  async draftImages(id: string): Promise<ImageAttachment[]> {
    const images = this.session(id).images ?? [];
    const result: ImageAttachment[] = [];
    try {
      for (const image of images) {
        if (image.data !== undefined) result.push({ ...image, data: image.data });
        else {
          if (!image.file || !/^[a-f0-9]{64}\.bin$/.test(image.file)) throw new Error('草稿图片索引无效');
          const file = this.file(path.join('draft-images', image.file));
          if ((await fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error('草稿图片超过大小限制');
          const bytes = await fs.readFile(file);
          if (createHash('sha256').update(bytes).digest('hex') + '.bin' !== image.file)
            throw new Error('草稿图片校验失败');
          result.push({
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            data: bytes.toString('base64'),
          });
        }
      }
      validateImages(result);
    } catch (error) {
      this.storage = {
        ...this.storage,
        writable: false,
        problem:
          '草稿图片读取或校验失败，已暂停发送和保存，原文件已保留。请检查数据目录中的 draft-images，恢复图片后重启。',
      };
      this.emit('storage', this.storage);
      throw new Error(this.storage.problem, { cause: error });
    }
    for (const image of images) if (image.file) this.writtenImages.add(image.file);
    return result;
  }
  matchesDraft(session: Session, text: string, attachments: string[], images: ImageAttachment[]) {
    // Recompute, never trust a renderer-supplied file/hash when consuming a saved draft.
    return matchesDraft(
      session,
      text,
      attachments,
      images.map((image) => ({
        ...image,
        file: createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') + '.bin',
      })),
    );
  }
  appendDraftImages(session: Session, images: ImageAttachment[]) {
    validateImages(images);
    const current = session.images ?? [];
    const bytes = [...current, ...images].reduce(
      (sum, image) =>
        sum +
        (image.data !== undefined
          ? imageDataBytes(image.data)
          : ((image as DraftImage).bytes ?? MAX_IMAGE_BYTES)),
      0,
    );
    if (current.length + images.length > MAX_IMAGE_COUNT || bytes > MAX_IMAGES_BYTES)
      throw new Error('恢复的图片超过附件限制');
    session.images = [...current, ...images];
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
            let file = image.data === undefined ? image.file : this.imageFiles.get(image);
            if (!file) {
              if (image.data === undefined) throw new Error('草稿图片索引无效');
              file = createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') + '.bin';
              this.imageFiles.set(image, file);
            }
            if (image.data !== undefined) images.set(file, image.data);
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
        // Release bodies only after durable image files exist. Late draft edits
        // keep their own identities and cannot be replaced by this older save.
        for (const session of this.state.sessions) {
          if (!session.images?.some((image) => image.data !== undefined)) continue;
          session.images = session.images.map((image) => {
            const file = this.imageFiles.get(image);
            return image.data !== undefined && file && this.writtenImages.has(file)
              ? {
                  id: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  file,
                  bytes: imageDataBytes(image.data),
                }
              : image;
          });
        }
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
    const visible = this.projectState(state, true);
    return {
      ...visible,
      sessions: visible.sessions.map((session) =>
        session.images?.length
          ? { ...session, images: session.images.map(({ data: _data, ...image }) => image) }
          : session,
      ),
    };
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

type Transcript = { cwd: string; name?: string; messages: Message[]; stats: SessionUsage };
const transcriptCache = new Map<string, { stamp: string; bytes: number; value: Transcript }>();
const transcriptReads = new Map<string, Promise<Transcript>>();
const transcriptBudget = 32 * 1024 * 1024;
const transcriptStamp = (stat: NonNullable<Awaited<ReturnType<typeof fs.stat>>>) =>
  `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
export async function readSessionFile(file: string): Promise<Transcript> {
  const key = path.resolve(file);
  const stat = await fs.stat(key);
  if (stat.size > 64 * 1024 * 1024) throw new Error('会话文件超过 64 MiB，请在 Pi 中压缩或导出后再导入');
  const stamp = transcriptStamp(stat);
  const cached = transcriptCache.get(key);
  transcriptCache.delete(key);
  if (cached?.stamp === stamp) {
    transcriptCache.set(key, cached);
    return structuredClone(cached.value);
  }
  const request = key + '\0' + stamp;
  if (stat.size * 2 > transcriptBudget) return readSessionFileUncached(key);
  let pending = transcriptReads.get(request);
  if (!pending) {
    pending = (async () => {
      const value = await readSessionFileUncached(key);
      // Files can be appended/replaced during a read. Never cache that observation.
      if (stat.size * 2 <= transcriptBudget && transcriptStamp(await fs.stat(key)) === stamp) {
        transcriptCache.delete(key);
        transcriptCache.set(key, { stamp, bytes: stat.size * 2, value });
        let total = [...transcriptCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const [id, entry] of transcriptCache) {
          if (total <= transcriptBudget && transcriptCache.size <= 200) break;
          transcriptCache.delete(id);
          total -= entry.bytes;
        }
      }
      return value;
    })();
    transcriptReads.set(request, pending);
    void pending
      .finally(() => {
        if (transcriptReads.get(request) === pending) transcriptReads.delete(request);
      })
      .catch(() => {});
  }
  // Agents mutate live replies; no reader may mutate the shared cache/in-flight result.
  return structuredClone(await pending);
}
async function readSessionFileUncached(
  file: string,
): Promise<{ cwd: string; name?: string; messages: Message[]; stats: SessionUsage }> {
  const stat = await fs.stat(file);
  if (stat.size > 64 * 1024 * 1024) throw new Error('会话文件超过 64 MiB，请在 Pi 中压缩或导出后再导入');
  const raw = await fs.readFile(file, 'utf8');
  const entries: any[] = [];
  const lines = raw.split('\n');
  let yielded = performance.now();
  for (let i = 0; i < lines.length; i++) {
    if (performance.now() - yielded >= 4) {
      await yieldToEvents();
      yielded = performance.now();
    }
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
