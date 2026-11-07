import type { Message } from '../../shared/types';

/** Keep a dispatch visible at its original position even if Pi exited before its
 * result was written. This is a renderer-only placeholder, never session data. */
export function restoreTeamCalls(messages: Message[]): Message[] {
  const results = new Set(messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId));
  const restored: Message[] = [];
  let changed = false;
  for (const message of messages) {
    restored.push(message);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (
        call.type !== 'toolCall' ||
        call.name !== 'desktop_team_dispatch' ||
        !call.id ||
        results.has(call.id)
      )
        continue;
      changed = true;
      results.add(call.id);
      restored.push({
        role: 'toolResult',
        toolName: call.name,
        toolCallId: call.id,
        content: [],
        timestamp: message.timestamp,
      });
    }
  }
  return changed ? restored : messages;
}
