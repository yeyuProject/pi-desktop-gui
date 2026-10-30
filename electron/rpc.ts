import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isWindows, terminateProcessTree, WindowsProcessNotFoundError } from './platform';
import { incompatible, validateRpcResult, validateBridgeResult, type RpcResult } from './pi/protocol';
import { DESKTOP_BRIDGE_COMMAND } from '../shared/pi-bridge';

export interface CommandSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
export class LfJsonDecoder {
  private fragments: Buffer[] = [];
  private length = 0;
  private discarding = false;
  constructor(
    private emit: (value: any) => void,
    private invalid: (error: Error) => void,
    private readonly maxRecordBytes = 128 * 1024 * 1024,
  ) {}
  push(chunk: Buffer) {
    let start = 0;
    // A large get_messages response spans many stdout chunks. Scan each chunk
    // once. Count wire bytes before joining/decoding, including the final fragment.
    // LF cannot occur inside a UTF-8 multibyte character.
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.discarding) {
        this.length += end - start;
        if (this.length > this.maxRecordBytes) {
          this.fragments = [];
          this.length = 0;
          this.discarding = true;
          this.invalid(new Error('Pi 一次返回的内容过大。请在终端导出会话，再重新连接。'));
        } else if (end > start) this.fragments.push(chunk.subarray(start, end));
      }
      if (newline === -1) return;
      start = newline + 1;
      if (this.discarding) {
        // Reject the whole record, not just its prefix. Resume only after its LF.
        this.discarding = false;
        continue;
      }
      const line = Buffer.concat(this.fragments, this.length).toString('utf8').replace(/\r$/, '');
      this.fragments = [];
      this.length = 0;
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || typeof record.type !== 'string')
          throw new Error('缺少事件类型');
        this.emit(record);
      } catch (e) {
        this.invalid(
          new Error('无法读取 Pi 返回的内容。请重新连接；如果仍然失败，请检查 Pi 版本是否兼容。', {
            cause: e,
          }),
        );
      }
    }
  }
}
export class PiRpc extends EventEmitter {
  child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { command: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private writes = Promise.resolve();
  private termination?: Promise<void>;
  closed = false;
  start(spec: CommandSpec, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    if (this.child) throw new Error('进程已启动');
    this.child = spawn(spec.command, [...spec.args, ...args], {
      cwd,
      windowsHide: true,
      // Own process group on POSIX so killTree can stop commands Pi spawned, not just Pi itself.
      detached: !isWindows,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env, ...env },
    });
    const decoder = new LfJsonDecoder(
      (record) => {
        if (
          record.type === 'extension_ui_request' &&
          record.method === 'notify' &&
          typeof record.message === 'string' &&
          record.message.startsWith('__PI_DESKTOP__')
        ) {
          try {
            this.emit('event', JSON.parse(record.message.slice('__PI_DESKTOP__'.length)));
          } catch {
            this.emit('protocolError', new Error('桌面适配返回了无效数据'));
          }
          return;
        }
        if (record.type === 'response' && typeof record.id === 'string') {
          const item = this.pending.get(record.id);
          if (item) {
            clearTimeout(item.timer);
            this.pending.delete(record.id);
            try {
              if (record.command !== item.command || typeof record.success !== 'boolean')
                incompatible(item.command, '响应命令或成功标记无效');
              if (record.success) {
                validateRpcResult(item.command, record.data);
                item.resolve(record.data);
              } else item.reject(new Error(record.error || 'Pi 拒绝了命令'));
            } catch (error) {
              item.reject(error as Error);
            }
          }
        } else this.emit('event', record);
      },
      (error) => {
        this.emit('protocolError', error);
      },
    );
    this.child.stdout.on('data', (chunk) => decoder.push(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => this.emit('diagnostic', text));
    this.child.on('error', (error) => {
      this.rejectAll(error);
      this.emit('fault', error);
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`Pi 进程已退出 (${code ?? signal})`));
      this.emit('exit', code, signal);
    });
    this.child.stdin.on('error', (e) => this.rejectAll(e));
  }
  private rejectAll(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  write(record: object) {
    this.writes = this.writes
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (!this.child || this.closed || this.child.stdin.destroyed)
              return reject(new Error('Pi 未连接'));
            this.child.stdin.write(JSON.stringify(record) + '\n', 'utf8', (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
    return this.writes;
  }
  request<K extends string>(
    type: K,
    values: Record<string, unknown> = {},
    timeout = 30_000,
  ): Promise<RpcResult<K>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error('Pi 响应超时，请检查任务状态；若持续无响应，请重新连接。', {
            cause: new Error(`Pi request timed out: ${type}`),
          }),
        );
      }, timeout);
      this.pending.set(id, { command: type, resolve, reject, timer });
      this.write({ id, type, ...values }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }
  async bridge(method: string, params: unknown = {}, timeout = 600_000) {
    const { commands } = await this.request('get_commands');
    if (!commands.some((command) => command.name === DESKTOP_BRIDGE_COMMAND))
      throw new Error('Pi 桌面适配扩展未加载，已停止调用。请打开诊断检查扩展错误并重新连接。');
    const id = randomUUID();
    let result: any;
    let received = false;
    const listener = (event: any) => {
      if (event.type === 'desktop_result' && event.id === id) {
        result = event;
        received = true;
      }
    };
    this.on('event', listener);
    try {
      await this.request(
        'prompt',
        {
          message:
            '/' +
            DESKTOP_BRIDGE_COMMAND +
            ' ' +
            Buffer.from(JSON.stringify({ id, method, params })).toString('base64'),
        },
        timeout,
      );
      if (!received) throw new Error('Pi 桌面适配未响应，请重新连接');
      if (result.error) throw new Error(result.error);
      validateBridgeResult(method, result.data);
      return result.data;
    } catch (error) {
      if (
        method === 'side_chat' &&
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === 'Pi request timed out: prompt'
      ) {
        await this.bridge('side_chat_abort', { id: (params as { id: string }).id }, 5000).catch(() => {});
      }
      throw error;
    } finally {
      this.off('event', listener);
    }
  }
  async close() {
    if (!this.child || this.closed) return;
    this.child.stdin.end();
    await this.waitExit(2000);
    if (!this.closed) {
      try {
        await this.killTree();
      } catch (error) {
        // Pi can finish its graceful shutdown after the timeout but before taskkill runs.
        // Only close may accept that exit: failed tree termination must remain unconfirmed,
        // so a running tool still blocks recovery even when the root process is gone.
        if (!(error instanceof WindowsProcessNotFoundError) || error.pid !== this.child.pid) throw error;
        // Node can deliver taskkill's result before the original child's exit event.
        await this.waitExit(5000);
        if (!this.closed) throw error;
      }
    }
  }
  private waitExit(ms: number) {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('exit', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.once('exit', done);
    });
  }
  /** Only our completed tree termination can prove that a tool was stopped with Pi. */
  async treeTerminationConfirmed() {
    if (!this.termination) return false;
    try {
      await this.termination;
      return true;
    } catch {
      return false;
    }
  }
  killTree() {
    if (this.termination) return this.termination;
    if (!this.child?.pid || this.closed) return Promise.resolve();
    const attempt = this.terminateTree();
    this.termination = attempt;
    void attempt.catch(() => {
      if (this.termination === attempt) this.termination = undefined;
    });
    return attempt;
  }
  private async terminateTree() {
    const pid = this.child?.pid;
    if (!pid || this.closed) return;
    await terminateProcessTree(pid);
    await this.waitExit(5000);
    if (!this.closed) throw new Error('进程未确认退出');
  }
}
