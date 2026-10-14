import type { Entity } from './types';
import type { Box } from './geom';
import { boxValid } from './geom';

/** níveis da grade: cada um com células 8× maiores que o anterior */
const LEVELS = 4;
/** um objeto fica no nível mais fino em que ocupa no máximo isto de células */
const MAX_CELLS = 64;
/** coordenada máxima de célula (longe da extensão, encosta na borda); chaves pequenas = Map rápido */
const LIM = 4095;
const key = (x: number, y: number) => x * 4096 + y;

/**
 * Grade em níveis para achar rapidamente os objetos perto de um ponto ou dentro de uma janela.
 * - A extensão da grade ignora objetos muito distantes (lixo comum em DWG/DXF), que senão
 *   espremeriam o desenho todo em poucas células.
 * - Objetos grandes vão para níveis de células maiores, em vez de uma lista que toda consulta
 *   percorreria.
 * Aceita inserções depois de montada; objetos apagados ficam na grade até a próxima
 * reconstrução e são filtrados na consulta (quem chama diz quais ainda existem).
 */
export class GridIndex {
  private cells: Map<number, Entity[]>[] = Array.from({ length: LEVELS }, () => new Map());
  /** maiores que o nível mais grosso */
  private big: Entity[] = [];
  private size = 1;
  /** tamanho da célula de cada nível */
  private sizes: number[] = [1, 8, 64, 512];
  private ox = 0;
  private oy = 0;
  private stamp = new WeakMap<Entity, number>();
  private query_ = 0;
  /** objetos na montagem inicial */
  readonly built: number;
  /** inseridos depois da montagem */
  inserted = 0;
  /** apagados que ainda ocupam a grade */
  stale = 0;
  /** inseridos fora da área da grade (encostados na borda: deixam as consultas lentas) */
  outside = 0;
  /** células por lado no nível 0 */
  private n0 = 0;

  constructor(ents: Entity[], private boxOf: (e: Entity) => Box) {
    this.built = ents.length;
    const boxes: Box[] = new Array(ents.length);
    let n = 0;
    for (let i = 0; i < ents.length; i++) { const b = boxOf(ents[i]); boxes[i] = b; if (boxValid(b)) n++; }
    if (!n) return;
    // extensão "robusta": 1% a 99% dos cantos (objetos isolados muito longe não a esticam);
    // com muitos objetos, uma amostra basta
    const step = Math.max(1, Math.floor(n / 20000)), m = Math.ceil(n / step);
    const ax = new Float64Array(m), ay = new Float64Array(m), bx = new Float64Array(m), by = new Float64Array(m);
    let k = 0, seen = 0;
    for (const b of boxes) {
      if (!boxValid(b)) continue;
      if (seen++ % step === 0 && k < m) { ax[k] = b.minX; ay[k] = b.minY; bx[k] = b.maxX; by[k] = b.maxY; k++; }
    }
    const q = (a: Float64Array, p: number) => a.subarray(0, k).sort()[Math.floor(p * (k - 1))];
    const lo = k > 200 ? 0.01 : 0, hi = k > 200 ? 0.99 : 1;
    const minX = q(ax, lo), minY = q(ay, lo), maxX = q(bx, hi), maxY = q(by, hi);
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const cells = Math.max(8, Math.min(512, Math.round(Math.sqrt(n) * 1.5)));
    this.size = span / cells; this.ox = minX; this.oy = minY; this.n0 = cells;
    this.sizes = Array.from({ length: LEVELS }, (_, lv) => this.size * Math.pow(8, lv));
    for (let i = 0; i < ents.length; i++) this.put(ents[i], boxes[i]);
  }

  private put(e: Entity, b: Box) {
    if (!(b.minX <= b.maxX && b.minY <= b.maxY)) return;
    for (let lv = 0; lv < LEVELS; lv++) {
      const s = this.sizes[lv];
      const x0 = this.cell(b.minX, this.ox, s), x1 = this.cell(b.maxX, this.ox, s);
      const y0 = this.cell(b.minY, this.oy, s), y1 = this.cell(b.maxY, this.oy, s);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) continue;
      const cells = this.cells[lv];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = key(x, y);
        const c = cells.get(k);
        if (c) c.push(e); else cells.set(k, [e]);
      }
      return;
    }
    this.big.push(e);
  }
  private cell(v: number, o: number, s: number) { const c = Math.floor((v - o) / s); return c < 0 ? 0 : c > LIM ? LIM : c; }

  /** acrescenta um objeto criado depois da montagem */
  insert(e: Entity) {
    this.inserted++;
    const b = this.boxOf(e);
    if (this.n0 && boxValid(b)) {
      const s = this.sizes[0], n = this.n0;
      if (b.maxX < this.ox || b.maxY < this.oy || b.minX > this.ox + n * s || b.minY > this.oy + n * s) this.outside++;
    }
    this.put(e, b);
  }

  /** vale a pena remontar? (muitos inseridos, muitos fora da área da grade ou muitos apagados) */
  get worn() { return this.inserted > Math.max(500, this.built) || this.outside > Math.max(500, this.built / 16) || this.stale > Math.max(500, this.built / 4); }

  /** células (do nível lv) que a caixa ocupa; longe da extensão, encosta nas células da borda */
  private range(b: Box, lv: number): [number, number, number, number] {
    const s = this.sizes[lv];
    return [this.cell(b.minX, this.ox, s), this.cell(b.minY, this.oy, s), this.cell(b.maxX, this.ox, s), this.cell(b.maxY, this.oy, s)];
  }

  /** Objetos cujas caixas podem tocar a janela (sem repetição). */
  query(b: Box): Entity[] {
    const out: Entity[] = [];
    const q = ++this.query_;
    const push = (e: Entity) => { if (this.stamp.get(e) !== q) { this.stamp.set(e, q); out.push(e); } };
    this.big.forEach(push);
    for (let lv = 0; lv < LEVELS; lv++) {
      const cells = this.cells[lv];
      if (!cells.size) continue;
      const [x0, y0, x1, y1] = this.range(b, lv);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > cells.size) { for (const c of cells.values()) c.forEach(push); continue; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.get(key(x, y))?.forEach(push);
    }
    return out;
  }
}
