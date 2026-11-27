import type { Theme } from './window-theme';

export type Material = 'solid' | 'glass';

export interface MaterialEnvironment {
  gpuCompositing: boolean;
  onBattery: boolean;
}

export function isMaterial(value: unknown): value is Material {
  return value === 'solid' || value === 'glass';
}

export function supportsGlassTheme(theme: Theme): boolean {
  return theme === 'light' || theme === 'dark' || theme === 'system';
}
