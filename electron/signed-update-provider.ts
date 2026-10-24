import {
  Provider,
  parseUpdateInfo,
  resolveFiles,
  type ProviderRuntimeOptions,
} from 'electron-updater/out/providers/Provider';
import type { AppUpdater } from 'electron-updater';
import type { UpdateInfo, CustomPublishOptions } from 'builder-util-runtime';
import { stableVersion } from '../shared/app-update';
import { verifyUpdateSignature, UpdateSignatureError } from '../shared/update-signature';
import { updateFeed, DEFAULT_UPDATE_FEED } from './update-network';
import { UPDATE_PUBLIC_KEY } from '../shared/update-trust';

export async function boundedUpdateResponse(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error(`更新服务器返回 HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('更新清单过大');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export async function readSignedUpdate(
  base: string,
  platform: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  publicKey = UPDATE_PUBLIC_KEY,
) {
  const name =
    platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';
  const url = new URL(name, updateFeed(base));
  const [raw, signature] = await Promise.all([
    fetcher(url.href, { cache: 'no-store', signal: AbortSignal.timeout(20000) }).then((r) =>
      boundedUpdateResponse(r, 1024 * 1024),
    ),
    fetcher(url.href + '.sig', { cache: 'no-store', signal: AbortSignal.timeout(20000) })
      .then((r) => boundedUpdateResponse(r, 256))
      .catch(() => {
        throw new UpdateSignatureError('更新缺少发布者签名，已停止下载和安装。请等待签名完成后再检查更新。');
      }),
  ]);
  verifyUpdateSignature(name, raw, signature.toString('utf8'), publicKey);
  const info = parseUpdateInfo(raw.toString('utf8'), name, url);
  if (
    !stableVersion(info.version) ||
    !Array.isArray(info.files) ||
    !info.files.length ||
    info.files.length > 20
  )
    throw new Error('更新清单无效');
  for (const file of info.files) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.url) ||
      file.url.includes('..') ||
      !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
      !Number.isSafeInteger(file.size) ||
      file.size! <= 0
    )
      throw new Error('更新清单中的文件名、大小或校验值无效');
  }
  // Do not accept an unsigned/alternate web-installer payload or deprecated hash fields.
  if ('packages' in info) throw new Error('不支持附带额外安装包的更新清单');
  return info;
}
export class SignedUpdateProvider extends Provider<UpdateInfo> {
  private base: string;
  constructor(
    options: CustomPublishOptions & { url?: string },
    private updater: AppUpdater,
    private runtime: ProviderRuntimeOptions,
  ) {
    super(runtime);
    this.base = updateFeed(options.url);
  }
  getLatestVersion() {
    return readSignedUpdate(
      this.base,
      this.runtime.platform,
      this.updater.netSession.fetch.bind(this.updater.netSession),
    );
  }
  resolveFiles(info: UpdateInfo) {
    // Keep a verified download on its release even if GitHub's latest tag changes meanwhile.
    const base =
      this.base === DEFAULT_UPDATE_FEED
        ? this.base.replace('/latest/download/', `/download/v${stableVersion(info.version)}/`)
        : this.base;
    return resolveFiles(info, new URL(base));
  }
}
