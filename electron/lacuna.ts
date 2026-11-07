/**
 * 知溯（lacuna）术语解释的主进程部分。
 *
 * Pi Desktop 不打包 lacuna，而是像对待 pi 一样，在运行时找到本机安装的 lacuna 并加载它的库
 * （lacuna ADR-0009）。认词规则只在 lacuna 里实现一次，这里只负责：为会话找到知识库、读进内存、
 * 监听变化，以及把认词结果交给界面。没装 lacuna 时，术语功能关闭，其他功能不受影响。
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LacunaAnnotation,
  LacunaMatch,
  LacunaNode,
  LacunaRef,
  LacunaStatus,
  LacunaTerm,
} from '../shared/lacuna';
import { isWindows, locateExecutable } from './platform';

/** Pi Desktop 用到的 lacuna 库接口（lacuna ADR-0009 第 3 条），只声明用到的字段。 */
interface NodeInfo {
  id: string;
  title: string | undefined;
  aliases: string[];
  type: 'concept' | 'topic' | 'adr' | undefined;
}
interface NodeView {
  id: string;
  title: string | undefined;
  type: NodeInfo['type'];
  aliases: string[];
  summary: string;
  body: string;
  dependsOn: Array<{ id: string; title: string | undefined }>;
  dependedBy: Array<{ id: string; title: string | undefined }>;
}
export interface LacunaModule {
  resolveStore(options: { cwd: string; personal: boolean }): { root: string; scope: 'project' | 'personal' };
  readStore(root: string): { nodes: NodeInfo[] };
  termIndexOf(nodes: NodeInfo[]): unknown;
  annotateMarkdown(markdown: string, index: unknown): LacunaMatch[];
  nodeView(node: NodeInfo, all: NodeInfo[]): NodeView;
}
const REQUIRED: Array<keyof LacunaModule> = [
  'resolveStore',
  'readStore',
  'termIndexOf',
  'annotateMarkdown',
  'nodeView',
];

export interface LacunaChangedEvent {
  type: 'lacunaChanged';
  root: string;
  revision: number;
}

/** 用户能看懂、能自己处理的原因，直接显示在界面上。 */
export class LacunaUnavailable extends Error {}

interface Options {
  /** 找到 lacuna 库的入口文件。测试时替换。 */
  locate?: () => Promise<string>;
  /** 加载库。测试时替换。 */
  load?: (entry: string) => Promise<unknown>;
  /** 知识库变化后等多久再重新读取，合并 agent 连续的几次写入。 */
  debounceMs?: number;
  /** 知识库还没有 nodes/ 目录时，多久检查一次它出现了没有。 */
  pollMs?: number;
  /** 加载失败后多久允许重试，比如用户刚装好 lacuna。 */
  retryMs?: number;
}

interface LoadedStore {
  root: string;
  scope: 'project' | 'personal';
  revision: number;
  nodes: NodeInfo[];
  index: unknown;
  views: Map<string, NodeView>;
  watcher?: FSWatcher;
  poll?: NodeJS.Timeout;
  timer?: NodeJS.Timeout;
}

const emptyAnnotation = (): LacunaAnnotation => ({ matches: [], terms: {} });

export class LacunaService {
  readonly #notify: (event: LacunaChangedEvent) => void;
  readonly #options: Required<Pick<Options, 'debounceMs' | 'pollMs' | 'retryMs'>> & Options;
  #module: Promise<LacunaModule> | undefined;
  readonly #stores = new Map<string, LoadedStore>();
  #disposed = false;

  constructor(notify: (event: LacunaChangedEvent) => void, options: Options = {}) {
    this.#notify = notify;
    this.#options = { debounceMs: 150, pollMs: 3000, retryMs: 60_000, ...options };
  }

  /** 会话目录对应的知识库是否可用。 */
  async status(directory: string): Promise<LacunaStatus> {
    try {
      const store = await this.#store(directory);
      return {
        available: true,
        scope: store.scope,
        root: store.root,
        nodeCount: store.nodes.length,
        revision: store.revision,
      };
    } catch (error) {
      return { available: false, reason: reasonOf(error) };
    }
  }

  /** 在几段文字里认词。lacuna 不可用时返回空结果，界面照常显示原文。 */
  async annotate(directory: string, texts: string[]): Promise<LacunaAnnotation[]> {
    let store: LoadedStore;
    let lacuna: LacunaModule;
    try {
      lacuna = await this.#lacuna();
      store = await this.#store(directory);
    } catch {
      return texts.map(emptyAnnotation);
    }
    return texts.map((text) => {
      const terms: Record<string, LacunaTerm> = {};
      const matches: LacunaMatch[] = [];
      for (const match of lacuna.annotateMarkdown(text, store.index)) {
        // [[id|原文]] 可能指向还没建的节点，这样的不标出来。
        const ids = match.ids.filter((id) => store.views.has(id));
        if (ids.length === 0) continue;
        matches.push({ start: match.start, end: match.end, text: match.text, ids, kind: match.kind });
        for (const id of ids) terms[id] ??= termOf(store.views.get(id)!);
      }
      return { matches, terms };
    });
  }

  /** 读取一个节点的完整解释。节点不存在或 lacuna 不可用时返回 null。 */
  async node(directory: string, id: string): Promise<LacunaNode | null> {
    try {
      const view = (await this.#store(directory)).views.get(id);
      return view ? nodeOf(view) : null;
    } catch {
      return null;
    }
  }

  dispose() {
    this.#disposed = true;
    for (const store of this.#stores.values()) stopWatching(store);
    this.#stores.clear();
  }

  #lacuna(): Promise<LacunaModule> {
    if (this.#module) return this.#module;
    const promise = (async () => {
      const entry = await (this.#options.locate ?? locateLacunaLibrary)();
      const loaded = await (this.#options.load ?? ((file: string) => import(pathToFileURL(file).href)))(
        entry,
      );
      const missing = REQUIRED.filter(
        (name) => typeof (loaded as Record<string, unknown>)?.[name] !== 'function',
      );
      if (missing.length > 0) {
        throw new LacunaUnavailable(
          `本机的 lacuna 版本太旧，缺少 ${missing.join('、')}。更新 lacuna 后重新打开 Pi Desktop`,
        );
      }
      return loaded as LacunaModule;
    })();
    this.#module = promise;
    promise.catch(() => {
      // 失败的结果先缓存一段时间，免得每次渲染都去找；之后允许重试，比如用户刚装好 lacuna。
      setTimeout(() => {
        if (this.#module === promise) this.#module = undefined;
      }, this.#options.retryMs).unref();
    });
    return promise;
  }

  async #store(directory: string): Promise<LoadedStore> {
    const lacuna = await this.#lacuna();
    const { root, scope } = lacuna.resolveStore({ cwd: directory, personal: false });
    let store = this.#stores.get(root);
    if (!store) {
      store = { root, scope, revision: 0, ...read(lacuna, root) };
      this.#stores.set(root, store);
      if (!this.#disposed) this.#watch(lacuna, store);
    }
    return store;
  }

  #watch(lacuna: LacunaModule, store: LoadedStore) {
    const nodes = path.join(store.root, 'nodes');
    const reload = () => {
      if (this.#disposed) return;
      try {
        Object.assign(store, read(lacuna, store.root));
      } catch (error) {
        // 在监听回调里抛出会变成主进程的未捕获异常；保留上一次读到的内容。
        console.error('[lacuna]', error);
        return;
      }
      store.revision++;
      this.#notify({ type: 'lacunaChanged', root: store.root, revision: store.revision });
    };
    if (!existsSync(nodes)) {
      // 个人知识库在第一次写入时才会创建，先等目录出现。
      store.poll = setInterval(() => {
        if (!existsSync(nodes)) return;
        stopWatching(store);
        reload();
        this.#watch(lacuna, store);
      }, this.#options.pollMs);
      store.poll.unref();
      return;
    }
    try {
      store.watcher = watch(nodes, () => {
        clearTimeout(store.timer);
        store.timer = setTimeout(reload, this.#options.debounceMs);
      });
      store.watcher.on('error', () => {
        // 目录被删掉之类的情况：退回到等目录出现。
        stopWatching(store);
        if (!this.#disposed) this.#watch(lacuna, store);
      });
    } catch {
      // 监听不了也不影响使用，只是知识库变化后要重新打开会话才能看到。
    }
  }
}

/** 在 PATH 里找到 lacuna 命令，换算出它的库入口 .../core/dist/index.js。 */
export async function locateLacunaLibrary(): Promise<string> {
  const command = await locateExecutable('lacuna');
  if (!command) {
    throw new LacunaUnavailable(
      '没有找到 lacuna 命令。安装 lacuna 并让它出现在 PATH 里，然后重新打开 Pi Desktop',
    );
  }
  // Windows 上 npm 装的是 .cmd 启动脚本，库在旁边的 node_modules 里；其他平台是指向 dist/cli.js 的符号链接。
  const cli =
    isWindows && /\.(cmd|ps1)$/i.test(command)
      ? path.join(path.dirname(command), 'node_modules', 'lacuna-core', 'dist', 'cli.js')
      : await fs.realpath(command);
  const entry = path.join(path.dirname(cli), 'index.js');
  if (!existsSync(entry)) {
    throw new LacunaUnavailable(
      `找到了 lacuna 命令，但没有找到它的库文件 ${entry}。更新 lacuna 后重新打开 Pi Desktop`,
    );
  }
  return entry;
}

function read(lacuna: LacunaModule, root: string): Pick<LoadedStore, 'nodes' | 'index' | 'views'> {
  const { nodes } = lacuna.readStore(root);
  return {
    nodes,
    index: lacuna.termIndexOf(nodes),
    views: new Map(nodes.map((node) => [node.id, lacuna.nodeView(node, nodes)])),
  };
}

function stopWatching(store: LoadedStore) {
  store.watcher?.close();
  clearInterval(store.poll);
  clearTimeout(store.timer);
  store.watcher = undefined;
  store.poll = undefined;
}

function reasonOf(error: unknown): string {
  if (error instanceof LacunaUnavailable) return error.message;
  console.error('[lacuna]', error);
  return '读取知溯知识库时出错，详细信息已写入诊断日志';
}

const refOf = (ref: { id: string; title: string | undefined }): LacunaRef =>
  ref.title === undefined ? { id: ref.id } : { id: ref.id, title: ref.title };

function termOf(view: NodeView): LacunaTerm {
  return { id: view.id, title: view.title ?? view.id, aliases: view.aliases, summary: view.summary };
}

function nodeOf(view: NodeView): LacunaNode {
  return {
    ...termOf(view),
    type: view.type,
    body: view.body,
    dependsOn: view.dependsOn.map(refOf),
    dependedBy: view.dependedBy.map(refOf),
  };
}
