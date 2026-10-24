import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('Netlify v2 bundles workspace runtime code without importing TypeScript packages from node_modules', async () => {
  // Netlify v2's transformer bundles relative files but keeps package imports
  // external. A plain esbuild bundle (without packages: external) masks this
  // production cold-start failure for our TypeScript-only workspace package.
  for (const name of ['api', 'auth', 'cleanup', 'identity', 'reminders','reminder-delivery','reminder-tick','reminder-email','material-file','material-schedule','material-collect-background']) {
    const compiled = await build({
      entryPoints: [fileURLToPath(new URL(`../../../netlify/functions/${name}.mts`, import.meta.url))],
      bundle: true, packages: 'external', platform: 'node', format: 'esm',
      target: 'node22', write: false, metafile: true,
    });
    const unresolvedWorkspaces = Object.values(compiled.metafile!.outputs)
      .flatMap(output => output.imports)
      .filter(entry => entry.external && entry.path.startsWith('@campus/'));
    assert.deepEqual(unresolvedWorkspaces, [], `${name} must include workspace runtime code`);
    if (name === 'api') {
      assert.ok(Object.keys(compiled.metafile!.inputs).some(path => path.replace(/\\/g, '/').endsWith('packages/contracts/src/index.ts')));
    }
  }
});
