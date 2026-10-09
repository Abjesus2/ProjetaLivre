import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Gera um único ProjetaLivre.html com tudo embutido (JS, CSS e o leitor de DWG em WebAssembly),
// que abre com duplo clique, sem servidor.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
});
