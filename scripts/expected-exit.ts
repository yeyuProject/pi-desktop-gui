import type { ChildProcess } from 'node:child_process';

// A renderer can disappear before Playwright acknowledges the action that quits it.
// Accept that transport error only alongside the expected close and a clean process exit.
export async function completeExpectedExit(
  action: () => unknown | Promise<unknown>,
  closed: Promise<unknown>,
  child: ChildProcess,
  timeout = 60000,
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    void closed.catch(() => {});
    throw new Error('Application exited before the explicit exit action');
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Application exit timed out'));
    }, timeout);
    child.once('exit', onExit);
    child.once('error', onError);
  });
  const observedClose = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected close event timed out')), timeout);
    closed.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  const [trigger, closure, termination] = await Promise.allSettled([
    Promise.resolve().then(action),
    observedClose,
    exited,
  ]);
  if (
    trigger.status === 'rejected' &&
    !String(trigger.reason?.message).includes('Target page, context or browser has been closed')
  )
    throw trigger.reason;
  if (closure.status === 'rejected') throw closure.reason;
  if (termination.status === 'rejected') throw termination.reason;
  const { code, signal } = termination.value;
  if (code !== 0 || signal !== null)
    throw new Error(`Application did not exit cleanly (code=${code}, signal=${signal})`);
  return { code, signal, actionAcknowledged: trigger.status === 'fulfilled' };
}
