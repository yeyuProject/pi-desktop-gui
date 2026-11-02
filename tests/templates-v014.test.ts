import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { serializePromptTemplate, validatePromptTemplate, type PromptTemplateInput } from '../shared/prompts';
import {
  readPromptTemplate,
  savePromptTemplate,
  deletePromptTemplate,
  promptEditable,
  describeResource,
  type PromptTemplateContext,
} from '../electron/prompts';
import type { ResourceItem } from '../shared/types';

const input: PromptTemplateInput = {
  name: 'check-diff',
  description: '检查: "模块" #说明',
  argumentHint: '<模块名> [关注点]',
  body: 'Review $1 with $ARGUMENTS\n',
  scope: 'project',
};
function resource(file: string, scope = 'project'): ResourceItem {
  return {
    path: file,
    kind: 'prompts',
    enabled: true,
    metadata: { source: 'auto', origin: 'top-level', scope },
  };
}

test('template frontmatter uses standard YAML strings and native Pi placeholders', () => {
  const raw = serializePromptTemplate(input);
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)!;
  assert.deepEqual(yaml.load(match[1]), {
    description: input.description,
    'argument-hint': input.argumentHint,
  });
  assert.equal(match[2], input.body);
  for (const name of [
    '../escape',
    'name/path',
    'a\\b',
    '.',
    '.hidden',
    'con',
    'LPT1',
    'x:y',
    'with space',
    'with_underscore',
    'a'.repeat(81),
  ])
    assert.throws(() => validatePromptTemplate({ ...input, name }), Error, name);
  assert.throws(() => validatePromptTemplate({ ...input, scope: 'package' }));
  assert.throws(() => validatePromptTemplate({ ...input, description: 'x\ny' }));
  assert.throws(() => validatePromptTemplate({ ...input, body: '中'.repeat(400_000) }));
});

test('native template CRUD preserves unknown frontmatter, rejects stale edits and limits scope', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-prompts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project'),
    agentDir = path.join(dir, 'agent');
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  const context: PromptTemplateContext = { cwd, agentDir, resources: [] };
  const created = await savePromptTemplate(context, input);
  context.resources.push(resource(created.path));
  assert.equal(created.path, path.join(cwd, '.pi', 'prompts', 'check-diff.md'));
  assert.equal((await readPromptTemplate(context, created.path)).argumentHint, '<模块名> [关注点]');
  await assert.rejects(savePromptTemplate(context, input), /同名模板/);
  const raw = await fs.readFile(created.path, 'utf8');
  await fs.writeFile(created.path, raw.replace('description:', 'custom-field: keep-me\ndescription:'));
  await assert.rejects(
    savePromptTemplate(context, { ...input, body: 'changed' }, created),
    /在你编辑时被别处改过了/,
  );
  await assert.rejects(
    deletePromptTemplate(context, created.path, created.revision),
    /在你编辑时被别处改过了/,
  );
  const fresh = await readPromptTemplate(context, created.path);
  const updated = await savePromptTemplate(context, { ...input, body: 'Changed $2' }, fresh);
  assert.match(await fs.readFile(created.path, 'utf8'), /custom-field: keep-me/);
  assert.equal(updated.body, 'Changed $2');
  await assert.rejects(savePromptTemplate(context, { ...input, name: 'new-name' }, updated), /不能更改/);
  await assert.rejects(readPromptTemplate(context, path.join(dir, 'outside.md')), /只能编辑/);
  await assert.rejects(savePromptTemplate({ ...context, cwd: undefined }, input), /独立对话/);
  const global = await savePromptTemplate({ ...context, cwd: undefined }, { ...input, scope: 'global' });
  assert.equal(global.path, path.join(agentDir, 'prompts', 'check-diff.md'));
  const pkg = {
    ...context.resources[0],
    metadata: { source: 'npm:templates', scope: 'project', origin: 'package' },
  };
  await assert.rejects(readPromptTemplate({ ...context, resources: [pkg] }, updated.path), /只读/);
  assert.equal(await promptEditable({ ...context, resources: [pkg] }, pkg), false);
  assert.equal(await promptEditable(context, context.resources[0]), true);
  await deletePromptTemplate(context, updated.path, updated.revision);
  await assert.rejects(fs.stat(updated.path), { code: 'ENOENT' });
});

test('template writes reject symlinked scopes, directory escape and hard-linked files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-prompt-links-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project'),
    agentDir = path.join(dir, 'agent'),
    outside = path.join(dir, 'outside');
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(cwd, '.pi'), 'junction');
  const context: PromptTemplateContext = { cwd, agentDir, resources: [] };
  await assert.rejects(savePromptTemplate(context, input), /指向项目外/);
  await fs.symlink(outside, path.join(agentDir, 'prompts'), 'junction');
  await assert.rejects(savePromptTemplate(context, { ...input, scope: 'global' }), /链接/);
  const safeAgent = path.join(dir, 'safe-agent');
  const safe: PromptTemplateContext = { cwd, agentDir: safeAgent, resources: [] };
  const created = await savePromptTemplate(safe, { ...input, scope: 'global' });
  safe.resources.push(resource(created.path, 'user'));
  await fs.link(created.path, path.join(dir, 'hard-linked.md'));
  await assert.rejects(readPromptTemplate(safe, created.path), /链接文件/);
});

test('describeResource extracts skill/prompt frontmatter and falls back safely', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resource-meta-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project'),
    agentDir = path.join(dir, 'agent');
  const skillDir = path.join(agentDir, 'skills', 'code-review');
  const fallbackDir = path.join(agentDir, 'skills', 'fallback-skill');
  const brokenDir = path.join(agentDir, 'skills', 'broken-skill');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(fallbackDir, { recursive: true });
  await fs.mkdir(brokenDir, { recursive: true });

  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillFile,
    '---\nname: review-excellence\ndescription: |\n  Master effective code review\n  with constructive feedback.\n---\n# Heading\nBody text\n',
  );
  const fallbackFile = path.join(fallbackDir, 'SKILL.md');
  await fs.writeFile(fallbackFile, '# Title Heading\n\nFirst paragraph summary of fallback skill.\n');
  const brokenFile = path.join(brokenDir, 'SKILL.md');
  await fs.writeFile(brokenFile, '---\nname: [unclosed\n---\nFallback body after broken yaml\n');

  const context: PromptTemplateContext = { cwd, agentDir, resources: [] };
  const savedPrompt = await savePromptTemplate(context, input);
  const promptRes = resource(savedPrompt.path);
  const skillRes: ResourceItem = {
    path: skillFile,
    kind: 'skills',
    enabled: true,
    metadata: { source: 'auto', origin: 'top-level', scope: 'user' },
  };
  const fallbackRes: ResourceItem = {
    path: fallbackFile,
    kind: 'skills',
    enabled: true,
    metadata: { source: 'auto', origin: 'top-level', scope: 'user' },
  };
  const brokenRes: ResourceItem = {
    path: brokenFile,
    kind: 'skills',
    enabled: false,
    metadata: { source: 'auto', origin: 'top-level', scope: 'user' },
  };
  context.resources.push(promptRes, skillRes, fallbackRes, brokenRes);

  const describedSkill = await describeResource(context, skillRes);
  assert.equal(describedSkill.name, 'review-excellence');
  assert.equal(describedSkill.description, 'Master effective code review with constructive feedback.');

  const describedFallback = await describeResource(context, fallbackRes);
  assert.equal(describedFallback.name, 'fallback-skill');
  assert.equal(describedFallback.description, 'First paragraph summary of fallback skill.');

  const describedBroken = await describeResource(context, brokenRes);
  assert.equal(describedBroken.name, 'broken-skill');

  const describedPrompt = await describeResource(context, promptRes);
  assert.equal(describedPrompt.name, 'check-diff');
  assert.equal(describedPrompt.description, input.description);
  assert.equal(describedPrompt.argumentHint, input.argumentHint);
  assert.equal(describedPrompt.promptEditable, true);
});
