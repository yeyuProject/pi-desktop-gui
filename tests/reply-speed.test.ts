import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../shared/types';
import { ReplySpeed } from '../src/components/conversation/Usage';

const reply: Message = {
  role: 'assistant',
  content: '回答',
  durationMs: 2000,
  usage: { input: 1000, output: 50, totalTokens: 1050 },
};
const render = (message: Message) => renderToStaticMarkup(React.createElement(ReplySpeed, { message }));

test('reply TPS uses output tokens and the response duration, not total token usage', () => {
  assert.match(render(reply), /25\.0 TPS/);
  assert.match(render(reply), /含等待模型响应时间，不含工具执行时间/);
});

test('missing or invalid measurements never invent a reply speed', () => {
  for (const durationMs of [undefined, 0, -1, NaN, Infinity])
    assert.equal(render({ ...reply, durationMs }), '');
  for (const output of [undefined, 0, -1, NaN, Infinity, '50'])
    assert.equal(render({ ...reply, usage: { output } }), '');
  assert.equal(render({ ...reply, usage: undefined }), '');
  assert.equal(render({ ...reply, role: 'user' }), '');
});
