// Empacota os módulos testados (rolldown, que já vem com o Vite) e roda cada teste.
// Uso: npm test   (cada teste encerra o processo com process.exit)
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', '.build');
mkdirSync(out, { recursive: true });
const bundles = { doc: 'src/core/doc.ts', spatial: 'src/core/spatial.ts', geom: 'src/core/geom.ts', ops: 'src/editor/ops.ts' };
for (const [name, src] of Object.entries(bundles)) {
  execFileSync(process.execPath, [join(root, 'node_modules', 'rolldown', 'bin', 'cli.mjs'), join(root, src), '--format', 'esm', '--file', join(out, `${name}.mjs`)], { stdio: 'pipe' });
}
let failed = 0;
for (const f of readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort()) {
  try {
    execFileSync(process.execPath, [join(root, 'tests', f)], { stdio: 'inherit', timeout: 600000 });
  } catch { failed++; console.log(`FALHA | ${f}`); }
}
console.log(failed ? `${failed} arquivo(s) de teste com falha` : 'todos os testes passaram');
process.exit(failed ? 1 : 0);
