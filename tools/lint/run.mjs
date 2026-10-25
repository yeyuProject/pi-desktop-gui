import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd, fix: process.argv.includes('--fix') });
const results = await eslint.lintFiles([
  'electron',
  'shared',
  'src',
  'tests',
  'scripts',
  'tools/lint',
  'vite.config.ts',
  'eslint.config.mjs',
]);
if (process.argv.includes('--fix')) await ESLint.outputFixes(results);
const formatter = await eslint.loadFormatter('stylish');
const output = formatter.format(results);
if (output) console.log(output);
if (results.some((result) => result.errorCount || result.warningCount)) process.exitCode = 1;
