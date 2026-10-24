import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { updateSigningPayload, verifyUpdateSignature, UPDATE_MANIFESTS } from '../shared/update-signature';
import { UPDATE_PUBLIC_KEY } from '../shared/update-trust';
// @ts-expect-error release verification is shared with the JavaScript packaging tools.
import { verifyUpdateMetadata } from './verify-update-metadata.mjs';

const [directory, version, privateFile] = process.argv.slice(2);
if (!directory || !version || !privateFile)
  throw new Error(
    'Usage: node --import tsx scripts/sign-updates.ts RELEASE_DIRECTORY VERSION PRIVATE_KEY_PATH',
  );
if (path.resolve(privateFile).startsWith(path.resolve('.') + path.sep))
  throw new Error('Keep the release private key outside the repository and CI');
await verifyUpdateMetadata(directory, version.replace(/^v/, ''), [...UPDATE_MANIFESTS]);
const key = createPrivateKey(await fs.readFile(privateFile));
if (
  key.asymmetricKeyType !== 'ed25519' ||
  createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== UPDATE_PUBLIC_KEY
)
  throw new Error('The private key does not match the public key embedded in the application');
for (const name of UPDATE_MANIFESTS) {
  const raw = await fs.readFile(path.join(directory, name));
  const signature = sign(null, updateSigningPayload(name, raw), key).toString('base64');
  verifyUpdateSignature(name, raw, signature);
  await fs.writeFile(path.join(directory, name + '.sig'), signature + '\n', { flag: 'wx', mode: 0o644 });
}
console.log(
  'Verified artifact hashes and signed all three update manifests. Review the release before uploading signatures and publishing.',
);
