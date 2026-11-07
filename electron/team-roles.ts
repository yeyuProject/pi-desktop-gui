import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { canonicalWritePath, isWithinDirectory } from './approval-paths';
import { samePath } from './platform';
import { isTeamRole, validRoleName, type TeamRole, type TeamRoleInput } from '../shared/team';

export interface TeamRoleContext {
  agentDir: string;
  cwd?: string;
  trusted: boolean;
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const limit = 80 * 1024;
const builtinDefinitions = [
  [
    'scout',
    '调研员：定位相关代码并汇报文件与行号',
    'read, grep, find, ls',
    '只调研，不修改文件。给出精简且可核实的代码位置、事实和未知项。',
  ],
  [
    'planner',
    '规划者：分析约束与实施步骤',
    'read, grep, find, ls',
    '只规划，不修改文件。核对现有代码，汇报实施顺序、风险与验收方法。',
  ],
  [
    'worker',
    '实现者：完成独立实现任务',
    undefined,
    '按任务约束实现最小必要改动，保留无关修改，验证结果并如实汇报未完成项。',
  ],
  [
    'reviewer',
    '审查员：独立审查正确性与安全问题',
    'read, grep, find, ls',
    '只审查，不修改文件。优先报告可复现的缺陷，给出文件和行号，不把猜测当作事实。',
  ],
] as const;

export function parseTeamRole(raw: string, source: TeamRole['source'], file?: string): TeamRole {
  if (Buffer.byteLength(raw, 'utf8') > limit) throw new Error('角色文件不能超过 80 KiB。');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('角色文件需要 YAML 开头说明。');
  let front: unknown;
  try {
    front = yaml.load(match[1]);
  } catch (error) {
    throw new Error('角色的 YAML 说明无法解析，请检查格式。', { cause: error });
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) throw new Error('角色说明格式无效。');
  const data = front as Record<string, unknown>;
  let tools: string[] | undefined;
  if (data.tools !== undefined) {
    const entries = typeof data.tools === 'string' ? data.tools.split(',') : data.tools;
    if (!Array.isArray(entries) || entries.some((v) => typeof v !== 'string'))
      throw new Error('角色工具应为逗号分隔的名称或字符串列表。');
    tools = [...new Set(entries.map((v: string) => v.trim()).filter(Boolean))];
    if (
      tools.some(
        (name) =>
          name === 'desktop_ask_user' || name.startsWith('desktop_goal_') || name.startsWith('desktop_team_'),
      )
    )
      throw new Error('成员角色不能启用提问、Goal 或团队工具。');
  }
  const role = {
    name: data.name,
    description: data.description,
    tools,
    model: data.model,
    thinking: data.thinking,
    body: raw.slice(match[0].length),
    source,
    path: file,
    revision: hash(raw),
    editable: false,
  };
  if (!isTeamRole(role)) throw new Error('角色名称、说明、工具、模型或推理级别无效。');
  return role;
}
export const builtinTeamRoles: readonly TeamRole[] = builtinDefinitions.map(
  ([name, description, tools, body]) =>
    parseTeamRole(
      `---\nname: ${name}\ndescription: ${description}\n${tools ? `tools: ${tools}\n` : ''}---\n${body}\n`,
      'builtin',
    ),
);

function rootFor(context: TeamRoleContext, source: 'user' | 'project') {
  if (source === 'project' && (!context.cwd || !context.trusted))
    throw new Error('请先选择并信任项目，再管理项目角色。');
  return path.resolve(source === 'user' ? context.agentDir : path.join(context.cwd!, '.pi'));
}
/** Same revision/realpath policy as the prompt editor: never mutate linked or packaged resources. */
async function editableTarget(context: TeamRoleContext, source: 'user' | 'project', name: string) {
  if (!validRoleName(name)) throw new Error('角色名只允许字母、数字、下划线和连字符，最多 80 字。');
  const root = rootFor(context, source);
  const directory = path.join(root, 'agents');
  const target = path.join(directory, name + '.md');
  const [realRoot, realDirectory, realTarget] = await Promise.all(
    [root, directory, target].map((p) => canonicalWritePath(p)),
  );
  if (source === 'project' && !isWithinDirectory(await fs.realpath(context.cwd!), realRoot))
    throw new Error('项目的 .pi 目录指向项目外，不能在这里修改角色。');
  if (
    !isWithinDirectory(realRoot, realDirectory) ||
    !samePath(path.dirname(realTarget), realDirectory) ||
    realTarget.split(path.sep).includes('node_modules')
  )
    throw new Error('链接或资源包中的角色只读，请新建自己的角色。');
  const directoryStat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (directoryStat?.isSymbolicLink()) throw new Error('链接或资源包中的角色只读，请新建自己的角色。');
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1))
    throw new Error('链接文件或特殊文件不能在角色编辑器中修改。');
  return target;
}
async function readRaw(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('角色文件不可读或超过 80 KiB。');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
export async function listTeamRoles(context: TeamRoleContext): Promise<TeamRole[]> {
  const roles = new Map(builtinTeamRoles.map((role) => [role.name, { ...role }]));
  for (const source of ['user', 'project'] as const) {
    if (source === 'project' && (!context.cwd || !context.trusted)) continue;
    const directory = path.join(rootFor(context, source), 'agents');
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code ?? '')) return [];
        throw error;
      });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.md') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const file = path.join(directory, entry.name);
      try {
        const role = parseTeamRole(await readRaw(file), source, file);
        try {
          role.editable = samePath(await editableTarget(context, source, role.name), file);
        } catch {
          /* Symlinked/package roles remain readable, never editable. */
        }
        roles.set(role.name, role);
      } catch {
        /* One malformed role must not hide the healthy ones. */
      }
    }
  }
  return [...roles.values()];
}
export async function readTeamRole(context: TeamRoleContext, source: 'user' | 'project', name: string) {
  const file = await editableTarget(context, source, name);
  const text = await readRaw(file);
  const role = parseTeamRole(text, source, file);
  if (role.name !== name) throw new Error('角色文件名与名称不一致，请先在原文件中修正。');
  return { role: { ...role, editable: true }, text };
}
export async function saveTeamRole(context: TeamRoleContext, input: TeamRoleInput) {
  if (!input || !['user', 'project'].includes(input.source) || typeof input.text !== 'string')
    throw new Error('角色内容无效。');
  const target = await editableTarget(context, input.source, input.name);
  const role = parseTeamRole(input.text, input.source, target);
  if (role.name !== input.name) throw new Error('角色名称必须与文件名一致。');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await editableTarget(context, input.source, input.name);
  if (input.revision === undefined) {
    try {
      await fs.writeFile(target, input.text, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('同名角色已存在，请编辑已有角色。', { cause: error });
      throw error;
    }
  } else {
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, input.text, { flag: 'wx', mode: 0o600 });
      await editableTarget(context, input.source, input.name);
      if (hash(await readRaw(target)) !== input.revision)
        throw new Error('角色已在别处修改，请重新读取后再保存。');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return { ...role, editable: true };
}
export async function deleteTeamRole(
  context: TeamRoleContext,
  source: 'user' | 'project',
  name: string,
  revision: string,
) {
  const current = await readTeamRole(context, source, name);
  if (current.role.revision !== revision) throw new Error('角色已在别处修改，请重新读取后再删除。');
  await fs.unlink(current.role.path!);
}
