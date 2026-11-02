import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { launchApp, closeApp, DESKTOP_TIMEOUTS } from './support/desktop-app.mjs';

test('desktop launcher preserves explicit fixtures and packaged args while collecting page errors', async (t) => {
  const inherited = process.env.PI_DESKTOP_DEV_URL;
  process.env.PI_DESKTOP_DEV_URL = 'http://inherited.invalid';
  t.after(() => {
    if (inherited === undefined) delete process.env.PI_DESKTOP_DEV_URL;
    else process.env.PI_DESKTOP_DEV_URL = inherited;
  });
  let options, wait, timeout, onError;
  const page = {
    setDefaultTimeout(value) {
      timeout = value;
    },
    on(event, listener) {
      assert.equal(event, 'pageerror');
      onError = listener;
    },
  };
  const app = {
    process: () => ({ exitCode: null }),
    async firstWindow(value) {
      wait = value;
      return page;
    },
  };
  t.mock.method(electron, 'launch', async (value) => {
    options = value;
    return app;
  });
  const errors = [];
  const result = await launchApp({
    dataDir: 'fixture-data',
    executablePath: 'packaged.exe',
    errors,
    clipboardMode: 'native',
  });
  assert.equal(result.app, app);
  assert.equal(result.page, page);
  assert.deepEqual(options.args, []);
  assert.equal(options.env.PI_DESKTOP_DATA_DIR, 'fixture-data');
  assert.equal(options.env.PI_DESKTOP_DEV_URL, undefined);
  assert.equal(options.env.PI_OFFLINE, '1');
  assert.equal(options.timeout, DESKTOP_TIMEOUTS.launch);
  assert.equal(wait.timeout, DESKTOP_TIMEOUTS.launch);
  assert.equal(timeout, DESKTOP_TIMEOUTS.action);
  onError(new Error('render failure'));
  assert.deepEqual(errors, ['render failure']);
  await launchApp({
    args: ['custom-entry.cjs'],
    pageTimeout: 25000,
    clipboardMode: 'native',
    env: { PI_DESKTOP_DEV_URL: 'http://fixture' },
  });
  assert.deepEqual(options.args, ['custom-entry.cjs']);
  assert.equal(options.env.PI_DESKTOP_DEV_URL, 'http://fixture');
  assert.equal(timeout, 25000);
});

test('a failed first window closes the launched app and reports the original error', async (t) => {
  let closed = 0;
  const failure = new Error('no window');
  const child = { exitCode: null };
  const app = {
    firstWindow: async () => {
      throw failure;
    },
    process: () => child,
    windows: () => [],
    close: async () => {
      closed++;
      child.exitCode = 0;
    },
  };
  t.mock.method(electron, 'launch', async () => app);
  await assert.rejects(
    launchApp({ dataDir: 'fixture-data', clipboardMode: 'native' }),
    (error) => error === failure,
  );
  assert.equal(closed, 1);
  await closeApp(undefined);
  app.process = () => {
    throw new Error('Playwright dispatcher was disposed');
  };
  await closeApp(app);
  assert.equal(closed, 1);
});

test('memory clipboard is opt-in and replaces only text transport in the owned test app', async (t) => {
  const nativeRead = () => {};
  const clipboard = {
    writeText: () => assert.fail('must not write the OS clipboard'),
    readText: () => assert.fail('must not read the OS clipboard'),
    read: nativeRead,
  };
  const app = {
    process: () => ({ exitCode: 0 }),
    evaluate: async (callback) => callback({ clipboard }),
    firstWindow: async () => ({ setDefaultTimeout() {}, on() {} }),
  };
  t.mock.method(electron, 'launch', async () => app);
  await launchApp({ clipboardMode: 'memory' });
  await clipboard.writeText('copied fixture');
  assert.equal(await clipboard.readText(), 'copied fixture');
  assert.equal(clipboard.read, nativeRead);
});
