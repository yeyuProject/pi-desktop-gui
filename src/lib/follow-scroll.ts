/**
 * Auto-follow for streaming output.
 *
 * Within `FOLLOW_SLACK` px of the bottom the view keeps following, so layout jitter and
 * sub-pixel rounding never drop it. A deliberate upward wheel or key press shrinks the
 * slack to `RELEASED_SLACK`: otherwise a small trackpad nudge stays inside 24 px and the
 * next chunk pulls the reader straight back. Scrolling down restores the normal slack.
 */
export const FOLLOW_SLACK = 24;
export const RELEASED_SLACK = 2;

const upKeys = new Set(['ArrowUp', 'PageUp', 'Home']);
const downKeys = new Set(['ArrowDown', 'PageDown', 'End']);

export type ScrollIntent = 'up' | 'down' | undefined;

export function wheelIntent(event: { deltaY: number }): ScrollIntent {
  return event.deltaY < 0 ? 'up' : event.deltaY > 0 ? 'down' : undefined;
}

/** Alt+arrows navigate turns and do not scroll, so they carry no intent. */
export function keyIntent(event: { key: string; shiftKey: boolean; altKey: boolean }): ScrollIntent {
  if (event.altKey) return undefined;
  if (event.key === ' ') return event.shiftKey ? 'up' : 'down';
  return upKeys.has(event.key) ? 'up' : downKeys.has(event.key) ? 'down' : undefined;
}

/** `released` tracks the last intent; undefined intents leave it unchanged. */
export function nextReleased(released: boolean, intent: ScrollIntent): boolean {
  return intent === undefined ? released : intent === 'up';
}

export function isFollowing(
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  released: boolean,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <
    (released ? RELEASED_SLACK : FOLLOW_SLACK)
  );
}
