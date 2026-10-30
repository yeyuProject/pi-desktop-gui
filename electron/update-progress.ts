import type { UpdateDownload } from '../shared/app-update';

type Sample = { time: number; bytes: number };
const WINDOW_MS = 5000;
const STALL_MS = 10000;
const REPORT_MS = 1000;

/** Measures received bytes, independently of electron-updater's lifetime average. */
export class UpdateProgress {
  private samples: Sample[] = [];
  private startedAt: number;
  private lastAdvancedAt: number;
  private metricsAt = -Infinity;
  private value: UpdateDownload = {
    transferred: 0,
    total: 0,
    differential: false,
    stalled: false,
    phase: 'connecting',
  };

  constructor(
    private readonly size: number | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = this.lastAdvancedAt = now();
    this.samples.push({ time: this.startedAt, bytes: 0 });
  }

  progress(transferred: number, total: number) {
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(transferred) || transferred < 0)
      return false;
    transferred = Math.min(transferred, total);
    const now = this.now();
    const restarted =
      this.value.total > 0 && (total !== this.value.total || transferred < this.value.transferred);
    if (restarted) {
      this.startedAt = this.lastAdvancedAt = now;
      this.samples = [{ time: now, bytes: 0 }];
      this.metricsAt = -Infinity;
      this.value = { transferred: 0, total: 0, differential: false, stalled: false, phase: 'connecting' };
    }
    if (transferred > this.value.transferred) {
      if (now - this.lastAdvancedAt >= STALL_MS) {
        // Do not count the pause as slow transfer or restart the initial three-second warm-up.
        this.samples = [{ time: now, bytes: transferred }];
        this.metricsAt = -Infinity;
      }
      this.lastAdvancedAt = now;
    }
    this.value = {
      ...this.value,
      transferred,
      total,
      differential: this.size !== undefined && this.size - total > this.size * 0.01,
      phase: transferred === total ? 'verifying' : 'transferring',
      stalled: false,
    };
    this.sample(now);
    return true;
  }

  private sample(now: number) {
    const sample = { time: now, bytes: this.value.transferred };
    if (this.samples.at(-1)?.time === now) this.samples[this.samples.length - 1] = sample;
    else this.samples.push(sample);
  }

  read(): UpdateDownload {
    const now = this.now();
    const stalled = this.value.phase !== 'verifying' && now - this.lastAdvancedAt >= STALL_MS;
    if (this.value.phase !== 'transferring' || stalled) {
      this.value = { ...this.value, stalled, bytesPerSecond: undefined, remainingMs: undefined };
    } else if (now - this.metricsAt >= REPORT_MS) {
      // Byte reports arrive about once a second. A timer tick is not another byte observation.
      // Allow that reporting interval before treating a silent interval as reduced throughput.
      const end = Math.max(this.samples.at(-1)!.time, now - REPORT_MS);
      while (this.samples.length > 1 && this.samples[1].time <= end - WINDOW_MS) this.samples.shift();
      const first = this.samples[0],
        next = this.samples[1];
      const start = Math.max(first.time, end - WINDOW_MS);
      const initialBytes =
        next && first.time < start
          ? first.bytes + ((next.bytes - first.bytes) * (start - first.time)) / (next.time - first.time)
          : first.bytes;
      const bytes = this.value.transferred - initialBytes;
      const ready = now - this.startedAt >= 3000 && bytes >= 256 * 1024 && end > start;
      const speed = ready ? (bytes * 1000) / (end - start) : undefined;
      if (speed !== undefined || this.value.bytesPerSecond !== undefined) this.metricsAt = now;
      this.value = {
        ...this.value,
        stalled: false,
        bytesPerSecond: speed,
        remainingMs: speed ? ((this.value.total - this.value.transferred) / speed) * 1000 : undefined,
      };
    }
    return { ...this.value };
  }
}
