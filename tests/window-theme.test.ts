import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES,
  UI_STYLES,
  STYLE_META,
  stylePalettes,
  styleTheme,
  nativeThemeSource,
  windowTheme,
} from '../shared/window-theme';

test('every style has metadata and basic-only styles have matching native palettes', () => {
  assert.deepEqual(Object.keys(STYLE_META), [...UI_STYLES]);
  assert.equal(new Set(UI_STYLES.map((style) => STYLE_META[style].label)).size, UI_STYLES.length);
  for (const style of UI_STYLES) {
    assert.ok(STYLE_META[style].label.trim());
    assert.equal(STYLE_META[style].basicThemesOnly, Boolean(stylePalettes[style]), style);
    for (const theme of THEMES) {
      const normalized = styleTheme(theme, style);
      assert.equal(normalized, STYLE_META[style].basicThemesOnly ? nativeThemeSource(theme) : theme);
      assert.equal(styleTheme(normalized, style), normalized);
      for (const dark of [false, true]) {
        assert.deepEqual(windowTheme(dark, theme, style), windowTheme(dark, normalized, style));
      }
    }
  }
});
