import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NoticeStore,
  noticeDuration,
  NOTICE_ENTER_MS,
  NOTICE_EXIT_MS,
  type NoticeClock,
} from '../src/lib/notice-store';

class ManualClock implements NoticeClock {
  time = 0;
  private next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.tasks.delete(id as number);
  };
  advance(amount: number) {
    const end = this.time + amount;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}

test('notice duration follows character count, severity and action time', () => {
  assert.equal(noticeDuration('已复制'), 3500);
  assert.equal(noticeDuration('文'.repeat(50)), 4500);
  assert.equal(noticeDuration('字'.repeat(200)), 8000);
  assert.equal(noticeDuration('后台通知', { level: 'info' }), 5000);
  assert.equal(noticeDuration('好', { action: { label: '撤销', run() {} } }), 6000);
  assert.equal(noticeDuration('警告', { level: 'warning' }), 9000);
  assert.equal(noticeDuration('错误', { level: 'error' }), Infinity);
});

test('identical text gets another id, another entrance and its own deadline', () => {
  const clock = new ManualClock(),
    store = new NoticeStore(clock);
  const first = store.notice('相同提示');
  clock.advance(1000);
  const second = store.notice('相同提示');
  assert.ok(second! > first!);
  assert.equal(store.get()[1].entering, true);
  clock.advance(NOTICE_ENTER_MS);
  assert.equal(store.get()[1].entering, false);
  clock.advance(3500 - 1000 - NOTICE_ENTER_MS);
  assert.equal(store.get()[0].leaving, true);
  assert.equal(store.get()[1].leaving, false);
  clock.advance(NOTICE_EXIT_MS);
  assert.deepEqual(
    store.get().map((item) => item.id),
    [second],
  );
  clock.advance(1000);
  assert.deepEqual(store.get(), []);
  store.dispose();
});

test('holding the stack stops every timer and releasing restarts them in full', () => {
  const clock = new ManualClock(),
    store = new NoticeStore(clock);
  store.notice('第一条');
  clock.advance(3000);
  store.hold('pointer');
  store.notice('悬停时到达');
  clock.advance(20000);
  assert.equal(store.get().length, 2);
  assert.ok(store.get().every((item) => !item.leaving));
  store.hold('focus');
  store.release('pointer');
  clock.advance(20000);
  assert.ok(store.get().every((item) => !item.leaving));
  store.release('focus');
  clock.advance(3499);
  assert.ok(store.get().every((item) => !item.leaving));
  clock.advance(1);
  assert.ok(store.get().every((item) => item.leaving));
  clock.advance(NOTICE_EXIT_MS);
  assert.deepEqual(store.get(), []);
  store.dispose();
});

test('per-notice pauses (placement, running action) are independent and preserve the remaining time', () => {
  const clock = new ManualClock(),
    store = new NoticeStore(clock);
  const id = store.notice('暂停提示')!;
  clock.advance(1000);
  store.pause(id, 'placement');
  store.pause(id, 'action');
  clock.advance(10000);
  assert.equal(store.get().length, 1);
  store.resume(id, 'placement');
  clock.advance(10000);
  assert.equal(store.get()[0].leaving, false);
  store.resume(id, 'action');
  clock.advance(2499);
  assert.equal(store.get()[0].leaving, false);
  clock.advance(1);
  assert.equal(store.get()[0].leaving, true);
  clock.advance(NOTICE_EXIT_MS);
  assert.deepEqual(store.get(), []);
});

test('a burst never renders more than three, including the entries leaving', () => {
  const clock = new ManualClock(),
    store = new NoticeStore(clock);
  const stop = store.subscribe(() => assert.ok(store.get().length <= 3));
  const ids = Array.from({ length: 5 }, (_, index) => store.notice(`提示 ${index}`));
  assert.equal(store.get().filter((item) => item.leaving).length, 2);
  clock.advance(NOTICE_EXIT_MS);
  assert.deepEqual(
    store.get().map((item) => item.id),
    ids.slice(-3),
  );
  for (let index = 0; index < 1000; index++) store.notice(`突发 ${index}`);
  clock.advance(NOTICE_EXIT_MS);
  assert.deepEqual(
    store.get().map((item) => item.text),
    ['突发 997', '突发 998', '突发 999'],
  );
  stop();
  store.dispose();
  assert.equal(clock.tasks.size, 0);
});

test('errors remain after pauses and do not give up their slots to ordinary notices', () => {
  const clock = new ManualClock(),
    store = new NoticeStore(clock);
  const ids = Array.from({ length: 3 }, (_, index) => store.notice(`错误 ${index}`, { level: 'error' }));
  store.pause(ids[0]!, 'placement');
  clock.advance(10000);
  store.resume(ids[0]!, 'placement');
  store.notice('普通提示');
  clock.advance(10000);
  assert.deepEqual(
    store.get().map((item) => item.id),
    ids,
  );
  const latest = store.notice('新的错误', { level: 'error' });
  clock.advance(NOTICE_EXIT_MS);
  assert.deepEqual(
    store.get().map((item) => item.id),
    [...ids.slice(1), latest],
  );
  clock.advance(100000);
  assert.equal(store.get().length, 3);
  store.dismiss(latest!);
  assert.equal(store.get().find((item) => item.id === latest)?.leaving, true);
  clock.advance(NOTICE_EXIT_MS);
  assert.equal(store.get().length, 2);
  store.dispose();
});

test('action notices last at least six seconds and disposal clears pending work', () => {
  const clock = new ManualClock(),
    store = new NoticeStore(clock);
  store.notice('已放行', { action: { label: '撤销', run() {} } });
  clock.advance(5999);
  assert.equal(store.get()[0].leaving, false);
  clock.advance(1);
  assert.equal(store.get()[0].leaving, true);
  store.dispose();
  assert.deepEqual(store.get(), []);
  assert.equal(clock.tasks.size, 0);
});
