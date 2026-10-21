import fs from 'node:fs/promises';
import { runMacInstaller, type MacUpdatePlan } from './mac-update';

(async () => {
  try {
    const plan = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as MacUpdatePlan;
    await runMacInstaller(plan, Number(process.argv[3]), process.argv[4] === 'restart');
  } catch (error) {
    if (process.connected) process.send?.({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect?.();
  }
})();
