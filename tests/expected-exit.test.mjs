import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { completeExpectedExit } from '../scripts/expected-exit.ts';

const closedError = () => new Error('page.evaluate: Target page, context or browser has been closed');
function fixture(t, code = 0) {
  const child = spawn(process.execPath, ['-e', `process.stdin.once('data', () => process.exit(${code}))`], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const closed = once(child, 'close');
  return { child, closed, quit: () => child.stdin.write('quit') };
}

test('a successful real process exit may close the renderer transport before action acknowledgement', async (t) => {
  const { child, closed, quit } = fixture(t);
  await completeExpectedExit(
    async () => {
      quit();
      await closed;
      throw closedError();
    },
    closed,
    child,
  );
  assert.equal(child.exitCode, 0);
});

test('acknowledged quit still waits for the real process and expected close', async (t) => {
  const { child, closed, quit } = fixture(t);
  assert.deepEqual(await completeExpectedExit(quit, closed, child), {
    code: 0,
    signal: null,
    actionAcknowledged: true,
  });
});

test('renderer closure cannot hide a nonzero process exit', async (t) => {
  const { child, closed, quit } = fixture(t, 3);
  await assert.rejects(
    completeExpectedExit(
      async () => {
        quit();
        await closed;
        throw closedError();
      },
      closed,
      child,
    ),
    /did not exit cleanly.*code=3/,
  );
});

test('unrelated action errors remain failures even with a clean process exit', async (t) => {
  const { child, closed, quit } = fixture(t);
  const failure = new Error('button not found');
  await assert.rejects(
    completeExpectedExit(
      () => {
        quit();
        throw failure;
      },
      closed,
      child,
    ),
    (error) => error === failure,
  );
});

test('a missing close observation is not replaced by process exit', async (t) => {
  const { child, quit } = fixture(t);
  const failure = new Error('expected close event timed out');
  await assert.rejects(
    completeExpectedExit(quit, Promise.reject(failure), child),
    (error) => error === failure,
  );
});

test('renderer closure without process termination fails after its deadline', async (t) => {
  const { child } = fixture(t);
  await assert.rejects(
    completeExpectedExit(
      () => {
        throw closedError();
      },
      Promise.resolve(),
      child,
      30,
    ),
    /exit timed out/,
  );
  assert.equal(child.listenerCount('exit'), 0, 'timeout removes its process listener');
});

test('an already exited process cannot count as the requested quit', async (t) => {
  const { child, closed, quit } = fixture(t);
  quit();
  await closed;
  await assert.rejects(
    completeExpectedExit(() => assert.fail('must not trigger'), closed, child),
    /before the explicit exit action/,
  );
});

test('an absent close event has a deadline even if the child exits cleanly', async (t) => {
  const { child, quit } = fixture(t);
  await assert.rejects(
    completeExpectedExit(quit, new Promise(() => {}), child, 500),
    /Expected close event timed out/,
  );
});
