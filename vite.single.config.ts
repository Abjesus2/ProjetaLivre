import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Gera um único ProjetaLivre.html com tudo embutido (JS, CSS e o leitor de DWG em WebAssembly),
// que abre com duplo clique, sem servidor.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  // troca o worker em arquivo separado pela versão embutida (blob), que funciona em file://
  resolve: {
    alias: [{ find: /^\.\/workerFactory$/, replacement: fileURLToPath(new URL('./src/io/workerFactory.inline.ts', import.meta.url)) }],
  },
  // worker clássico (iife): o Chrome não permite worker "module" vindo de blob em páginas file://
  worker: { format: 'iife', rollupOptions: { output: { inlineDynamicImports: true } } },
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
});
