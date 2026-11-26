// Formato binário da lista de desenho gerada por cadcraft-wasm (função `display` em
// cadcraft-wasm/src/lib.rs). Tudo little-endian, seções alinhadas a 4 bytes:
//
//   cabeçalho (160 bytes)
//     u32 × 8   magia "PLV1", versão (2), camadas+1, vértices de linha, índices de linha,
//               vértices de triângulo, pontos, sinalizadores (1 = cortado no limite de pontos,
//               2 = há imagens não desenhadas)
//     f64 × 2   origem (as coordenadas abaixo são relativas a ela, em f32)
//     f64 × 4   extensão completa      (x0, y0, x1, y1)
//     f64 × 4   extensão "robusta" (2%–98% dos objetos: ignora lixo muito distante; enquadrar)
//     f64 × 4   papel da folha (NaN no modelo)
//     f64 × 2   tolerância de curva usada, reservado
//   u32 × (camadas+2)   início de cada camada nos índices de linha (e o fim da última)
//   u32 × (camadas+2)   idem, nos vértices de triângulo
//   u32 × (camadas+2)   idem, nos pontos
//   f32 × 2·V  posições das linhas    u32 × V  cores (r | g<<8 | b<<16 | a<<24)
//   u32 × I    índices (pares = segmentos)
//   f32 × 2·T  triângulos             u32 × T  cores
//   f32 × 2·P  pontos                 u32 × P  cores
// Alfa 254 = cor 7 (troca pela tinta do tema), 253 = máscara (cor do fundo).

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export interface DisplayData {
  /** buffer de origem (as visões abaixo apontam para ele, sem cópia) */
  buf: ArrayBuffer;
  /** camadas do arquivo + 1 (a última: traços sem camada conhecida) */
  layers: number;
  truncated: boolean;
  hasImages: boolean;
  origin: { x: number; y: number };
  full: Bounds;
  robust: Bounds;
  sheet: Bounds | null;
  tolerance: number;
  lineStart: Uint32Array;
  triStart: Uint32Array;
  ptStart: Uint32Array;
  linePos: Float32Array;
  lineCol: Uint32Array;
  lineIdx: Uint32Array;
  triPos: Float32Array;
  triCol: Uint32Array;
  ptPos: Float32Array;
  ptCol: Uint32Array;
}

const MAGIC = 0x31564c50;
const HEADER = 160;

export function parseDisplay(buf: ArrayBuffer): DisplayData {
  if (buf.byteLength < HEADER) throw new Error('Lista de desenho vazia');
  const u = new Uint32Array(buf, 0, 8);
  if (u[0] !== MAGIC || u[1] !== 2) throw new Error('Lista de desenho em formato desconhecido');
  const [, , layers, nv, ni, nt, np, flags] = u;
  const f = new Float64Array(buf, 32, 16);
  const b = (i: number): Bounds => ({ x0: f[i], y0: f[i + 1], x1: f[i + 2], y1: f[i + 3] });
  let o = HEADER;
  const u32 = (n: number) => { const a = new Uint32Array(buf, o, n); o += n * 4; return a; };
  const f32 = (n: number) => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const lineStart = u32(layers + 1), triStart = u32(layers + 1), ptStart = u32(layers + 1);
  const linePos = f32(nv * 2), lineCol = u32(nv), lineIdx = u32(ni);
  const triPos = f32(nt * 2), triCol = u32(nt);
  const ptPos = f32(np * 2), ptCol = u32(np);
  const sheet = b(10);
  return {
    buf, layers, truncated: (flags & 1) !== 0, hasImages: (flags & 2) !== 0,
    origin: { x: f[0], y: f[1] }, full: b(2), robust: b(6),
    sheet: Number.isFinite(sheet.x0) ? sheet : null,
    tolerance: f[14],
    lineStart, triStart, ptStart, linePos, lineCol, lineIdx, triPos, triCol, ptPos, ptCol,
  };
}

/** Trechos contínuos [início, fim) das camadas visíveis, juntando camadas vizinhas. */
export function visibleRuns(start: Uint32Array, visible: (layer: number) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  for (let l = 0; l + 1 < start.length; l++) {
    const a = start[l], z = start[l + 1];
    if (z <= a || !visible(l)) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === a) last[1] = z;
    else runs.push([a, z]);
  }
  return runs;
}
