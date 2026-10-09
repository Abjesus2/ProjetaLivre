import type { Entity } from './types';
import type { Box } from './geom';
import { boxValid } from './geom';

/** Grade uniforme para achar rapidamente os objetos perto de um ponto ou dentro de uma janela. */
export class GridIndex {
  private cells = new Map<number, Entity[]>();
  private big: Entity[] = [];
  private size = 1;
  private ox = 0;
  private oy = 0;
  private stamp = new WeakMap<Entity, number>();
  private query_ = 0;

  constructor(ents: Entity[], boxOf: (e: Entity) => Box) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const boxes: Box[] = new Array(ents.length);
    ents.forEach((e, i) => {
      const b = boxOf(e); boxes[i] = b;
      if (!boxValid(b)) return;
      if (b.minX < minX) minX = b.minX; if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX; if (b.maxY > maxY) maxY = b.maxY;
    });
    if (!isFinite(minX)) return;
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const n = Math.max(8, Math.min(512, Math.round(Math.sqrt(ents.length) * 1.5)));
    this.size = span / n; this.ox = minX; this.oy = minY;
    ents.forEach((e, i) => {
      const b = boxes[i];
      if (!boxValid(b)) return;
      const [x0, y0, x1, y1] = this.range(b);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { this.big.push(e); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = x * 65536 + y;
        let c = this.cells.get(k); if (!c) this.cells.set(k, (c = [])); c.push(e);
      }
    });
  }

  private range(b: Box): [number, number, number, number] {
    const f = (v: number, o: number) => Math.max(0, Math.min(65535, Math.floor((v - o) / this.size)));
    return [f(b.minX, this.ox), f(b.minY, this.oy), f(b.maxX, this.ox), f(b.maxY, this.oy)];
  }

  /** Objetos cujas caixas podem tocar a janela (sem repetição). */
  query(b: Box): Entity[] {
    const out: Entity[] = [];
    const q = ++this.query_;
    const push = (e: Entity) => { if (this.stamp.get(e) !== q) { this.stamp.set(e, q); out.push(e); } };
    this.big.forEach(push);
    const [x0, y0, x1, y1] = this.range(b);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 200000) { for (const c of this.cells.values()) c.forEach(push); return out; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.cells.get(x * 65536 + y)?.forEach(push);
    return out;
  }
}
