import { createPublicKey, verify } from 'node:crypto';
import { UPDATE_PUBLIC_KEY } from './update-trust';

export class UpdateSignatureError extends Error {}
export const UPDATE_MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'] as const;
export function updateSigningPayload(name: string, bytes: Uint8Array) {
  if (!(UPDATE_MANIFESTS as readonly string[]).includes(name))
    throw new UpdateSignatureError('更新清单名称无效，已停止更新。');
  return Buffer.concat([Buffer.from(`Pi Desktop update v1\n${name}\n`), bytes]);
}
export function verifyUpdateSignature(
  name: string,
  bytes: Uint8Array,
  signature: string,
  key = UPDATE_PUBLIC_KEY,
) {
  const encoded = signature.trim();
  try {
    const publicKey = createPublicKey(key);
    if (
      bytes.byteLength > 1024 * 1024 ||
      !/^[A-Za-z0-9+/]{86}==$/.test(encoded) ||
      publicKey.asymmetricKeyType !== 'ed25519' ||
      !verify(null, updateSigningPayload(name, bytes), publicKey, Buffer.from(encoded, 'base64'))
    )
      throw new Error('Invalid signature');
  } catch {
    throw new UpdateSignatureError(
      '更新缺少有效的发布者签名，已停止下载和安装。请等待签名完成后再检查更新。',
    );
  }
}
