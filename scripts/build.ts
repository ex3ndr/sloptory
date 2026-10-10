// Builds the web interface into dist/web: one bundled script plus static files.

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'dist', 'web');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src/web/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  outfile: join(out, 'app.js'),
  logLevel: 'warning',
});

for (const f of ['index.html', 'style.css', 'favicon.svg']) copyFileSync(join(root, 'src/web', f), join(out, f));
console.log(`Built web app → ${out}`);
