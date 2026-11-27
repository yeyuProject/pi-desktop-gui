import test from 'node:test';
import assert from 'node:assert/strict';
import { lintCssRadius } from '../tools/lint/css-radius.mjs';

test('allows radius tiers, inset calculations, circles, square corners and inheritance', () => {
  const css = `
    :root { --radius-xs: 6px; --radius-pill: 999px; }
    .bubble { border-radius: var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg); }
    .pill { border-radius: var(--radius-pill); }
    .item { border-radius: calc(var(--radius-popover) - 4px); }
    .avatar { border-radius: 50%; }
    .summary { border-radius: inherit; border-end-start-radius: 0; }
    .ellipse { border-radius: var(--radius-sm) / 50%; }
    .note { content: "border-radius: 2px"; margin: 4px; }
    /* .old { border-radius: 3px; } */
  `;
  assert.deepEqual(lintCssRadius(css, 'sample.css'), []);
});

test('reports literal radii, including mixed values, longhands and fallbacks', () => {
  const violations = lintCssRadius(
    [
      '.card { border-radius: 16px }',
      '.row { BORDER-RADIUS: 0 var(--radius-md) 2px !important }',
      '.tag { border-bottom-right-radius: 30% }',
      '.field { border-radius: var(--radius-sm, 8px) }',
      '.other { border-radius: calc(6px + 4px) }',
    ].join('\n'),
    'sample.css',
  );
  assert.deepEqual(
    violations.map((violation) => violation.split(':').slice(0, 2).join(':')),
    [1, 2, 3, 4, 5].map((line) => `sample.css:${line}`),
  );
});
