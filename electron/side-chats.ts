import fs from 'node:fs/promises';
import path from 'node:path';
import type { SideChat, SideChatMessage } from '../shared/side-chat';

/** Desktop-owned history only; never opens or writes a Pi session file. */
export class SideChats {
  private writes = new Map<string, Promise<void>>();
  constructor(private directory: string) {}
  private file(id: string) {
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('会话标识无效');
    return path.join(this.directory, 'side-chats', id + '.json');
  }
  async read(sessionId: string): Promise<SideChat> {
    await this.writes.get(sessionId);
    let messages: SideChatMessage[] = [];
    let omittedTurns = 0;
    try {
      const data: unknown = JSON.parse(await fs.readFile(this.file(sessionId), 'utf8'));
      // v0.14.52 stored only an array. Read it once and save metadata on the next write.
      const record = Array.isArray(data) ? { messages: data, omittedTurns: 0 } : (data as SideChat);
      if (
        !record ||
        !Number.isSafeInteger(record.omittedTurns) ||
        record.omittedTurns < 0 ||
        !Array.isArray(record.messages) ||
        record.messages.some(
          (m) =>
            !m ||
            !['user', 'assistant'].includes(m.role) ||
            typeof m.content !== 'string' ||
            typeof m.id !== 'string' ||
            !Number.isFinite(m.timestamp),
        )
      )
        throw new Error('侧边对话记录损坏，请备份数据目录后清空这段侧边对话');
      messages = record.messages.slice(-100);
      omittedTurns = record.omittedTurns;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { sessionId, messages, omittedTurns };
  }
  save(chat: SideChat) {
    const file = this.file(chat.sessionId);
    const snapshot = JSON.stringify({ messages: chat.messages.slice(-100), omittedTurns: chat.omittedTurns });
    const write = (this.writes.get(chat.sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file + '.tmp', snapshot, 'utf8');
        await fs.rename(file + '.tmp', file);
      });
    this.writes.set(chat.sessionId, write);
    return write;
  }
  async remove(sessionId: string) {
    await this.writes.get(sessionId);
    await fs.rm(this.file(sessionId), { force: true });
    this.writes.delete(sessionId);
  }
}
