import electronUpdater from 'electron-updater';
import type { AppUpdater } from 'electron-updater';
import path from 'node:path';
import type { DesktopRelease, UpdateDriver, UpdateDriverEvent } from './updater';
import { MacArchiveUpdater } from './mac-update-driver';

function release(info: {
  version: string;
  releaseNotes?: string | { version: string; note: string | null }[] | null;
}): DesktopRelease {
  const notes =
    typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : (info.releaseNotes ?? []).map((item) => `## ${item.version}\n${item.note ?? ''}`).join('\n\n');
  return { version: info.version, notes: notes.slice(0, 200000) };
}

/** Keep electron-updater's event and return shapes at this single boundary. */
export function nativeUpdateDriver(updater: AppUpdater): UpdateDriver {
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.autoRunAppAfterInstall = true;
  const listeners = new Set<(event: UpdateDriverEvent) => void>();
  const emit = (event: UpdateDriverEvent) => {
    for (const listener of listeners) listener(event);
  };
  updater.on('error', (error) => emit({ type: 'error', error }));
  updater.on('update-available', (info) => emit({ type: 'available', release: release(info) }));
  updater.on('update-not-available', () => emit({ type: 'not-available' }));
  updater.on('download-progress', (progress) => emit({ type: 'progress', percent: progress.percent }));
  updater.on('update-downloaded', (info) => emit({ type: 'downloaded', release: release(info) }));
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure(autoDownload, installOnQuit) {
      updater.autoDownload = autoDownload;
      updater.autoInstallOnAppQuit = installOnQuit;
    },
    async check() {
      const result = await updater.checkForUpdates();
      // The package emits an error event as well. Consume its separate download rejection.
      void result?.downloadPromise?.catch(() => {});
    },
    async download() {
      await updater.downloadUpdate();
    },
    install() {
      // An explicit restart should show installer progress and actionable native errors.
      // The updater's separate normal-quit handler still installs silently.
      updater.quitAndInstall(false, true);
    },
  };
}
export function createNativeUpdateDriver(installation: 'nsis' | 'appimage' | 'mac'): UpdateDriver {
  if (installation === 'mac') {
    const updater = new MacArchiveUpdater();
    return {
      ...nativeUpdateDriver(updater),
      install: () => updater.installDownloaded(),
      prepareForQuit: () => updater.prepareForQuit(),
    };
  }
  const { NsisUpdater, AppImageUpdater } = electronUpdater;
  if (installation === 'nsis') {
    const updater = new NsisUpdater();
    // The registered installation can belong to a different copy of this app.
    updater.installDirectory = path.dirname(process.execPath);
    return nativeUpdateDriver(updater);
  }
  return nativeUpdateDriver(new AppImageUpdater());
}
