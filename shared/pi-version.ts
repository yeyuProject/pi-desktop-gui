// The regression baseline is informational, not a runtime version restriction.
export const VERIFIED = '1.4.0';
export const PI_INSTALL_COMMAND = 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent';
export const PI_SOURCE_URL = `https://github.com/earendil-works/pi/blob/v${VERIFIED}/packages/coding-agent`;
export type PiCompatibility = 'verified' | 'unverified' | 'unknown';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;

export function classifyPiVersion(version: string | undefined): PiCompatibility {
  const parsed = version && versionPattern.exec(version);
  if (!parsed || !parsed.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)))) return 'unknown';
  return version === VERIFIED ? 'verified' : 'unverified';
}

export const compatibilityLabels: Record<PiCompatibility, string> = {
  verified: '已验证',
  unverified: '未验证',
  unknown: '未知',
};
export function compatibilityMessage(
  version: string | undefined,
  compatibility = classifyPiVersion(version),
) {
  if (compatibility === 'verified') return '';
  if (compatibility === 'unverified')
    return `Pi ${version}${version?.includes('-') ? '（预发布版）' : ''} 尚未完成桌面端回归验证，可以继续使用；如遇问题请在诊断中附上版本号。已验证版本为 ${VERIFIED}。`;
  return '未检测到可识别的 Pi 版本，请检查入口或重新安装 Pi。';
}
