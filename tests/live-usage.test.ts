import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveUsage } from '../electron/live-usage';
import { liveContextUsage } from '../src/lib/context-usage';
import { ContextMeter } from '../src/components/conversation/Usage';

test('stream estimates accumulate across chunks and use reported input when available', () => {
  const live = new LiveUsage();
  assert.deepEqual(live.update(undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), {
    outputTokens: 0,
  });
  assert.equal(live.update({ type: 'text_delta', delta: 'abcd' }).outputTokens, 1);
  assert.equal(live.update({ type: 'thinking_delta', delta: '中文' }).outputTokens, 3);
  assert.equal(live.update({ type: 'toolcall_delta', delta: 'efgh' }).outputTokens, 4);
  assert.equal(live.update({ type: 'text_end', delta: 'ignored' }).outputTokens, 4);
  assert.deepEqual(live.update(undefined, { input: 10, cacheRead: 30, cacheWrite: 5, output: 8 }), {
    outputTokens: 8,
    inputTokens: 45,
  });
  assert.deepEqual(live.update(undefined, { input: -1, cacheRead: 0, cacheWrite: 0, output: NaN }), {
    outputTokens: 8,
    inputTokens: 45,
  });
});

test('live meter labels its projection and keeps confirmed details and cost separate', () => {
  const stats = { tokens: 1000, cost: 0.02, contextTokens: 500, contextWindow: 10000, contextPercent: 5 };
  const live = { outputTokens: 20 };
  const projected = liveContextUsage(stats, live)!;
  assert.equal(projected.tokens, 1520);
  assert.equal(projected.contextTokens, 520);
  assert.equal(projected.contextPercent, 5.2);
  assert.equal(liveContextUsage(stats, { ...live, inputTokens: 800 })?.tokens, 1820);
  const html = renderToStaticMarkup(React.createElement(ContextMeter, { stats, liveUsage: live, open() {} }));
  assert.match(html, /上下文约 5% \(520 \/ 10k\)/);
  assert.match(html, /累计约 1,520 tokens/);
  assert.match(html, /已计约 \$0\.02/);
  assert.match(html, /回复结束后以 Pi 上报为准/);
  assert.deepEqual(stats, {
    tokens: 1000,
    cost: 0.02,
    contextTokens: 500,
    contextWindow: 10000,
    contextPercent: 5,
  });
});

test('live meter does not invent a request input or a known cumulative total', () => {
  assert.equal(liveContextUsage({ tokens: 10 }, { outputTokens: 4 }), undefined);
  const html = renderToStaticMarkup(
    React.createElement(ContextMeter, { stats: { tokens: 10 }, liveUsage: { outputTokens: 4 }, open() {} }),
  );
  assert.match(html, /累计 10 \+ 输出约 4 tokens/);
  assert.doesNotMatch(html, /累计约 14 tokens/);
  assert.equal(liveContextUsage({ contextTokens: 12 }, { outputTokens: 4 })?.tokens, undefined);
});
