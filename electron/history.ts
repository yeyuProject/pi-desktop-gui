import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type { PiSessionInfo, Session, SessionMatch } from '../shared/types';
import { pathKey } from './platform';

const HEAD_BYTES = 64 * 1024;
const SEARCH_LIMIT = 16 * 1024 * 1024;

async function jsonlFiles(root: string, depth = 2): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) found.push(full);
    else if (e.isDirectory() && depth > 0) found.push(...(await jsonlFiles(full, depth - 1)));
  }
  return found;
}

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('\n')
      : '';

async function head(file: string) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  let bytes = 0;
  try {
    for await (const line of reader) {
      lines.push(line);
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      // Finish the JSONL record even when an image takes it beyond the preview budget.
      if (bytes >= HEAD_BYTES) break;
    }
    return lines;
  } finally {
    reader.close();
    input.destroy();
  }
}

export async function listPiSessions(roots: string[], known: Set<string>): Promise<PiSessionInfo[]> {
  const files = [...new Set((await Promise.all(roots.map((r) => jsonlFiles(r)))).flat())];
  const result: PiSessionInfo[] = [];
  for (const file of files) {
    if (known.has(pathKey(file))) continue;
    try {
      const stat = await fs.stat(file);
      const lines = await head(file);
      const header = JSON.parse(lines[0]);
      if (header?.type !== 'session' || typeof header.cwd !== 'string') continue;
      let name: string | undefined,
        preview = '',
        hasUserMessage = false;
      for (const line of lines.slice(1)) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'session_info' && e.name) name = String(e.name);
          if (e.type === 'message' && e.message?.role === 'user') {
            hasUserMessage = true;
            if (!preview) preview = textOf(e.message.content).replace(/\s+/g, ' ').slice(0, 120);
          }
        } catch {}
      }
      if (!hasUserMessage && !name) continue;
      result.push({ file, name, cwd: header.cwd, preview, updatedAt: stat.mtimeMs });
    } catch {}
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

const searchCache = new Map<string, { stamp: string; texts: string[]; bytes: number }>();
async function searchableText(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const stat = await fs.stat(file);
  if (stat.size > SEARCH_LIMIT) return [];
  const key = pathKey(file),
    stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = searchCache.get(key);
  searchCache.delete(key);
  if (cached?.stamp === stamp) {
    searchCache.set(key, cached);
    return cached.texts;
  }
  const raw = await fs.readFile(file, { encoding: 'utf8', signal });
  const texts: string[] = [];
  let yielded = performance.now();
  for (const line of raw.split('\n')) {
    signal?.throwIfAborted();
    if (performance.now() - yielded >= 4) {
      await yieldToEvents();
      signal?.throwIfAborted();
      yielded = performance.now();
    }
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role)) {
        const text = textOf(entry.message.content);
        if (text) texts.push(text);
      }
    } catch {}
  }
  const after = await fs.stat(file);
  const bytes = texts.reduce((sum, text) => sum + text.length * 2, 0);
  if (bytes <= SEARCH_LIMIT && `${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` === stamp) {
    searchCache.set(key, { stamp, texts, bytes });
    let total = [...searchCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [id, entry] of searchCache) {
      if (total <= SEARCH_LIMIT && searchCache.size <= 200) break;
      searchCache.delete(id);
      total -= entry.bytes;
    }
  }
  return texts;
}
export async function searchSessionContents(
  sessions: Session[],
  query: string,
  signal?: AbortSignal,
): Promise<SessionMatch[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const matches: SessionMatch[] = [];
  for (const s of sessions) {
    signal?.throwIfAborted();
    if (!s.file) continue;
    try {
      let yielded = performance.now();
      for (const text of await searchableText(s.file, signal)) {
        if (performance.now() - yielded >= 4) {
          await yieldToEvents();
          signal?.throwIfAborted();
          yielded = performance.now();
        }
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const start = Math.max(0, at - 30);
        matches.push({
          sessionId: s.id,
          snippet:
            (start ? '…' : '') +
            text
              .slice(start, at + needle.length + 60)
              .replace(/\s+/g, ' ')
              .trim(),
        });
        break;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (matches.length >= 30) break;
  }
  return matches;
}
