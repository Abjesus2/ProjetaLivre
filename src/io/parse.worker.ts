// Web Worker: lê DWG/DXF fora da thread da interface, enviando o progresso.
//
// Dois usos:
// - `edit`: monta o desenho editável. Primeiro com o leitor CADCraft (WebAssembly); se ele não
//   estiver disponível ou falhar, com os leitores anteriores (dxf-parser / LibreDWG).
// - `view`: só visualização. O CADCraft lê o arquivo e entrega a lista de desenho pronta para a
//   placa de vídeo; o desenho fica guardado aqui para pedidos de mais detalhe (`display`).
import { readCad } from './cad';
import { fromRaw, type CadResult, type RawDoc } from './raw';
import { entityBox } from '../core/geom';
import { CadCraft } from './cadcraft/bridge';

type Msg =
  | { op: 'edit'; kind: 'dxf' | 'dwg'; data: ArrayBuffer; name: string; module?: WebAssembly.Module | null }
  | { op: 'view'; data: ArrayBuffer; name: string; module: WebAssembly.Module }
  | { op: 'display'; id: number; space: number; tolerance: number; win: [number, number, number, number] | null; force?: Uint8Array };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const progress = (stage: string, pct: number) => post({ type: 'progress', stage, pct });

let viewer: CadCraft | null = null;

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.op === 'edit') await edit(m);
    else if (m.op === 'view') await view(m);
    else if (m.op === 'display') {
      if (!viewer) throw new Error('Nenhum desenho aberto no visualizador');
      if (m.force) viewer.forceLayers(m.force);
      const buf = viewer.display(m.space, m.tolerance, m.win);
      post({ type: 'display', id: m.id, buf }, [buf]);
    }
  } catch (err) {
    post({ type: 'error', id: (m as { id?: number }).id, message: (err as Error)?.message ?? String(err) });
  }
};

async function edit(m: Extract<Msg, { op: 'edit' }>) {
  const { kind, data, name } = m;
  let res: CadResult | null = null;
  if (m.module) {
    try {
      res = await withCadCraft(m.module, data, name);
    } catch (err) {
      // o leitor anterior tenta em seguida (fica registrado no console para diagnóstico)
      console.warn('CADCraft não conseguiu ler; usando o leitor anterior:', err);
    }
  }
  if (!res) res = await readCad(kind, data, name, progress);
  const { drawing, skipped } = res;
  // limites de cada objeto calculados aqui, fora da thread da interface
  progress('Calculando limites dos objetos…', 96);
  const boxes = new Float64Array(drawing.entities.length * 4);
  drawing.entities.forEach((e, i) => { const b = entityBox(e); boxes.set([b.minX, b.minY, b.maxX, b.maxY], i * 4); });
  // texto JSON é bem mais rápido de transferir que milhares de objetos clonados
  const json = new TextEncoder().encode(JSON.stringify(drawing));
  post({ type: 'done', json, boxes, skipped }, [json.buffer, boxes.buffer]);
}

async function withCadCraft(mod: WebAssembly.Module, data: ArrayBuffer, name: string): Promise<CadResult> {
  progress('Iniciando o leitor CADCraft…', 6);
  const cc = await CadCraft.create(mod);
  progress('Interpretando o desenho (CADCraft)…', 12);
  // cópia: se o CADCraft falhar, o leitor anterior ainda precisa dos bytes originais
  cc.open(new Uint8Array(data).slice(), name);
  progress('Preparando os objetos…', 40);
  const text = cc.raw();
  cc.close();
  const raw = JSON.parse(text) as RawDoc & { skipped?: Record<string, number> };
  const res = fromRaw(raw, name, (done, total) => progress(`Convertendo objetos… ${done.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}`, 55 + Math.round((done / Math.max(total, 1)) * 40)));
  for (const [t, n] of Object.entries(raw.skipped ?? {})) res.skipped[t] = (res.skipped[t] ?? 0) + n;
  return res;
}

async function view(m: Extract<Msg, { op: 'view' }>) {
  progress('Iniciando o leitor CADCraft…', 8);
  viewer?.close();
  viewer = await CadCraft.create(m.module);
  progress('Interpretando o desenho…', 20);
  viewer.open(m.data, m.name);
  const info = viewer.info();
  // começa pelo modelo; se ele estiver vazio, pela folha aberta no arquivo (ou a primeira com conteúdo)
  let space = 0;
  if (info.entities === 0) {
    const act = info.sheets[info.activeSheet - 1];
    space = act && act.entities > 0 ? info.activeSheet : info.sheets.findIndex((s) => s.entities > 0) + 1;
  }
  progress('Montando a imagem…', 70);
  const buf = viewer.display(space);
  post({ type: 'view', info, space, buf }, [buf]);
}
