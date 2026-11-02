import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../electron/store';
import { Configuration } from '../electron/configuration';
import { validateImages } from '../electron/images';
import { toggleResourceSetting } from '../electron/resources-config';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kXQAAAAASUVORK5CYII=';
test('image attachments reject forged types, oversize, and non-image data', () => {
  const image = { id: '1', name: 'test.png', mimeType: 'image/png', data: png };
  validateImages([image]);
  assert.throws(() => validateImages([{ ...image, mimeType: 'image/jpeg' }]));
  assert.throws(() =>
    validateImages([{ ...image, data: Buffer.from('<svg onload="bad"/>').toString('base64') }]),
  );
  assert.throws(() => validateImages(Array(9).fill(image)));
});
test('configuration preserves secrets, backs up and rejects stale writes', async () => {
  await fs.mkdir(path.resolve('work/config-tests'), { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('work/config-tests/case-'));
  const store = new Store(dir);
  await store.load();
  store.state.settings.agentDir = path.join(dir, 'agent');
  const s = store.createSession();
  const config = new Configuration(store);
  await fs.mkdir(store.state.settings.agentDir, { recursive: true });
  const file = path.join(store.state.settings.agentDir, 'models.json');
  const original = {
    providers: {
      cpa: {
        apiKey: 'private-test-credential',
        baseUrl: 'https://example.com',
        headers: { Authorization: 'Bearer private-test-token' },
        models: [{ id: 'test' }],
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(original));
  const document = await config.read(s.id, 'models', false);
  assert.ok(!document.text.includes('private-test'));
  assert.ok(document.text.includes('已保存的密钥'));
  const edit = JSON.parse(document.text);
  edit.providers.cpa.baseUrl = 'https://example.org';
  await config.save(s.id, 'models', false, { ...document, text: JSON.stringify(edit) });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.providers.cpa.apiKey, original.providers.cpa.apiKey);
  assert.equal(saved.providers.cpa.headers.Authorization, original.providers.cpa.headers.Authorization);
  assert.deepEqual(JSON.parse(await fs.readFile(file + '.desktop-backup', 'utf8')), original);
  await assert.rejects(config.save(s.id, 'models', false, document), /在你编辑时被别处改过了/);
  await assert.rejects(config.read(s.id, 'models', true), /个人范围/);
});
test('resource toggles keep unrelated package filters and settings', () => {
  const config = {
    theme: 'dark',
    packages: [{ source: 'npm:demo', skills: ['**/*', '-skills/old/SKILL.md'], extensions: [] }],
  };
  const r = {
    kind: 'skills' as const,
    path: path.resolve('work/pkg/skills/new/SKILL.md'),
    enabled: true,
    metadata: { origin: 'package', scope: 'user', source: 'npm:demo', baseDir: path.resolve('work/pkg') },
  };
  const saved = toggleResourceSetting(config, r, false);
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.packages[0].extensions, []);
  assert.ok(saved.packages[0].skills.includes('-skills/new/SKILL.md'));
  assert.ok(saved.packages[0].skills.includes('-skills/old/SKILL.md'));
  toggleResourceSetting(saved, r, true);
  assert.ok(!saved.packages[0].skills.includes('-skills/new/SKILL.md'));
  assert.ok(saved.packages[0].skills.includes('+skills/new/SKILL.md'));
});
