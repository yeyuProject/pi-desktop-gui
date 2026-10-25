import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../shared/types';
import type { AgentRulesFile } from '../shared/workspace';
import { safePath } from './workspace';

export async function projectRules(project: Project): Promise<AgentRulesFile | undefined> {
  for (const relativePath of ['AGENTS.md', '.pi/SYSTEM.md']) {
    try {
      const file = await safePath(project.path, relativePath);
      const stat = await fs.stat(file);
      if (stat.isFile()) return { relativePath, size: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function createAgentRules(project: Project): Promise<AgentRulesFile> {
  if (await projectRules(project)) throw new Error('项目规则文件已经存在，请直接打开编辑');
  const commands: string[] = [];
  try {
    const file = await safePath(project.path, 'package.json');
    const stat = await fs.stat(file);
    if (stat.size <= 256 * 1024) {
      const pkg: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        pkg &&
        typeof pkg === 'object' &&
        'scripts' in pkg &&
        pkg.scripts &&
        typeof pkg.scripts === 'object'
      ) {
        for (const [name, value] of Object.entries(pkg.scripts))
          if (typeof value === 'string' && /^[\w:.-]+$/.test(name))
            commands.push(`- \`npm run ${name}\`：${value.replace(/[\r\n]/g, ' ')}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  for (const [file, examples] of [
    ['Cargo.toml', ['cargo build', 'cargo test']],
    ['pyproject.toml', ['python -m pytest']],
    ['go.mod', ['go build ./...', 'go test ./...']],
  ] as const) {
    try {
      await safePath(project.path, file);
      commands.push(...examples.map((command) => `- \`${command}\`（示例，请按项目实际情况确认）`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const content = `# 项目规则\n\n<!-- 这是模板草稿。请确认构建、测试命令和目录约定后保存。 -->\n\n## 构建与测试\n\n${commands.length ? commands.join('\n') : '- 请在这里填写项目实际使用的构建与测试命令。'}\n\n## 代码约定\n\n- 修改前先阅读相关代码，沿用项目现有风格。\n- 保持改动范围清楚，不加入无关重构。\n- 完成后运行与改动相关的检查，并说明结果。\n\n## 目录说明\n\n- 请补充主要源码、测试和配置文件的位置。\n`;
  const root = await fs.realpath(project.path);
  try {
    await fs.writeFile(path.join(root, 'AGENTS.md'), content, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('AGENTS.md 已存在，未覆盖原文件，请直接打开编辑', { cause: error });
    throw error;
  }
  return { relativePath: 'AGENTS.md', size: Buffer.byteLength(content) };
}
