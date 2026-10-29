import type { Message } from '../../shared/types';

/** Keep the source transcript intact for Pi; project internal plan calls out of the UI. */
export function hidePlanTools(messages: Message[]): Message[] {
  const calls = new Set<string>();
  for (const message of messages)
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (block.type === 'toolCall' && block.name === 'desktop_plan' && block.id) calls.add(block.id);
  return messages.flatMap((message) => {
    if (
      message.role === 'toolResult' &&
      (message.toolName === 'desktop_plan' || calls.has(message.toolCallId ?? ''))
    )
      return [];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
    const content = message.content.filter(
      (block) => block.type !== 'toolCall' || block.name !== 'desktop_plan',
    );
    if (content.length === message.content.length) return [message];
    return content.length || message.errorMessage ? [{ ...message, content }] : [];
  });
}
