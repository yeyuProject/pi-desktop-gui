import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lock } from 'proper-lockfile';
import { agentDirectory } from './environment';
import type { ConfigDocument, ConfigKind, ConfigSaveResult } from '../shared/types';
import { redact } from '../shared/errors';
import type { Store } from './store';
const hidden = '[已保存的密钥]';
const sensitive = /api.?key|token|password|secret|authorization|headers|env|auth/i;
function mask(value: any, secret = false): any {
  if (typeof value === 'string') return secret && value ? hidden : value;
  if (Array.isArray(value)) return value.map((v) => mask(v, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mask(v, secret || sensitive.test(k))]),
    );
  return value;
}
function restore(value: any, original: any): any {
  if (value === hidden) {
    if (typeof original !== 'string')
      throw new Error('密钥占位符必须保留在原位置；新配置请填写真实值或环境变量名');
    return original;
  }
  if (Array.isArray(value)) return value.map((v, i) => restore(v, original?.[i]));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, original?.[k])]));
  return value;
}
const revision = (s: string) => createHash('sha256').update(s).digest('hex');
const parseConfig = (text: string) => JSON.parse(text.replace(/^\uFEFF/, ''));
export class Configuration {
  constructor(private store: Store) {}
  private async file(id: string, kind: ConfigKind, local: boolean) {
    if (!['settings', 'models', 'mcp'].includes(kind) || typeof local !== 'boolean')
      throw new Error('配置类型无效');
    const session = this.store.session(id);
    if (local && (kind === 'models' || !session.projectId || !this.store.project(session.projectId).trusted))
      throw new Error('此配置只支持个人范围，或项目尚未启用');
    return path.join(
      local
        ? path.join(await this.store.sessionDirectory(id), '.pi')
        : agentDirectory(this.store.state.settings),
      kind + '.json',
    );
  }
  private async raw(file: string) {
    return fs.readFile(file, 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return '{}';
      throw e;
    });
  }
  async read(id: string, kind: ConfigKind, local: boolean): Promise<ConfigDocument> {
    const file = await this.file(id, kind, local),
      raw = await this.raw(file);
    try {
      return { text: JSON.stringify(mask(parseConfig(raw)), null, 2), revision: revision(raw), path: file };
    } catch {
      return {
        text: raw.replace(/^\uFEFF/, ''),
        revision: revision(raw),
        path: file,
        error:
          '配置不是有效的 JSON，已载入原文供修复。原文可能包含密钥，请勿分享截图或复制到公开位置。修正括号、逗号和引号后可保存；保存前会备份原文件。',
      };
    }
  }
  async saveAndApply(
    id: string,
    kind: ConfigKind,
    local: boolean,
    document: ConfigDocument,
    apply: () => Promise<ConfigSaveResult>,
  ): Promise<ConfigSaveResult> {
    await this.save(id, kind, local, document);
    try {
      const result = await apply();
      return result.warning ? { ...result, warning: redact(result.warning) } : result;
    } catch (error) {
      // The file is already persisted. A failed reconnect must not be reported as a failed write.
      return { applied: false, warning: redact(error instanceof Error ? error.message : String(error)) };
    }
  }
  async save(id: string, kind: ConfigKind, local: boolean, document: ConfigDocument) {
    const file = await this.file(id, kind, local);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Native Pi's SettingsManager uses this same lock. Keep its writes and our revision check atomic.
    const release = await lock(file, {
      realpath: false,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 25 },
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOCKED')
        throw new Error('配置正由 Pi 或其他程序保存，请稍后重新读取再保存', { cause: error });
      throw error;
    });
    try {
      await this.saveLocked(file, kind, document);
    } finally {
      await release();
    }
  }
  private async saveLocked(file: string, kind: ConfigKind, document: ConfigDocument) {
    const raw = await this.raw(file);
    if (document.revision !== revision(raw)) throw new Error('配置已被其他程序修改，请重新读取后再保存');
    let parsed: any;
    try {
      parsed = parseConfig(document.text);
    } catch (error) {
      throw new Error('配置不是有效的 JSON，请检查括号、逗号和引号', { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('配置必须是 JSON 对象');
    let original: unknown;
    try {
      original = parseConfig(raw);
    } catch {
      /* Invalid input is deliberately repaired by this save. */
    }
    const value = restore(parsed, original);
    if (
      kind === 'models' &&
      value.providers !== undefined &&
      (!value.providers || Array.isArray(value.providers) || typeof value.providers !== 'object')
    )
      throw new Error('providers 必须是对象');
    if (
      kind === 'mcp' &&
      value.mcpServers !== undefined &&
      (!value.mcpServers || Array.isArray(value.mcpServers) || typeof value.mcpServers !== 'object')
    )
      throw new Error('mcpServers 必须是对象');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.desktop-backup', raw, { mode: 0o600 });
    await fs.writeFile(file + '.desktop-tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    if (revision(await this.raw(file)) !== revision(raw)) throw new Error('保存前配置发生了变化，请重新读取');
    await fs.rename(file + '.desktop-tmp', file);
  }
}
