export const THEMES = ['light', 'dark', 'system', 'sepia', 'green', 'navy'] as const;
export type Theme = (typeof THEMES)[number];

/** Background themes reuse the light or dark native appearance for menus, dialogs and scrollbars. */
export function nativeThemeSource(theme: Theme): 'light' | 'dark' | 'system' {
  if (theme === 'sepia' || theme === 'green') return 'light';
  if (theme === 'navy') return 'dark';
  return theme;
}

/** These colors match --bg, --rail and --ink in src/styles/base.css and src/styles/themes.css. */
const palettes = {
  light: { background: '#ffffff', color: '#f5f7f6', symbolColor: '#18221f' },
  dark: { background: '#121816', color: '#141b18', symbolColor: '#e4ebe8' },
  sepia: { background: '#f7f1e3', color: '#efe6d2', symbolColor: '#3a3125' },
  green: { background: '#dcebdc', color: '#cfe2d0', symbolColor: '#1c2b20' },
  navy: { background: '#0f1828', color: '#0c1422', symbolColor: '#e2e9f3' },
};

export function windowTheme(dark: boolean, theme: Theme = 'system') {
  const palette =
    theme === 'sepia' || theme === 'green' || theme === 'navy'
      ? palettes[theme]
      : palettes[dark ? 'dark' : 'light'];
  return { ...palette, height: 36 };
}
