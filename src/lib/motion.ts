/** CSS `scroll-behavior` does not cover script scrolls that ask for `smooth` explicitly. */
export function smoothBehavior(): ScrollBehavior {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}
