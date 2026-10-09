import type { Pt } from '../core/types';
import type { Box } from '../core/geom';
import { boxValid } from '../core/geom';

/** Câmera 2D: escala (px por unidade) e centro em coordenadas do mundo. Y do mundo aponta para cima. */
export class View {
  s = 4;
  cx = 0;
  cy = 0;
  w = 1;
  h = 1;
  version = 0;

  toScreen(p: Pt): Pt { return { x: (p.x - this.cx) * this.s + this.w / 2, y: this.h / 2 - (p.y - this.cy) * this.s }; }
  toWorld(x: number, y: number): Pt { return { x: (x - this.w / 2) / this.s + this.cx, y: (this.h / 2 - y) / this.s + this.cy }; }

  zoomAt(sx: number, sy: number, k: number) {
    const before = this.toWorld(sx, sy);
    this.s = Math.min(1e6, Math.max(1e-6, this.s * k));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x; this.cy += before.y - after.y;
    this.version++;
  }
  pan(dx: number, dy: number) { this.cx -= dx / this.s; this.cy += dy / this.s; this.version++; }

  fit(b: Box, pad = 0.12) {
    if (!boxValid(b)) { this.s = 4; this.cx = 0; this.cy = 0; this.version++; return; }
    const bw = Math.max(b.maxX - b.minX, 1e-6), bh = Math.max(b.maxY - b.minY, 1e-6);
    this.s = Math.min(this.w / bw, this.h / bh) * (1 - pad * 2);
    if (!isFinite(this.s) || this.s <= 0) this.s = 1;
    this.cx = (b.minX + b.maxX) / 2; this.cy = (b.minY + b.maxY) / 2;
    this.version++;
  }

  worldBox(): Box {
    const a = this.toWorld(0, this.h), b = this.toWorld(this.w, 0);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
}
