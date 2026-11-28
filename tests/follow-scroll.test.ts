import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_SLACK,
  RELEASED_SLACK,
  isFollowing,
  isReplyStartAboveViewport,
  keyIntent,
  nextReleased,
  wheelIntent,
} from '../src/lib/follow-scroll';

const view = (distance: number) => ({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 - distance });
const key = (key: string, extra: { shiftKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  ...extra,
});

test('reply jump appears only when its start is more than 8 px above and its body is still visible', () => {
  const viewport = { top: 100 };
  for (const top of [100, 101, 92])
    assert.equal(isReplyStartAboveViewport(viewport, { top, bottom: 900 }), false);
  assert.equal(isReplyStartAboveViewport(viewport, { top: 91.9, bottom: 900 }), true);
  assert.equal(isReplyStartAboveViewport(viewport, { top: -900, bottom: 100.1 }), true);
  for (const bottom of [100, 99])
    assert.equal(isReplyStartAboveViewport(viewport, { top: -900, bottom }), false);
});

test('a small upward nudge releases following that the 24 px slack would otherwise keep', () => {
  let released = false;
  assert.equal(isFollowing(view(10), released), true);
  released = nextReleased(released, wheelIntent({ deltaY: -10 }));
  assert.equal(isFollowing(view(10), released), false);
  // The streaming writer keeps the bottom exact, so a released reader at the bottom still follows.
  assert.equal(isFollowing(view(0), released), true);
  assert.equal(isFollowing(view(RELEASED_SLACK), released), false);
});

test('scrolling down restores the normal slack; sideways wheels and other keys change nothing', () => {
  let released = nextReleased(false, 'up');
  released = nextReleased(released, wheelIntent({ deltaY: 0 }));
  assert.equal(released, true);
  released = nextReleased(released, keyIntent(key('a')));
  assert.equal(released, true);
  released = nextReleased(released, wheelIntent({ deltaY: 40 }));
  assert.equal(released, false);
  assert.equal(isFollowing(view(FOLLOW_SLACK - 1), released), true);
  assert.equal(isFollowing(view(FOLLOW_SLACK), released), false);
});

test('reading keys map to scroll intent; Alt+arrows navigate turns instead', () => {
  for (const name of ['ArrowUp', 'PageUp', 'Home']) assert.equal(keyIntent(key(name)), 'up', name);
  for (const name of ['ArrowDown', 'PageDown', 'End']) assert.equal(keyIntent(key(name)), 'down', name);
  assert.equal(keyIntent(key(' ')), 'down');
  assert.equal(keyIntent(key(' ', { shiftKey: true })), 'up');
  assert.equal(keyIntent(key('ArrowUp', { altKey: true })), undefined);
});
