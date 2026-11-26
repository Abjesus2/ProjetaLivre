// Leitor CADCraft (storytold/cadcraft, MIT OR Apache-2.0) compilado para WebAssembly.
// O módulo é baixado e compilado UMA vez, na thread da página (a compilação em si roda em
// segundo plano no navegador), e depois enviado pronto para os workers: o de edição e o do
// visualizador reaproveitam o mesmo código, sem baixar nem compilar de novo.
import wasmUrl from './projetalivre_cadcraft.wasm?url';

let pending: Promise<WebAssembly.Module> | null = null;

/** Módulo compilado do leitor; rejeita se o navegador não conseguir carregá-lo. */
export function cadcraftModule(): Promise<WebAssembly.Module> {
  if (!pending) {
    pending = compile().catch((err) => {
      pending = null; // tenta de novo numa próxima abertura
      throw err;
    });
  }
  return pending;
}

async function compile(): Promise<WebAssembly.Module> {
  if (typeof WebAssembly === 'undefined') throw new Error('Este navegador não tem WebAssembly');
  // compilação enquanto baixa (servidor com application/wasm); senão, baixa e compila
  if (WebAssembly.compileStreaming && !wasmUrl.startsWith('data:')) {
    try { return await WebAssembly.compileStreaming(fetch(wasmUrl)); } catch { /* tipo errado: caminho abaixo */ }
  }
  const r = await fetch(wasmUrl);
  if (!r.ok) throw new Error(`Leitor CADCraft indisponível (${r.status})`);
  return WebAssembly.compile(await r.arrayBuffer());
}
