import type { Runtime } from '../shared/types';

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Estimate only received output; provider usage and the settled session remain authoritative. */
export class LiveUsage {
  private cjkCharacters = 0;
  private otherCharacters = 0;
  private reportedInput?: number;
  private reportedOutput = 0;

  update(event?: { type?: string; delta?: unknown }, usage?: unknown): NonNullable<Runtime['liveUsage']> {
    if (
      event &&
      ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.type ?? '') &&
      typeof event.delta === 'string'
    ) {
      for (const character of event.delta) {
        if (cjk.test(character)) this.cjkCharacters++;
        else this.otherCharacters++;
      }
    }
    if (usage && typeof usage === 'object') {
      const value = usage as Record<string, unknown>;
      if ([value.input, value.cacheRead, value.cacheWrite].every(amount)) {
        const input = (value.input as number) + (value.cacheRead as number) + (value.cacheWrite as number);
        // Pi initializes usage to zero, which does not mean the provider has reported it yet.
        if (input > 0 && Number.isFinite(input)) this.reportedInput = input;
      }
      if (amount(value.output) && value.output > 0)
        this.reportedOutput = Math.max(this.reportedOutput, value.output);
    }
    return {
      outputTokens: Math.max(this.reportedOutput, this.cjkCharacters + Math.ceil(this.otherCharacters / 4)),
      ...(this.reportedInput === undefined ? {} : { inputTokens: this.reportedInput }),
    };
  }
}
