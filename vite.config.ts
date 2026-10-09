import { defineConfig } from 'vite';

export default defineConfig({
  // caminhos relativos: o site funciona em qualquer subpasta (ex.: GitHub Pages)
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // o leitor de DWG localiza o .wasm via import.meta.url; o pré-empacotamento quebraria esse caminho
  // o worker usa import dinâmico; precisa ser módulo ES
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
});
