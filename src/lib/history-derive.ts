import { messageArrayChanges, type Message } from '../../shared/types';
import { isGoalStartMessage } from '../../shared/goal-input';
import { hidePlanTools } from './plan-transcript';
import { restoreTeamCalls } from './team-transcript';
import { hideRecoveredErrors } from './conversation-layout';
export function deriveHistory(messages: Message[], start = 0) {
  return restoreTeamCalls(
    hideRecoveredErrors(
      hidePlanTools(
        messages
          .slice(start)
          .map((message, offset) =>
            isGoalStartMessage(messages, start + offset) ? { ...message, goalStart: true } : message,
          )
          .filter((message) => message.role !== 'custom' || message.display !== false),
      ),
    ),
  );
}
/** Reuse only complete user turns; later recovery can still change the current turn. */
export class HistoryDeriver {
  private source: Message[] = [];
  private boundary = 0;
  private prefix: Message[] = [];
  private result: Message[] = [];
  derive(messages: Message[]) {
    if (messages === this.source) return this.result;
    const change = messageArrayChanges.get(messages);
    const common =
      messages.length >= this.source.length &&
      (change?.previous.deref() === this.source
        ? change.from >= this.boundary
        : this.source.slice(0, -1).every((message, index) => message === messages[index]));
    let boundary = this.boundary;
    if (!common) boundary = 0;
    for (
      let index = common ? Math.max(this.boundary, this.source.length - 1) : 0;
      index < messages.length;
      index++
    )
      if (messages[index].role === 'user') boundary = index;
    if (!common || boundary !== this.boundary) this.prefix = deriveHistory(messages.slice(0, boundary));
    const tailOnly =
      change?.previous.deref() === this.source &&
      change.from >= this.source.length - 1 &&
      messages.length === this.source.length &&
      messages.at(-1)?.stopReason === this.source.at(-1)?.stopReason &&
      messages.at(-1)?.role === this.source.at(-1)?.role;
    this.source = messages;
    this.boundary = boundary;
    const result = this.prefix.concat(deriveHistory(messages, boundary));
    messageArrayChanges.set(result, {
      previous: new WeakRef(this.result),
      from:
        tailOnly && result.length === this.result.length
          ? Math.max(0, result.length - 1)
          : common
            ? this.prefix.length
            : 0,
    });
    this.result = result;
    return result;
  }
}
