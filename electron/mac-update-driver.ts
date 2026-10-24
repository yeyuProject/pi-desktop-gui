import electronUpdater from 'electron-updater';
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater';
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import path from 'node:path';
import { MacUpdateError, stageMacUpdate, startMacInstaller, type MacUpdatePlan } from './mac-update';

/** Signed release metadata supplies the hash; macOS additionally validates each staged bundle. */
export class MacArchiveUpdater extends electronUpdater.AppUpdater {
  declare protected httpExecutor: ElectronHttpExecutor;
  private plan?: MacUpdatePlan;
  private installing?: Promise<void>;
  constructor() {
    super(null);
  }

  protected async doDownloadUpdate(options: DownloadUpdateOptions) {
    const { info, provider } = options.updateInfoAndProvider;
    const file = provider
      .resolveFiles(info)
      .find((file) => file.url.pathname.endsWith(`-mac-${process.arch}.zip`));
    if (!file || !file.info.sha512 || Buffer.from(file.info.sha512, 'base64').length !== 64)
      throw new MacUpdateError('更新包缺少当前 Mac 架构的 ZIP 或 SHA-512 校验值。');
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: file,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        await this.httpExecutor!.download(file.url, destination, downloadOptions);
      },
      done: async (event) => {
        this.plan = await stageMacUpdate({
          archive: event.downloadedFile,
          target: path.resolve(process.resourcesPath, '../..'),
          currentVersion: this.currentVersion.version,
          targetVersion: info.version,
          arch: process.arch,
          helperDirectory: __dirname,
          receiptDirectory: this.app.userDataPath,
        });
        this.dispatchUpdateDownloaded(event);
      },
    });
  }
  async prepareForQuit() {
    if (this.autoInstallOnAppQuit && this.plan) await this.launchInstaller(false);
  }
  private launchInstaller(relaunch: boolean) {
    if (!this.plan) return Promise.reject(new Error('更新尚未下载完成'));
    this.installing ??= startMacInstaller(
      this.plan,
      relaunch,
      () => relaunch || this.autoInstallOnAppQuit,
    ).catch((error) => {
      this.installing = undefined;
      throw error;
    });
    return this.installing;
  }
  async installDownloaded() {
    await this.launchInstaller(true);
    this.app.quit();
  }
  quitAndInstall() {
    void this.installDownloaded().catch((error) => this.dispatchError(error));
  }
}
