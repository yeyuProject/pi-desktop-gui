import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Links in model replies are untrusted. A local link opens with the system default app only
 * when the file is a document the system shows passively (report, table, image, audio).
 * Scripts, apps, packages and unknown types are revealed in the file manager, or opened in
 * the user's configured text editor, so a link label can never launch a program.
 */
const DOCUMENTS = new Set(
  [
    'html htm md markdown txt log csv tsv json pdf',
    'png jpg jpeg gif webp svg bmp tif tiff heic',
    'mp3 wav flac m4a aac ogg mp4 mov webm',
  ]
    .join(' ')
    .split(' ')
    .map((extension) => '.' + extension),
);

export type MessageLinkPlan =
  { action: 'web'; url: string } | { action: 'open' | 'reveal' | 'editor'; path: string };

function localPath(href: string) {
  if (/^file:/i.test(href)) return fileURLToPath(href);
  let value = href;
  try {
    // Markdown percent-encodes spaces and non-ASCII characters in link destinations.
    value = decodeURI(href);
  } catch {
    // Keep the literal value when it is not valid percent-encoding.
  }
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : undefined;
}

async function existing(target: string) {
  for (const candidate of [target, target.replace(/[?#].*$/, '')]) {
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch {
      // Try the path without a URL fragment or query before reporting it missing.
    }
  }
  throw new Error(`找不到文件：${target}`);
}

export async function planMessageLink(href: string, editor?: string): Promise<MessageLinkPlan> {
  const value = href.trim();
  if (/^https?:\/\//i.test(value)) return { action: 'web', url: new URL(value).href };
  const target = localPath(value);
  if (!target) throw new Error('只能打开网页链接或本地文件的完整路径');
  const file = await existing(target);
  // Decide by the real target, so a renamed symlink cannot pass a script off as a document.
  const real = await fs.realpath(file);
  const stat = await fs.stat(real);
  if (stat.isDirectory())
    // Directories with an extension are usually packages such as .app bundles.
    return path.extname(real) ? { action: 'reveal', path: file } : { action: 'open', path: real };
  if (stat.isFile() && DOCUMENTS.has(path.extname(real).toLowerCase())) return { action: 'open', path: real };
  if (stat.isFile() && editor) return { action: 'editor', path: real };
  return { action: 'reveal', path: file };
}
