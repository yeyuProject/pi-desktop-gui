import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type { Message } from '../shared/types';
import { sessionUsage } from './pi/session-usage';

type Entry = { id: string; parentId?: string; offset: number; length: number; type: string };
/** Index offsets without retaining message bodies, then load a bounded preview of the active branch. */
export async function readLargeTranscript(file: string) {
  const byId = new Map<string, Entry>();
  let last: Entry | undefined, cwd: string | undefined, name: string | undefined;
  let tokens: number | undefined = 0,
    cost: number | undefined = 0;
  let fragments: Buffer[] = [],
    length = 0,
    offset = 0,
    yielded = performance.now();
  const consume = async (bytes: Buffer, final: boolean) => {
    const start = offset;
    offset += bytes.length;
    if (!bytes.toString('utf8').trim()) return;
    let row: any;
    try {
      row = JSON.parse(bytes.toString('utf8'));
    } catch {
      if (final) return;
      throw new Error('会话文件包含损坏的记录，请恢复备份后重试');
    }
    if (row.type === 'session' && typeof row.cwd === 'string') cwd ??= row.cwd;
    if (row.type === 'session_info' && typeof row.name === 'string') name = row.name;
    const usage = sessionUsage([row]);
    tokens = tokens === undefined || usage.tokens === undefined ? undefined : tokens + usage.tokens;
    cost = cost === undefined || usage.cost === undefined ? undefined : cost + usage.cost;
    if (typeof row.id === 'string' && row.type !== 'session') {
      last = { id: row.id, parentId: row.parentId, type: row.type, offset: start, length: bytes.length };
      byId.set(row.id, last);
    }
    if (performance.now() - yielded > 4) {
      await yieldToEvents();
      yielded = performance.now();
    }
  };
  for await (const chunk of createReadStream(file)) {
    let start = 0,
      end: number;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      fragments.push(chunk.subarray(start, end + 1));
      length += end + 1 - start;
      await consume(Buffer.concat(fragments, length), false);
      fragments = [];
      length = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      fragments.push(chunk.subarray(start));
      length += chunk.length - start;
    }
    if (length > 128 * 1024 * 1024) throw new Error('单条会话内容超过读取上限，请在终端打开或导出此会话');
  }
  if (length) await consume(Buffer.concat(fragments, length), true);
  if (!cwd) throw new Error('不是有效的 Pi 会话文件');
  const branch: Entry[] = [],
    seen = new Set<string>();
  let bytes = 0,
    limited = false;
  while (last && !seen.has(last.id)) {
    seen.add(last.id);
    if (['message', 'custom_message', 'branch_summary'].includes(last.type)) {
      if (bytes + last.length > 16 * 1024 * 1024) {
        limited = true;
        break;
      }
      bytes += last.length;
      branch.push(last);
    }
    last = last.parentId ? byId.get(last.parentId) : undefined;
  }
  const messages: Message[] = [];
  const handle = await fs.open(file, 'r');
  try {
    for (const entry of branch.reverse()) {
      const buffer = Buffer.alloc(entry.length);
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, entry.offset + read);
        if (!result.bytesRead) throw new Error('会话文件在读取时发生变化，请重新打开');
        read += result.bytesRead;
      }
      const row = JSON.parse(buffer.toString('utf8'));
      if (row.id !== entry.id) throw new Error('会话文件在读取时发生变化，请重新打开');
      if (row.type === 'message' && row.message) messages.push(row.message);
      else if (row.type === 'custom_message')
        messages.push({
          role: 'custom',
          customType: row.customType,
          content: row.content ?? [],
          display: row.display,
          details: row.details,
          timestamp: new Date(row.timestamp).getTime(),
        });
      else if (row.type === 'branch_summary' && row.summary)
        messages.push({
          role: 'branchSummary',
          content: [],
          summary: row.summary,
          fromId: row.fromId,
          timestamp: new Date(row.timestamp).getTime(),
        });
      await yieldToEvents();
    }
  } finally {
    await handle.close();
  }
  return {
    cwd,
    name,
    messages,
    stats: { tokens, cost },
    warning: limited
      ? '此会话较大，仅显示当前分支最近的内容（最多 16 MiB）。完整历史仍保留，可导出或在 Pi 终端查看。'
      : '此会话较大，已按当前分支读取。完整历史仍保留。',
  };
}
