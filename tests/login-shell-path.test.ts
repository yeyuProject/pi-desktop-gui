import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// Run the production loader and executable lookup with a controlled shell on every host OS.
const source = readFileSync('electron/platform.ts', 'utf8');
const loader = source.slice(
  source.indexOf('let loginShellPath:'),
  source.indexOf('export const fileManagerName'),
);
const lookup = source.slice(
  source.indexOf('export async function locateExecutable'),
  source.indexOf('export async function shellCandidates'),
);
const { code } = transformSync(
  `const create = (exec, process, isWindows, isMac) => {
    ${[loader, lookup].join('\n').replace(/^export /gm, '')}
    return { load: loadLoginShellPath, locate: locateExecutable };
  };`,
  { loader: 'ts', format: 'cjs' },
);
const create = new Function(`${code}\nreturn create;`)();

test('concurrent POSIX lookups await one login shell and inherit its merged PATH', async () => {
  let release!: (value: { stdout: string }) => void;
  const shell = new Promise<{ stdout: string }>((resolve) => (release = resolve));
  const calls: string[] = [];
  const process = { env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } };
  const loader = create(
    async (command: string, _args: string[], options: any) => {
      calls.push(command);
      if (command === '/bin/zsh') {
        assert.equal(options.timeout, 5000);
        return shell;
      }
      assert.equal(process.env.PATH, '/fixture/bin:/usr/bin');
      return { stdout: '/fixture/bin/git\n' };
    },
    process,
    false,
    true,
  );
  const first = loader.load();
  assert.equal(loader.load(), first);
  const found = loader.locate('git');
  assert.deepEqual(calls, ['/bin/zsh'], 'executable lookup must wait without spawning which early');
  release({ stdout: 'shell banner\n__PI_DESKTOP_PATH__/fixture/bin:/usr/bin__PI_DESKTOP_PATH__\n' });
  assert.equal(await found, '/fixture/bin/git');
  await loader.load();
  assert.deepEqual(calls, ['/bin/zsh', 'which']);
});

test('a failed login shell preserves PATH, coalesces automatic retries and permits explicit redetection', async () => {
  const process = { env: { PATH: '/usr/bin' } };
  let calls = 0;
  const loader = create(
    async () => {
      calls++;
      throw new Error('shell timeout');
    },
    process,
    false,
    false,
  );
  await Promise.all([loader.load(), loader.load()]);
  await loader.load();
  assert.equal(calls, 1);
  assert.equal(process.env.PATH, '/usr/bin');
  await loader.load(true);
  assert.equal(calls, 2, 'explicit redetection retries a failed shell');
});

test('Windows lookup does not start a login shell', async () => {
  const calls: string[] = [];
  const loader = create(
    async (command: string) => {
      calls.push(command);
      return { stdout: 'C:\\Git\\cmd\\git.exe\n' };
    },
    { env: {} },
    true,
    false,
  );
  await loader.load();
  assert.equal(await loader.locate('git'), 'C:\\Git\\cmd\\git.exe');
  assert.deepEqual(calls, ['where.exe']);
});
