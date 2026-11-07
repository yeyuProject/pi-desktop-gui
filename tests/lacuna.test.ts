import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  LacunaService,
  LacunaUnavailable,
  type LacunaChangedEvent,
  type LacunaModule,
} from '../electron/lacuna';

type FakeNode = { id: string; title: string; aliases: string[]; type: 'concept'; summary: string };

/** lacuna 库的替身：nodes/ 下每个文件是一个节点，文件名是 id，内容是“标题|简短解释”。 */
function fakeLacuna(): LacunaModule {
  return {
    resolveStore: ({ cwd }) => ({ root: path.join(cwd, '.lacuna'), scope: 'project' }),
    readStore: (root) => {
      let files: string[] = [];
      try {
        files = readdirSync(path.join(root, 'nodes'));
      } catch {}
      return {
        nodes: files.map((file): FakeNode => {
          const [title = '', summary = ''] = readFileSync(path.join(root, 'nodes', file), 'utf8').split('|');
          return { id: path.basename(file, '.md'), title, aliases: [], type: 'concept', summary };
        }),
      };
    },
    termIndexOf: (nodes) => nodes,
    annotateMarkdown: (markdown, index) => [
      ...(index as FakeNode[]).flatMap((node) => {
        const start = markdown.indexOf(node.title);
        return start === -1
          ? []
          : [
              {
                start,
                end: start + node.title.length,
                text: node.title,
                ids: [node.id],
                kind: 'term' as const,
              },
            ];
      }),
      // 真实的 lacuna 也会返回指向不存在节点的 [[...]]，由 Pi Desktop 过滤掉。
      ...[...markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: match[1]!,
        ids: [match[1]!],
        kind: 'link' as const,
      })),
    ],
    nodeView: (node, all) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      aliases: node.aliases,
      summary: (node as FakeNode).summary,
      body: (node as FakeNode).summary + '\n\n更多解释。',
      dependsOn: [{ id: 'missing', title: undefined }],
      dependedBy: all
        .filter((other) => other !== node)
        .map((other) => ({ id: other.id, title: other.title })),
    }),
  };
}

async function project(t: TestContext, nodes?: Record<string, string>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-lacuna-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  if (nodes) {
    await fs.mkdir(path.join(directory, '.lacuna', 'nodes'), { recursive: true });
    for (const [id, text] of Object.entries(nodes))
      await fs.writeFile(path.join(directory, '.lacuna', 'nodes', id + '.md'), text);
  }
  return directory;
}

function service(t: TestContext, options: ConstructorParameters<typeof LacunaService>[1] = {}) {
  const events: LacunaChangedEvent[] = [];
  const lacuna = new LacunaService((event) => events.push(event), {
    locate: async () => '/fake/lacuna/index.js',
    load: async () => fakeLacuna(),
    debounceMs: 20,
    pollMs: 30,
    ...options,
  });
  t.after(() => lacuna.dispose());
  return { lacuna, events };
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await delay(20);
  }
}

test('找不到 lacuna 时关闭术语功能：说明原因，认词返回空结果', async (t) => {
  const { lacuna } = service(t, {
    locate: async () => {
      throw new LacunaUnavailable(
        '没有找到 lacuna 命令。安装 lacuna 并让它出现在 PATH 里，然后重新打开 Pi Desktop',
      );
    },
  });
  const directory = await project(t);
  assert.deepEqual(await lacuna.status(directory), {
    available: false,
    reason: '没有找到 lacuna 命令。安装 lacuna 并让它出现在 PATH 里，然后重新打开 Pi Desktop',
  });
  assert.deepEqual(await lacuna.annotate(directory, ['VAE']), [{ matches: [], terms: {} }]);
  assert.equal(await lacuna.node(directory, 'vae'), null);
});

test('本机的 lacuna 缺少需要的函数时，说明版本太旧', async (t) => {
  const { lacuna } = service(t, { load: async () => ({ readStore: () => ({ nodes: [] }) }) });
  const status = await lacuna.status(await project(t));
  assert.equal(status.available, false);
  assert.match(
    status.available ? '' : status.reason,
    /版本太旧，缺少 resolveStore、termIndexOf、annotateMarkdown、nodeView/,
  );
});

test('认词只保留指向已有节点的结果，并带上悬停要用的解释', async (t) => {
  const { lacuna } = service(t);
  const directory = await project(t, {
    vae: '变分自编码器|把数据压成隐变量的分布。',
    gan: '生成对抗网络|两个网络互相对抗。',
  });

  const [annotation] = await lacuna.annotate(directory, ['先学变分自编码器，再看 [[missing]] 和 [[gan]]']);
  assert.deepEqual(
    annotation?.matches.map((m) => [m.text, m.ids, m.kind]),
    [
      ['变分自编码器', ['vae'], 'term'],
      ['gan', ['gan'], 'link'],
    ],
  );
  assert.deepEqual(annotation?.terms.vae, {
    id: 'vae',
    title: '变分自编码器',
    aliases: [],
    summary: '把数据压成隐变量的分布。',
  });

  const node = await lacuna.node(directory, 'vae');
  assert.equal(node?.body, '把数据压成隐变量的分布。\n\n更多解释。');
  assert.deepEqual(node?.dependsOn, [{ id: 'missing' }]);
  assert.deepEqual(node?.dependedBy, [{ id: 'gan', title: '生成对抗网络' }]);
  assert.equal(await lacuna.node(directory, 'nope'), null);
  assert.deepEqual(await lacuna.status(directory), {
    available: true,
    scope: 'project',
    root: path.join(directory, '.lacuna'),
    nodeCount: 2,
    revision: 0,
  });
});

test('agent 写入新词后通知界面，再认词就能认出来', async (t) => {
  const { lacuna, events } = service(t);
  const directory = await project(t, { vae: '变分自编码器|简短解释' });
  await lacuna.status(directory);

  await fs.writeFile(path.join(directory, '.lacuna', 'nodes', 'latent.md'), '潜变量|没有直接观测到的变量。');
  await until(() => events.length > 0);
  assert.deepEqual(events.at(-1), {
    type: 'lacunaChanged',
    root: path.join(directory, '.lacuna'),
    revision: 1,
  });
  const [annotation] = await lacuna.annotate(directory, ['潜变量']);
  assert.deepEqual(
    annotation?.matches.map((m) => m.ids),
    [['latent']],
  );
});

test('知识库还没有 nodes/ 目录时，等它出现再开始监听', async (t) => {
  const { lacuna, events } = service(t);
  const directory = await project(t);
  assert.deepEqual(await lacuna.status(directory), {
    available: true,
    scope: 'project',
    root: path.join(directory, '.lacuna'),
    nodeCount: 0,
    revision: 0,
  });

  await fs.mkdir(path.join(directory, '.lacuna', 'nodes'), { recursive: true });
  await fs.writeFile(path.join(directory, '.lacuna', 'nodes', 'vae.md'), '变分自编码器|简短解释');
  await until(() => events.length > 0);
  const status = await lacuna.status(directory);
  assert.equal(status.available && status.nodeCount, 1);
});

test('知识图：较早的 lacuna 没有大纲函数时说明原因；有时返回大纲，知识库变化后重新计算', async (t) => {
  const old = service(t);
  const directory = await project(t, { vae: '变分自编码器|简短解释' });
  assert.deepEqual(await old.lacuna.graph(directory), {
    reason: '本机的 lacuna 版本太旧，还不能显示知识图。更新 lacuna 后重新打开 Pi Desktop',
  });

  let calls = 0;
  const current = service(t, {
    load: async () => ({
      ...fakeLacuna(),
      outlineOf: (nodes: Array<{ id: string; title: string }>) => {
        calls++;
        return {
          topics: [],
          loose: nodes.map((node) => ({ id: node.id, title: node.title, type: 'concept', children: [] })),
        };
      },
      graphOf: (nodes: Array<{ id: string; title: string }>) => ({
        nodes: nodes.map((node) => ({ id: node.id, title: node.title, type: 'concept' })),
        edges: [],
      }),
    }),
  });
  const first = await current.lacuna.graph(directory);
  assert.deepEqual('graph' in first && first.graph.outline.loose.map((item) => item.title), ['变分自编码器']);
  await current.lacuna.graph(directory);
  assert.equal(calls, 1, '知识库没变时用缓存');

  await fs.writeFile(path.join(directory, '.lacuna', 'nodes', 'latent.md'), '潜变量|没有直接观测到的变量。');
  await until(() => current.events.length > 0);
  const second = await current.lacuna.graph(directory);
  assert.deepEqual('graph' in second && second.graph.nodes.map((node) => node.id).sort(), ['latent', 'vae']);
  assert.equal(calls, 2);
});
