import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { machArchitectures } from '../electron/macho';

test('thin Mach-O headers distinguish Intel and Apple Silicon, in either byte order', () => {
  for (const little of [true, false])
    for (const [cpu, arch] of [
      [0x01000007, 'x64'],
      [0x0100000c, 'arm64'],
    ] as const) {
      const b = Buffer.alloc(32);
      if (little) {
        b.writeUInt32LE(0xfeedfacf, 0);
        b.writeUInt32LE(cpu, 4);
      } else {
        b.writeUInt32BE(0xfeedfacf, 0);
        b.writeUInt32BE(cpu, 4);
      }
      assert.deepEqual(machArchitectures(b), [arch]);
      assert.deepEqual(machArchitectures(b.subarray(0, 8)), []);
    }
});
test('universal 32/64 bit architecture tables support both byte orders', () => {
  for (const wide of [false, true])
    for (const little of [false, true]) {
      const stride = wide ? 32 : 20;
      const b = Buffer.alloc(8 + 2 * stride);
      const put = (value: number, offset: number) =>
        little ? b.writeUInt32LE(value, offset) : b.writeUInt32BE(value, offset);
      put(wide ? 0xcafebabf : 0xcafebabe, 0);
      put(2, 4);
      put(0x01000007, 8);
      put(0x0100000c, 8 + stride);
      assert.deepEqual(machArchitectures(b), ['x64', 'arm64']);
      assert.deepEqual(machArchitectures(b.subarray(0, b.length - 1)), []);
    }
});
test('malformed, truncated, unsupported and excessive tables fail closed', () => {
  for (const b of [Buffer.alloc(0), Buffer.alloc(7), Buffer.from('not an executable')])
    assert.deepEqual(machArchitectures(b), []);
  const b = Buffer.alloc(48);
  b.writeUInt32BE(0xcafebabe, 0);
  for (const count of [0, 3, 33, 0xffffffff]) {
    b.writeUInt32BE(count, 4);
    assert.deepEqual(machArchitectures(b), []);
  }
  b.writeUInt32BE(0xfeedfacf, 0);
  b.writeUInt32BE(7, 4);
  assert.deepEqual(machArchitectures(b), []);
});
test(
  'real Electron executable and universal exchange helper need no Xcode command at runtime',
  { skip: process.platform !== 'darwin' },
  async () => {
    const executable = createRequire(import.meta.url)('electron') as string;
    const binary = await fs.readFile(executable);
    assert.ok(machArchitectures(binary.subarray(0, 1032)).includes(process.arch));
    const swap = await fs.readFile(path.resolve('dist-electron/mac-update-swap'));
    assert.deepEqual(machArchitectures(swap.subarray(0, 1032)).sort(), ['arm64', 'x64']);
  },
);
