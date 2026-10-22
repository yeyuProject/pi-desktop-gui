import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';
import { AgentService } from '../electron/agent';
import { Workspace } from '../electron/workspace';
import { Configuration } from '../electron/configuration';
import { busy } from '../shared/types';
process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider(),
  f = await prepareRealPiFixture(provider.baseUrl, 'management');
const s = new AgentService(f.store, new Workspace(f.dataDir));
async function until(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 20000) throw new Error('Timeout ' + s.runtime.status + ' ' + s.runtime.error);
    await new Promise((r) => setTimeout(r, 40));
  }
}
try {
  await fs.writeFile(
    path.join(f.agentDir, 'extensions', 'oauth-test.js'),
    `export default function(pi) {
    pi.registerProvider('desktop-oauth-test', { baseUrl:'${provider.baseUrl}', api:'openai-completions', models:[], oauth:{
      name:'Desktop OAuth test', async login(c) { c.onAuth({url:'https://example.invalid/test-oauth',instructions:'OAuth local fixture'}); const code=await c.onPrompt({message:'OAuth 测试验证码'}); if(code!=='fixture-code')throw new Error('Cancelled'); return {access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000}; },
      async refreshToken(c){return c;}, getApiKey(c){return c.access;}
    }});
  }`,
  );
  await s.connect(f.sessionId);
  assert.ok(
    (await s.admin(f.sessionId, 'providers')).some((p: any) => p.id === 'desktop-oauth-test' && p.oauth),
  );
  const login = s.admin(f.sessionId, 'login', { provider: 'desktop-oauth-test', type: 'oauth' });
  await until(() => s.runtime.dialogs.length > 0);
  assert.equal(s.runtime.auth?.url, 'https://example.invalid/test-oauth');
  await s.respond(s.runtime.dialogs[0].id, { value: 'fixture-code' });
  await login;
  const auth = JSON.parse(await fs.readFile(path.join(f.agentDir, 'auth.json'), 'utf8'));
  assert.equal(auth['desktop-oauth-test'].type, 'oauth');
  assert.ok(!JSON.stringify(s.runtime).includes('fixture-access'));
  await s.admin(f.sessionId, 'logout', { provider: 'desktop-oauth-test' });
  const cancelled = s.admin(f.sessionId, 'login', { provider: 'desktop-oauth-test', type: 'oauth' }).then(
    () => false,
    () => true,
  );
  await until(() => s.runtime.dialogs.length > 0);
  await s.cancelLogin();
  assert.equal(await cancelled, true);
  assert.equal(s.runtime.dialogs.length, 0);
  console.log(
    'PASS OAuth URL, code prompt, native credential persistence, logout and cancellation (local fixture)',
  );
  const callbackHelper = pathToFileURL(
    path.resolve('node_modules/@earendil-works/pi-ai/dist/auth/oauth/callback-server.js'),
  ).href;
  await fs.writeFile(
    path.join(f.agentDir, 'extensions', 'oauth-callback-test.js'),
    `import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
    import { startOAuthCallbackServer, waitForCallbackOrManualInput } from '${callbackHelper}';
    export default function(pi) {
      pi.registerProvider({ ...openaiCodexProvider(), id:'desktop-callback-test', name:'Local callback test', auth:{oauth:{
        name:'Local callback test', async login(interaction) {
          const callback = await startOAuthCallbackServer({providerName:'Local test',host:'127.0.0.1',port:0,path:'/auth/callback',state:'fixture-state',complete:async code=>code,signal:interaction.signal});
          interaction.notify({type:'auth_url',url:callback.redirectUri});
          try {
            const result=await waitForCallbackOrManualInput(interaction,callback,{message:'Callback manual input',placeholder:callback.redirectUri});
            if(result.type!=='callback'||result.value!=='fixture-code')throw new Error('Local callback failed');
            return {type:'oauth',access:'callback-access',refresh:'callback-refresh',expires:Date.now()+3600000};
          } finally { callback.close(); }
        }, async refresh(c){return c;}, async toAuth(c){return {apiKey:c.access};}
      }}});
    }`,
  );
  await s.disconnect();
  await s.connect(f.sessionId);
  const callbackLogin = s.admin(f.sessionId, 'login', {
    provider: 'desktop-callback-test',
    type: 'oauth',
  });
  await until(() => s.runtime.dialogs.some((dialog) => dialog.title === 'Callback manual input'));
  const callbackResponse = await fetch(`${s.runtime.auth!.url}?code=fixture-code&state=fixture-state`);
  assert.equal(callbackResponse.status, 200);
  await callbackLogin;
  const callbackAuth = JSON.parse(await fs.readFile(path.join(f.agentDir, 'auth.json'), 'utf8'));
  assert.equal(callbackAuth['desktop-callback-test'].type, 'oauth');
  assert.equal(s.runtime.auth, undefined);
  assert.equal(s.runtime.dialogs.length, 0);
  assert.equal(s.runtime.status, 'idle');
  assert.ok(!JSON.stringify(s.runtime).includes('callback-access'));
  console.log('PASS real Pi browser callback, credential persistence and automatic prompt cleanup');
  const config = new Configuration(f.store),
    doc = await config.read(f.sessionId, 'mcp', false);
  await s.disconnect();
  await config.save(f.sessionId, 'mcp', false, {
    ...doc,
    text: JSON.stringify({
      mcpServers: {
        desktop: {
          command: process.execPath,
          args: [path.resolve('tests/support/mcp-server.mjs')],
          exposure: 'direct',
        },
      },
    }),
  });
  await s.connect(f.sessionId);
  await s.send(f.sessionId, '/mcp', [], 'steer');
  assert.ok(s.runtime.notices.some((n) => n.includes('desktop')));
  const resources = await s.admin(f.sessionId, 'resources');
  assert.ok(resources.tools.some((t: any) => t.name === 'mcp__desktop__ping'));
  await s.send(f.sessionId, 'E2E_MCP', [], 'steer');
  await until(() => !busy(s.runtime.status));
  assert.equal(s.runtime.status, 'completed');
  assert.ok(s.runtime.tools.some((t) => t.output.includes('MCP_TEST_OK') && t.status === 'done'));
  await s.send(f.sessionId, '/mcp reconnect desktop', [], 'steer');
  console.log('PASS configured stdio MCP server, discovery, real model tool call and reconnect');
  const disabled = await config.read(f.sessionId, 'mcp', false);
  const json = JSON.parse(disabled.text);
  json.mcpServers.desktop.enabled = false;
  await s.disconnect();
  await config.save(f.sessionId, 'mcp', false, { ...disabled, text: JSON.stringify(json) });
  await s.connect(f.sessionId);
  assert.ok(
    !(await s.admin(f.sessionId, 'resources')).tools.some((t: any) => t.name === 'mcp__desktop__ping'),
  );
  console.log('PASS disabled MCP removes tools');
  console.log('Management integration PASS:', f.dir);
} finally {
  await s.cancelLogin().catch(() => {});
  await s.dispose();
  await provider.close();
}
