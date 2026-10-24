import fs from 'node:fs/promises';
import path from 'node:path';

const validId = (id: string) => {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('会话标识无效');
};
/** Only application-owned scratch files; imported histories and project directories are excluded. */
export async function removeSessionScratch(directory: string, id: string) {
  validId(id);
  for (const name of [`draft-${id}.txt`, `desktop-bridge-${id}.mjs`])
    await fs.rm(path.join(directory, name), { force: true });
}
export async function clearDesktopRecords(directory: string) {
  const entries = await fs.readdir(directory);
  for (const name of entries) {
    if (
      /^state(?:\.[\w.-]+)?\.json(?:\.tmp)?$/.test(name) ||
      /^(?:draft-|desktop-bridge-|export-)[\w.-]+$/.test(name) ||
      ['draft-images', 'baselines', 'sessions', 'chats', 'window.json', 'update-install.json'].includes(name)
    )
      await fs.rm(path.join(directory, name), { recursive: true, force: true });
  }
}
