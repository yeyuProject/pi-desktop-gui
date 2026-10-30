import { _electron as electron } from 'playwright';
import path from 'node:path';
import { terminateProcessTree } from '../../electron/platform.ts';
import { desktopTestEnv } from './desktop-env.ts';

export const DESKTOP_TIMEOUTS = Object.freeze({ launch: 60000, action: 30000, pi: 60000, close: 15000 });
const processes = new WeakMap();

/** Launch only: fixtures/providers and business readiness remain owned by each test. */
export async function launchApp({
  dataDir,
  executablePath,
  args = executablePath ? [] : [path.resolve('.')],
  env = {},
  errors = [],
  pageTimeout = DESKTOP_TIMEOUTS.action,
  ...options
} = {}) {
  const app = await electron.launch({
    timeout: DESKTOP_TIMEOUTS.launch,
    ...options,
    executablePath,
    args,
    env: desktopTestEnv({ PI_OFFLINE: '1', ...(dataDir ? { PI_DESKTOP_DATA_DIR: dataDir } : {}), ...env }),
  });
  // Playwright releases its dispatcher after a crash/exit; app.process() then throws.
  // Keep the owned child while the application is still connected.
  processes.set(app, app.process());
  try {
    const page = await app.firstWindow({ timeout: DESKTOP_TIMEOUTS.launch });
    page.setDefaultTimeout(pageTimeout);
    page.on('pageerror', (error) => errors.push(error.message));
    return { app, page, errors };
  } catch (error) {
    try {
      await closeApp(app);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Electron startup and cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

/** Failure/finally cleanup. Tests of normal quit must still call app.close() themselves. */
export async function closeApp(app) {
  if (!app) return;
  const child = processes.get(app);
  if (!child) throw new Error('closeApp requires an application created by launchApp');
  if (child.exitCode !== null || child.signalCode) return;
  let timer;
  try {
    await Promise.race([
      (async () => {
        for (const page of app.windows()) {
          await page
            .evaluate(() => {
              window.desktop?.onEvent?.((event) => {
                if (event.type === 'appDialog')
                  void window.desktop.invoke(
                    'respondAppDialog',
                    event.dialog.id,
                    event.dialog.message === 'Pi 仍在执行任务' ? 1 : event.dialog.cancelId,
                  );
              });
            })
            .catch(() => {});
        }
        await app.close();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Electron test cleanup timed out')),
          DESKTOP_TIMEOUTS.close,
        );
      }),
    ]);
  } catch (error) {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      try {
        await terminateProcessTree(child.pid);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Electron close and process cleanup failed', {
          cause: cleanupError,
        });
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
