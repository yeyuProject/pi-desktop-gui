import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { samePath } from './platform';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import type { ResourceItem } from '../shared/types';
import {
  serializePromptTemplate,
  validatePromptTemplate,
  type PromptScope,
  type PromptTemplateInput,
  type PromptTemplateDocument,
} from '../shared/prompts';

export interface PromptTemplateContext {
  agentDir: string;
  /** Only pass the selected project's directory; standalone conversations have no project scope. */
  cwd?: string;
  resources: ResourceItem[];
}
const revision = (raw: string) => createHash('sha256').update(raw).digest('hex');
const templateLimit = 1024 * 1024 + 8192;

function scopeRoot(context: PromptTemplateContext, scope: PromptScope) {
  if (scope === 'project' && !context.cwd) throw new Error('独立对话不能创建项目模板，请选择个人全局');
  return path.resolve(scope === 'global' ? context.agentDir : path.join(context.cwd!, '.pi'));
}

async function checkTarget(context: PromptTemplateContext, scope: PromptScope, name: string) {
  const root = scopeRoot(context, scope);
  const directory = path.join(root, 'prompts');
  const target = path.join(directory, name + '.md');
  const [realRoot, realDirectory, realTarget] = await Promise.all([
    canonicalWritePath(root),
    canonicalWritePath(directory),
    canonicalWritePath(target),
  ]);
  // A project .pi symlink must not provide a write route outside the project.
  if (scope === 'project' && !isWithinDirectory(await fs.realpath(context.cwd!), realRoot))
    throw new Error('项目的 .pi 目录指向项目外，不能在这里修改模板');
  if (!isWithinDirectory(realRoot, realDirectory) || !samePath(path.dirname(realTarget), realDirectory))
    throw new Error('模板路径包含指向其他目录的链接，请在原文件位置编辑');
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1))
    throw new Error('链接文件或特殊文件不能在模板编辑器中修改');
  return target;
}

function scopeForPath(context: PromptTemplateContext, file: string): PromptScope {
  if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file))
    throw new Error('模板文件路径无效');
  if (samePath(path.dirname(file), path.join(context.agentDir, 'prompts'))) return 'global';
  if (context.cwd && samePath(path.dirname(file), path.join(context.cwd, '.pi', 'prompts'))) return 'project';
  throw new Error('只能编辑个人全局或当前项目 prompts 目录中的模板');
}

async function editableTarget(context: PromptTemplateContext, file: string) {
  const scope = scopeForPath(context, file);
  const name = path.basename(file, '.md');
  if (path.extname(file) !== '.md' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(name))
    throw new Error('该模板命令名不适合可视编辑，请在原文件中修改');
  const resource = context.resources.find((item) => item.kind === 'prompts' && samePath(item.path, file));
  if (
    !resource ||
    resource.metadata.origin !== 'top-level' ||
    !['auto', 'local'].includes(resource.metadata.source)
  )
    throw new Error('内置或资源包中的提示词模板只读，请新建自己的模板');
  const target = await checkTarget(context, scope, name);
  return { target, scope, name };
}

function parseTemplate(raw: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    let data: unknown;
    try {
      data = yaml.load(match[1]);
    } catch (error) {
      throw new Error('模板开头的 YAML 说明无法解析，请先在文件中修正后重试', { cause: error });
    }
    if (data !== undefined && data !== null && (typeof data !== 'object' || Array.isArray(data)))
      throw new Error('模板的 YAML 说明格式无效，请先在文件中修正');
    frontmatter = (data ?? {}) as Record<string, unknown>;
  }
  return { frontmatter, body: match ? raw.slice(match[0].length) : raw };
}

async function readRaw(target: string) {
  const handle = await fs.open(target, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('模板文件已被删除，请刷新资源列表后重试');
    if (error.code === 'EACCES' || error.code === 'EPERM')
      throw new Error('无法读取模板文件，请检查文件权限后重试');
    throw error;
  });
  try {
    if ((await handle.stat()).size > templateLimit) throw new Error('模板文件超过 1 MiB，请在编辑器中修改');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function promptEditable(
  context: PromptTemplateContext,
  resource: ResourceItem,
): Promise<boolean> {
  if (resource.kind !== 'prompts') return false;
  try {
    await editableTarget(context, resource.path);
    return true;
  } catch {
    return false;
  }
}

const compactLine = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;

function fallbackResourceName(resource: ResourceItem) {
  const base = path.basename(resource.path);
  if (resource.kind === 'skills' && /^skill\.md$/i.test(base)) {
    const parent = path.basename(path.dirname(resource.path));
    if (parent && parent !== '.') return parent;
  }
  if (resource.kind === 'skills' || resource.kind === 'prompts')
    return path.basename(resource.path, path.extname(resource.path));
  return base;
}

function firstBodyLine(body: string) {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```') || line.startsWith('<!--')) continue;
    const cleaned = line
      .replace(/^[-*+>]\s+/, '')
      .replace(/[*_`~]/g, '')
      .trim();
    if (cleaned) return compactLine(cleaned, 240);
  }
  return undefined;
}

export async function describeResource(
  context: PromptTemplateContext,
  resource: ResourceItem,
): Promise<ResourceItem> {
  const editable = await promptEditable(context, resource);
  let name = fallbackResourceName(resource);
  let description = compactLine(resource.description, 240);
  let argumentHint = compactLine(resource.argumentHint, 200);
  if ((resource.kind === 'skills' || resource.kind === 'prompts') && /\.md$/i.test(resource.path)) {
    try {
      const handle = await fs.open(resource.path, 'r');
      try {
        const stat = await handle.stat();
        if (stat.isFile()) {
          const buffer = Buffer.alloc(16384);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const head = buffer.subarray(0, bytesRead).toString('utf8');
          const { frontmatter, body } = parseTemplate(head);
          if (resource.kind === 'skills') name = compactLine(frontmatter.name, 120) ?? name;
          description = compactLine(frontmatter.description, 240) ?? firstBodyLine(body) ?? description;
          argumentHint = compactLine(frontmatter['argument-hint'], 200) ?? argumentHint;
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable or malformed skill/prompt markdown must not fail catalog listing.
    }
  }
  return {
    ...resource,
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    promptEditable: editable,
  };
}

export async function readPromptTemplate(
  context: PromptTemplateContext,
  file: string,
): Promise<PromptTemplateDocument> {
  const { target, scope, name } = await editableTarget(context, file);
  const raw = await readRaw(target);
  const { frontmatter, body } = parseTemplate(raw);
  return {
    name,
    scope,
    path: target,
    revision: revision(raw),
    body,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    argumentHint: typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : '',
  };
}

export async function savePromptTemplate(
  context: PromptTemplateContext,
  input: PromptTemplateInput,
  original?: PromptTemplateDocument,
): Promise<PromptTemplateDocument> {
  validatePromptTemplate(input);
  const target = await checkTarget(context, input.scope, input.name);
  let raw = serializePromptTemplate(input);
  if (original) {
    const current = await readPromptTemplate(context, original.path);
    if (!samePath(current.path, target)) throw new Error('编辑时不能更改命令名或作用范围；请新建另一个模板');
    if (current.revision !== original.revision) throw new Error('模板已在外部修改，请重新读取后再保存');
    const { frontmatter } = parseTemplate(await readRaw(target));
    frontmatter.description = input.description;
    if (input.argumentHint) frontmatter['argument-hint'] = input.argumentHint;
    else delete frontmatter['argument-hint'];
    raw = '---\n' + yaml.dump(frontmatter, { lineWidth: -1, noRefs: true }) + '---\n' + input.body;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await checkTarget(context, input.scope, input.name);
  if (!original) {
    try {
      await fs.writeFile(target, raw, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('同名模板已存在，请编辑已有模板或换一个名称', { cause: error });
      throw error;
    }
  } else {
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
      await checkTarget(context, input.scope, input.name);
      if (revision(await readRaw(target)) !== original.revision)
        throw new Error('模板已在外部修改，请重新读取后再保存');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return { ...input, path: target, revision: revision(raw) };
}

export async function deletePromptTemplate(
  context: PromptTemplateContext,
  file: string,
  expectedRevision: string,
): Promise<void> {
  const current = await readPromptTemplate(context, file);
  if (current.revision !== expectedRevision) throw new Error('模板已在外部修改，请重新读取后再删除');
  await fs.unlink(current.path);
}
