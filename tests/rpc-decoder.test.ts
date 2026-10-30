import test from 'node:test';
import assert from 'node:assert/strict';
import { LfJsonDecoder } from '../electron/rpc';

test('large fragmented records preserve their payload and the following partial record', () => {
  const values: any[] = [],
    errors: Error[] = [];
  const decoder = new LfJsonDecoder(
    (value) => values.push(value),
    (error) => errors.push(error),
  );
  const payload = '中文🙂'.repeat(400_000);
  const bytes = Buffer.from(
    JSON.stringify({ type: 'response', data: payload }) + '\r\n\n{"type":"next","text":"',
  );
  for (let offset = 0; offset < bytes.length; offset += 65536)
    decoder.push(bytes.subarray(offset, offset + 65536));
  assert.deepEqual(values, [{ type: 'response', data: payload }]);
  decoder.push(Buffer.from('done"}\ninvalid\n{"type":"last"}\n'));
  assert.deepEqual(values.slice(1), [{ type: 'next', text: 'done' }, { type: 'last' }]);
  assert.equal(errors.length, 1);
});

test('unfinished oversized records are discarded through LF before reading another record', () => {
  const values: any[] = [],
    errors: Error[] = [];
  const decoder = new LfJsonDecoder(
    (value) => values.push(value),
    (error) => errors.push(error),
    128,
  );
  const chunk = Buffer.from('x');
  for (let i = 0; i < 128; i++) decoder.push(chunk);
  assert.equal(errors.length, 0);
  decoder.push(Buffer.from('x'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /内容过大.*终端导出/);
  decoder.push(Buffer.from('{"type":"not-a-new-record"}\n{"type":"recovered"}\n'));
  assert.deepEqual(values, [{ type: 'recovered' }]);
  assert.equal(errors.length, 1);
});

test('the final fragment and complete records are limited by UTF-8 bytes before parsing', () => {
  const record = Buffer.from(JSON.stringify({ type: 'response', data: '中文🙂' }));
  for (const split of [0, record.length - 1, record.length]) {
    for (const limit of [record.length - 1, record.length]) {
      const values: unknown[] = [],
        errors: Error[] = [];
      const decoder = new LfJsonDecoder(
        (value) => values.push(value),
        (error) => errors.push(error),
        limit,
      );
      decoder.push(record.subarray(0, split));
      decoder.push(Buffer.concat([record.subarray(split), Buffer.from('\n{"type":"next"}\n')]));
      assert.deepEqual(
        values,
        limit === record.length
          ? [{ type: 'response', data: '中文🙂' }, { type: 'next' }]
          : [{ type: 'next' }],
      );
      assert.equal(errors.length, limit === record.length ? 0 : 1);
      if (errors.length) assert.match(errors[0].message, /内容过大/);
    }
  }
});
