import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';

const radiusProperty = /^border(?:-[a-z]+)*-radius$/i;
const radiusVar = String.raw`var\(\s*--radius-[\w-]+\s*\)`;
const radiusValue = String.raw`(?:0|50%|${radiusVar}|calc\(\s*${radiusVar}\s+-\s+\d+px\s*\))`;
const radiusList = String.raw`${radiusValue}(?:\s+${radiusValue}){0,3}`;
const allowed = new RegExp(String.raw`^(?:inherit|${radiusList}(?:\s*/\s*${radiusList})?)$`);

export function lintCssRadius(source, file) {
  const violations = [];
  postcss.parse(source, { from: file }).walkDecls(radiusProperty, (declaration) => {
    if (!allowed.test(declaration.value.trim())) {
      violations.push(
        `${file}:${declaration.source.start.line}: use a --radius-* variable for ${declaration.prop}: ${declaration.value}`,
      );
    }
  });
  return violations;
}

export async function lintStyles(cwd) {
  const dir = path.join(cwd, 'src', 'styles');
  const entries = await readdir(dir, { recursive: true });
  const violations = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.css'))
      .sort()
      .map(async (entry) => {
        const file = path.join(dir, entry);
        return lintCssRadius(await readFile(file, 'utf8'), path.relative(cwd, file));
      }),
  );
  return violations.flat();
}
