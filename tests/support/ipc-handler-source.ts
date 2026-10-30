import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

// Fault-injection tests execute the actual handlers without loading Electron.
// Locate each handler once, regardless of which IPC module owns it.
const handlers = new Map<string, { source: ts.SourceFile; property: ts.PropertyAssignment }>();
const api = new API();
try {
  const config = path.resolve('tsconfig.json');
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)?.program;
    const files = [
      'electron/main.ts',
      ...readdirSync('electron/ipc')
        .filter((name) => name.endsWith('-handlers.ts'))
        .map((name) => 'electron/ipc/' + name),
    ];
    for (const file of files) {
      const source = program?.getSourceFile(path.resolve(file));
      assert.ok(source, file);
      const visit = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(source) === 'handlers' &&
          node.initializer &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          for (const property of node.initializer.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = property.name.getText(source);
            assert.ok(!handlers.has(name), `Duplicate production handler: ${name}`);
            handlers.set(name, { source, property });
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  } finally {
    snapshot.dispose();
  }
} finally {
  api.close();
}

export function handlerSource(name: string, initializerOnly = false) {
  const found = handlers.get(name);
  assert.ok(found, `Expected current ${name} handler`);
  return (initializerOnly ? found.property.initializer : found.property).getText(found.source);
}
