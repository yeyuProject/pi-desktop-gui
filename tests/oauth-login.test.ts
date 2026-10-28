import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { createModels, type Provider } from '@earendil-works/pi-ai/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { InMemoryCredentialStore } from '../node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js';
import {
  startOAuthCallbackServer,
  waitForCallbackOrManualInput,
} from '../node_modules/@earendil-works/pi-ai/dist/auth/oauth/callback-server.js';
import desktopBridge from '../electron/pi-bridge';
import { DESKTOP_BRIDGE_COMMAND } from '../shared/pi-bridge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function loginFixture(t: TestContext) {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const ready = deferred<{ url: string; reply: (value: string | undefined) => void }>();
  let callbackUrl = '';
  let loginSignal: AbortSignal | undefined;
  const provider: Provider = {
    ...openaiCodexProvider(),
    id: 'desktop-oauth-test',
    auth: {
      oauth: {
        name: 'Local browser callback',
        async login(interaction) {
          loginSignal = interaction.signal;
          const callback = await startOAuthCallbackServer({
            providerName: 'Local test',
            host: '127.0.0.1',
            port: 0,
            path: '/auth/callback',
            state: 'local-state',
            complete: async (code) => code,
            signal: interaction.signal,
          });
          callbackUrl = callback.redirectUri;
          interaction.notify({ type: 'auth_url', url: callbackUrl });
          try {
            const result = await waitForCallbackOrManualInput(interaction, callback, {
              message: 'Paste the redirect URL',
              placeholder: callbackUrl,
            });
            assert.equal(result.type === 'callback' ? result.value : result.input, 'local-code');
            return {
              type: 'oauth',
              access: 'local-access',
              refresh: 'local-refresh',
              expires: Date.now() + 3600000,
            };
          } finally {
            callback.close();
          }
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
  models.setProvider(provider);
  t.mock.method(ModelRuntime, 'create', async () => models as never);
  let handler!: (encoded: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi: Pick<ExtensionAPI, 'on' | 'registerCommand' | 'registerTool'> = {
    on() {
      return () => {};
    },
    registerCommand(name, command) {
      if (name === DESKTOP_BRIDGE_COMMAND) handler = command.handler;
    },
    registerTool() {},
  };
  desktopBridge(pi as ExtensionAPI);
  const events: any[] = [];
  let refreshed = 0;
  const ctx = {
    modelRegistry: {
      getRegisteredProviderIds: () => [],
      refresh: async () => {
        refreshed++;
      },
    },
    ui: {
      notify(message: string) {
        events.push(JSON.parse(message.slice('__PI_DESKTOP__'.length)));
      },
      input(_title: string, _placeholder: string, options: { signal?: AbortSignal }) {
        return new Promise<string | undefined>((resolve) => {
          const aborted = () => resolve(undefined);
          options.signal?.addEventListener('abort', aborted, { once: true });
          ready.resolve({
            url: callbackUrl,
            reply(value) {
              options.signal?.removeEventListener('abort', aborted);
              resolve(value);
            },
          });
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  let sequence = 0;
  async function run(method: string) {
    const id = String(++sequence);
    await handler(
      Buffer.from(
        JSON.stringify({
          id,
          method,
          params: {
            provider: provider.id,
            type: 'oauth',
          },
        }),
      ).toString('base64'),
      ctx,
    );
    return events.find((event) => event.type === 'desktop_result' && event.id === id);
  }
  return {
    credentials,
    ready: ready.promise,
    run,
    events,
    signal: () => loginSignal,
    refreshed: () => refreshed,
  };
}

test(
  'browser callback closes manual input without cancelling OAuth credential storage',
  { timeout: 10000 },
  async (t) => {
    const f = await loginFixture(t);
    const login = f.run('login');
    const { url } = await f.ready;
    const response = await fetch(`${url}?code=local-code&state=local-state`);
    assert.equal(response.status, 200);
    const result = await login;
    assert.equal(result.error, undefined);
    assert.equal(f.signal()?.aborted, false);
    assert.equal((await f.credentials.read('desktop-oauth-test'))?.type, 'oauth');
    assert.equal(f.refreshed(), 1);
    assert.ok(f.events.some((event) => event.type === 'desktop_auth' && event.clear));
  },
);

test('pasted authorization code still completes OAuth login', { timeout: 10000 }, async (t) => {
  const f = await loginFixture(t);
  const login = f.run('login');
  const { reply } = await f.ready;
  reply('local-code');
  assert.equal((await login).error, undefined);
  assert.equal((await f.credentials.read('desktop-oauth-test'))?.type, 'oauth');
});

test('closing the login input cancels OAuth without saving credentials', { timeout: 10000 }, async (t) => {
  const f = await loginFixture(t);
  const login = f.run('login');
  const { reply } = await f.ready;
  reply(undefined);
  assert.ok((await login).error);
  assert.equal(f.signal()?.aborted, true);
  assert.equal(await f.credentials.read('desktop-oauth-test'), undefined);
  assert.equal(f.refreshed(), 0);
});

test('cancel login aborts the callback wait without saving credentials', { timeout: 10000 }, async (t) => {
  const f = await loginFixture(t);
  const login = f.run('login');
  await f.ready;
  await f.run('cancel_auth');
  assert.ok((await login).error);
  assert.equal(f.signal()?.aborted, true);
  assert.equal(await f.credentials.read('desktop-oauth-test'), undefined);
});
