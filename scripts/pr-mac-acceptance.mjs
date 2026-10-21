import fs from 'node:fs/promises';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';
import verifyMacPackages from './verify-mac-package.mjs';

// electron-builder skips all signing on PRs, including the repository's explicit
// ad-hoc identity. Repair only directory acceptance builds, after all bundle edits.
// Installer/release builds retain the ordinary signing and verification hooks.
export function createPrMacAcceptanceHook(
  { directoryOnly, hostPlatform, event },
  { sign = signAsync, verify = verifyMacPackages } = {},
) {
  if (!directoryOnly || hostPlatform !== 'darwin' || event !== 'pull_request') return undefined;
  return async (result) => {
    if (
      result.configuration.mac?.identity !== '-' ||
      result.configuration.mac?.hardenedRuntime !== false ||
      result.artifactPaths.length !== 0 ||
      [...result.platformToTargets.keys()].some((platform) => platform.nodeName !== 'darwin')
    )
      throw new Error('PR acceptance signing requires an ad-hoc macOS directory build');
    let signed = 0;
    for (const directory of await fs.readdir(result.outDir, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^mac(?:-(?:arm64|universal))?$/.test(directory.name)) continue;
      const output = path.join(result.outDir, directory.name);
      for (const entry of await fs.readdir(output, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
        await sign({
          app: path.join(output, entry.name),
          platform: 'darwin',
          identity: '-',
          // '-' is not a certificate: never discover identities or provisioning profiles.
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
          strictVerify: true,
        });
        signed++;
      }
    }
    if (!signed) throw new Error('PR acceptance build produced no macOS application');
    return verify(result);
  };
}
