export const THEMES = ['light', 'dark', 'system', 'sepia', 'green', 'navy'] as const;
export type Theme = (typeof THEMES)[number];
export const UI_STYLES = ['classic', 'codex'] as const;
export type UiStyle = (typeof UI_STYLES)[number];

export const STYLE_META: Record<
  UiStyle,
  { label: string; basicThemesOnly: boolean; themeLabels?: Partial<Record<Theme, string>> }
> = {
  classic: { label: 'Pi 经典', basicThemesOnly: false },
  codex: {
    label: 'Codex',
    basicThemesOnly: true,
    themeLabels: { light: '白天', dark: '夜晚' },
  },
};

/** Background themes reuse the light or dark native appearance for menus, dialogs and scrollbars. */
export function nativeThemeSource(theme: Theme): 'light' | 'dark' | 'system' {
  if (theme === 'sepia' || theme === 'green') return 'light';
  if (theme === 'navy') return 'dark';
  return theme;
}

export function styleTheme(theme: Theme, style: UiStyle): Theme {
  return STYLE_META[style].basicThemesOnly ? nativeThemeSource(theme) : theme;
}

/** These colors match --bg, --rail and --ink in src/styles/base.css and src/styles/themes.css. */
const palettes = {
  light: { background: '#ffffff', color: '#f5f7f6', symbolColor: '#18221f' },
  dark: { background: '#121816', color: '#141b18', symbolColor: '#e4ebe8' },
  sepia: { background: '#f7f1e3', color: '#efe6d2', symbolColor: '#3a3125' },
  green: { background: '#dcebdc', color: '#cfe2d0', symbolColor: '#1c2b20' },
  navy: { background: '#0f1828', color: '#0c1422', symbolColor: '#e2e9f3' },
};

type Palette = { background: string; color: string; symbolColor: string };
export const stylePalettes: Partial<Record<UiStyle, { light: Palette; dark: Palette }>> = {
  codex: {
    light: { background: '#ffffff', color: '#f9f9f9', symbolColor: '#0d0d0d' },
    dark: { background: '#181818', color: '#131313', symbolColor: '#dddddd' },
  },
};

export function windowTheme(dark: boolean, theme: Theme = 'system', style: UiStyle = 'classic') {
  const palette =
    stylePalettes[style]?.[dark ? 'dark' : 'light'] ??
    (theme === 'sepia' || theme === 'green' || theme === 'navy'
      ? palettes[theme]
      : palettes[dark ? 'dark' : 'light']);
  return { ...palette, height: 36 };
}
