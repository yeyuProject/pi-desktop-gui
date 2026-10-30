import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import desktopBridge from '../../electron/pi-bridge';

/** Bridge switches are captured synchronously when its hooks are registered. */
export function installDesktopBridge(
  pi: ExtensionAPI,
  overrides: Partial<Record<`PI_DESKTOP_${string}`, string>> = {},
) {
  const inherited = Object.entries(process.env).filter(([key]) =>
    key.toUpperCase().startsWith('PI_DESKTOP_'),
  );
  for (const [key] of inherited) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    desktopBridge(pi);
  } finally {
    for (const key of Object.keys(overrides)) delete process.env[key];
    for (const [key, value] of inherited) process.env[key] = value;
  }
}
