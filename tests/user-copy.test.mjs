import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import userCopy from '../tools/lint/user-copy.mjs';
const require = createRequire(new URL('../tools/lint/config.mjs', import.meta.url));
const { Linter } = require('eslint');
const check = (code) =>
  new Linter().verify(code, {
    plugins: { 'pi-desktop': { rules: { 'user-copy': userCopy } } },
    rules: { 'pi-desktop/user-copy': 'error' },
  });
test('copy lint rejects internal terminology and raw exception interpolation while preserving diagnostics', () => {
  assert.ok(check("const text = '快照失败';").length);
  assert.ok(check('const text = `保存失败：${error.message}`;').length);
  assert.ok(check('const text = `读取失败：${String(error)}`;').length);
  assert.equal(check("console.error('快照失败', error.message);").length, 0);
  assert.equal(check('this.diagnostic(`快照失败：${error.message}`);').length, 0);
  assert.equal(check("const text = '找不到文件，请重新选择。';").length, 0);
});
