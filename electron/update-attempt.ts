import fs from 'node:fs/promises';
import path from 'node:path';
import { compareAppVersions, stableVersion, type UpdateInstallAttempt } from '../shared/app-update';

const RETENTION = 7 * 24 * 60 * 60 * 1000;

/** One bounded receipt, without paths or error details. A launched installer is not proof of installation. */
export class UpdateAttemptFile {
  readonly file: string;
  private writes = Promise.resolve();
  constructor(directory: string) {
    this.file = path.join(directory, 'update-install.json');
  }
  async read(currentVersion: string, now = Date.now()): Promise<UpdateInstallAttempt | undefined> {
    try {
      if ((await fs.stat(this.file)).size > 4096) return undefined;
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const current = stableVersion(value.currentVersion),
        target = stableVersion(value.targetVersion);
      if (!current || !target || compareAppVersions(target, current) <= 0) return undefined;
      if (!Number.isSafeInteger(value.startedAt) || value.startedAt > now + 60000) return undefined;
      if (!['pending', 'failed'].includes(value.outcome)) return undefined;
      if (now - value.startedAt > RETENTION) {
        await fs.rm(this.file, { force: true });
        return undefined;
      }
      const completed = compareAppVersions(currentVersion, target) >= 0;
      if (completed) await fs.rm(this.file, { force: true });
      return {
        currentVersion: current,
        targetVersion: target,
        startedAt: value.startedAt,
        // The old app may have been opened while installation is still running, or after cancellation.
        outcome: completed ? 'completed' : value.outcome === 'failed' ? 'failed' : 'unconfirmed',
      };
    } catch {
      // A missing, unreadable or corrupt receipt must never prevent starting the app.
      return undefined;
    }
  }
  record(attempt: UpdateInstallAttempt) {
    const contents = JSON.stringify({
      currentVersion: attempt.currentVersion,
      targetVersion: attempt.targetVersion,
      startedAt: attempt.startedAt,
      outcome: attempt.outcome,
    });
    const writing = this.writes
      .catch(() => {})
      .then(async () => {
        const temporary = this.file + '.tmp';
        try {
          await fs.writeFile(temporary, contents, { mode: 0o600 });
          await fs.rename(temporary, this.file);
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
      });
    this.writes = writing;
    return writing;
  }
}
