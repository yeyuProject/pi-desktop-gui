import type { BeforePackContext } from 'electron-builder';

export const macBuildOutput: string;
export function packagedExecutable(platform?: NodeJS.Platform, arch?: string): string;
export default function requireMacBuildIsolation(context: BeforePackContext): Promise<void>;
export function macTestApp(executable?: string, buildRoot?: string): Promise<string | undefined>;
export function unregisterMacTestApp(executable?: string, buildRoot?: string): Promise<void>;
