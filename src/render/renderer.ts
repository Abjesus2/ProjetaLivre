import type { Entity, NewEntity, Pt } from '../core/types';
import type { Box, Mat } from '../core/geom';
import { entityBox, tessellate, dist, boxValid, compose } from '../core/geom';
import type { Doc, DocChange } from '../core/doc';
import { View } from './view';
import { pathEntity, pathWorld, fillHatch, resetTextFont, TEXT_FONT } from './draw';

export type SnapKind = 'end' | 'mid' | 'center' | 'quad' | 'inter' | 'near' | 'grid';
export interface SnapHit { p: Pt; kind: SnapKind }

export interface Overlay {
  cursor: Pt | null;           // posição em tela
  world: Pt | null;            // posição no mundo (já com snap)
  snap: SnapHit | null;
  selection: Set<string>;
  /** entidades selecionadas, na ordem do desenho (mesma lista enquanto nada muda) */
  selEnts: Entity[];
  hover: string | null;
  preview: NewEntity[];
  /** prévia de MOVER/GIRAR/… com muitos objetos: desenha os originais com a matriz */
  xform: { ents: Entity[]; m: Mat } | null;
  guides: Pt[][];              // linhas-guia (mundo)
  window: { a: Pt; b: Pt } | null; // tela
  grips: Pt[];
  activeGrip: number;
  showCrosshair: boolean;
  label: string | null;        // rótulo dinâmico perto do cursor
}

interface Ripple { x: number; y: number; t0: number; color: string }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }

const boxCache = new WeakMap<object, Box>();
/** aproveita limites já calculados no worker */
export function seedBoxes(ents: Entity[], b: Float64Array) {
  ents.forEach((e, i) => boxCache.set(e, { minX: b[i * 4], minY: b[i * 4 + 1], maxX: b[i * 4 + 2], maxY: b[i * 4 + 3] }));
}
export const cachedBox = (e: Entity) => { let b = boxCache.get(e); if (!b) { b = entityBox(e); boxCache.set(e, b); } return b; };

/** seleção/prévia acima disto: caminho único em cache, sem brilho nem animação */
const BIG = 400;
/** regiões alteradas que valem redesenho parcial (acima disto, redesenho completo) */
const MAX_PATCHES = 12;
/** objetos por traçado (caminhos menores pintam bem mais rápido) */
const BATCH = 256;
/** prévia de transformação acima disto: imagem pronta levada pela matriz (custo fixo por quadro) */
const HUGE = 20000;

/** inversa de uma matriz afim 2×3 */
const invert = (m: Mat): Mat => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-300;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

export class Renderer {
  ctx: CanvasRenderingContext2D;
  /** camada do desenho: canvas próprio no DOM, desenhado em lotes ao longo de vários quadros */
  staticCanvas = document.createElement('canvas');
  sctx: CanvasRenderingContext2D;
  /** desenho em lotes: a tela inteira (clip = null) ou uma região alterada */
  private job: { items: [string, Entity][]; dots: Map<string, Pt[]>; i: number; last: number; t0: number; clip: Box | null } | null = null;
  /** objetos por lote, ajustado para manter a tela fluida */
  private chunk = 6000;
  dpr = 1;
  /** redesenhar a camada do desenho inteira */
  dirty = true;
  paper = false;
  showGrid = true;
  /** modo leve: sem brilhos/animações, resolução 1×, só redesenha quando algo muda */
  lite = false;
  /** o que está por cima do desenho (cursor, seleção, prévias) precisa ser redesenhado */
  overlayDirty = true;
  /** consulta espacial do editor (null enquanto o índice não existe) */
  query: ((b: Box) => Entity[] | null) | null = null;
  /** regiões da tela (px) a redesenhar na camada do desenho */
  private patches: Box[] = [];
  private ripples: Ripple[] = [];
  private particles: Particle[] = [];
  private births = new Map<string, number>();
  private start = performance.now();
  /** custo do último desenho completo (ms) — decide o pan/zoom por imagem transformada */
  private lastFullMs = 0;

  constructor(public canvas: HTMLCanvasElement, public view: View, public doc: Doc, public overlay: Overlay) {
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.staticCanvas.getContext('2d')!;
    this.staticCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transform-origin:0 0;';
    this.staticCanvas.setAttribute('aria-hidden', 'true');
    canvas.parentElement!.insertBefore(this.staticCanvas, canvas);
  }

  /** desenhos grandes: sem animação de "tinta" (ela exigiria redesenhar a região duas vezes) */
  get heavy() { return this.lite || this.doc.d.entities.length > 8000; }
  /** pan/zoom pela imagem já pronta enquanto a vista se move (redesenho completo caro) */
  private get fastView() { return this.doc.d.entities.length > (this.lite ? 1500 : 8000) || this.lastFullMs > (this.lite ? 8 : 16); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.lite ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    // mesmo tamanho e resolução: nada a refazer (trocar width/height apaga o canvas)
    if (dpr === this.dpr && r.width === this.view.w && r.height === this.view.h && this.canvas.width === Math.max(1, Math.round(r.width * dpr))) return;
    this.dpr = dpr;
    for (const c of [this.canvas, this.staticCanvas]) { c.width = Math.max(1, Math.round(r.width * this.dpr)); c.height = Math.max(1, Math.round(r.height * this.dpr)); }
    this.view.w = r.width; this.view.h = r.height; this.view.version++;
    // os canvas acabaram de ser apagados: nada de reaproveitar a imagem antiga (redesenha já)
    this.rendered.version = -1; this.job = null; this.patches = [];
    this.dirty = true; this.overlayDirty = true;
  }

  ripple(p: Pt, color = '#d4ff3a') { if (this.lite) return; this.ripples.push({ x: p.x, y: p.y, t0: performance.now(), color }); this.overlayDirty = true; }
  born(id: string) { if (this.heavy) return; this.births.set(id, performance.now()); this.overlayDirty = true; }
  dissolve(ents: Entity[]) {
    if (this.lite) return;
    const wb = this.view.worldBox();
    for (const e of ents) {
      if (this.particles.length >= 2500) break;
      const b = cachedBox(e);
      if (b.maxX < wb.minX || b.minX > wb.maxX || b.maxY < wb.minY || b.minY > wb.maxY) continue;
      const color = this.doc.colorOf(e);
      for (const path of tessellate(e, this.view.s)) {
        for (let i = 0; i < path.length - 1; i++) {
          const a = this.view.toScreen(path[i]), b = this.view.toScreen(path[i + 1]);
          const n = Math.min(12, Math.ceil(dist(a, b) / 9));
          for (let k = 0; k < n && this.particles.length < 2500; k++) {
            const t = Math.random();
            this.particles.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, vx: (Math.random() - 0.5) * 2.4, vy: -Math.random() * 2.2 - 0.4, life: 1, color, size: 1 + Math.random() * 2.2 });
          }
        }
      }
    }
    this.overlayDirty = true;
  }

  get ink() { return this.paper ? '#1b1a22' : '#e9f0ff'; }

  private colorFor(e: Entity) {
    const c = this.doc.colorOf(e);
    if (!this.paper) return c;
    const n = parseInt(c.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 200 ? '#1b1a22' : c;
  }

  // ---------------------------------------------------------------- camada do desenho

  /**
   * O desenho mudou. Se a imagem pronta está na vista atual, só as regiões das entidades
   * que entraram/saíram são redesenhadas; senão (ou se for muita coisa), tudo.
   */
  invalidate(c: DocChange) {
    this.overlayDirty = true;
    if (c.reset || c.meta) { this.dirty = true; return; }
    if (this.dirty) return;
    if (this.rendered.version !== this.view.version || this.staticCanvas.style.transform) { this.dirty = true; return; }
    if (c.added.length + c.removed.length > 60000) { this.dirty = true; return; }
    for (const e of c.removed) this.patchEntity(e);
    for (const e of c.added) this.patchEntity(e);
  }

  /** marca para redesenho a região da tela ocupada pela entidade */
  private patchEntity(e: Entity) {
    if (this.dirty) return;
    const b = cachedBox(e);
    if (!boxValid(b)) return;
    const v = this.view;
    const a = v.toScreen({ x: b.minX, y: b.maxY }), z = v.toScreen({ x: b.maxX, y: b.minY });
    // traço (1,25 px), cruz dos pontos (4 px) e letras que passam da caixa do texto
    let pad = 7;
    if (e.type === 'text' || e.type === 'dim') pad += (e.type === 'text' ? e.h : (e.h ?? 0)) * v.s * 0.6;
    const r: Box = { minX: Math.max(0, a.x - pad), minY: Math.max(0, a.y - pad), maxX: Math.min(v.w, z.x + pad), maxY: Math.min(v.h, z.y + pad) };
    if (r.minX >= r.maxX || r.minY >= r.maxY) return; // fora da tela
    this.addPatch(r);
  }

  private addPatch(r: Box) {
    const near = (p: Box, q: Box) => p.minX <= q.maxX + 24 && q.minX <= p.maxX + 24 && p.minY <= q.maxY + 24 && q.minY <= p.maxY + 24;
    const merge = (p: Box, q: Box): Box => ({ minX: Math.min(p.minX, q.minX), minY: Math.min(p.minY, q.minY), maxX: Math.max(p.maxX, q.maxX), maxY: Math.max(p.maxY, q.maxY) });
    let cur = r;
    for (let i = 0; i < this.patches.length;) {
      if (near(this.patches[i], cur)) { cur = merge(this.patches[i], cur); this.patches.splice(i, 1); i = 0; } else i++;
    }
    this.patches.push(cur);
    if (this.patches.length > MAX_PATCHES) {
      // junta as duas mais próximas
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < this.patches.length; i++) for (let j = i + 1; j < this.patches.length; j++) {
        const m = merge(this.patches[i], this.patches[j]);
        const d = (m.maxX - m.minX) * (m.maxY - m.minY);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      const m = merge(this.patches[bi], this.patches[bj]);
      this.patches.splice(bj, 1); this.patches.splice(bi, 1); this.patches.push(m);
    }
    const area = this.patches.reduce((s, p) => s + (p.maxX - p.minX) * (p.maxY - p.minY), 0);
    if (area > this.view.w * this.view.h * 0.5) { this.patches = []; this.dirty = true; }
  }

  /**
   * Entidades visíveis na janela (mundo), separadas em traços (por cor) e pontinhos (nível de
   * detalhe), sempre na ordem do desenho dentro de cada cor — a mesma ordem do desenho completo,
   * para o redesenho de uma região sair igual a ele.
   */
  private collect(wb: Box, region = false): { items: [string, Entity][]; dots: Map<string, Pt[]> } {
    const v = this.view;
    const groups = new Map<string, Entity[]>();
    const dots = new Map<string, Pt[]>();
    const tiny = (this.lite ? 2 : 1.2) / v.s; // objetos menores que ~1 px viram um ponto (nível de detalhe)
    let cand: Entity[] = this.doc.d.entities;
    if (region) {
      const q = this.query?.(wb);
      if (q) cand = q.sort((a, b) => this.doc.orderOf(a) - this.doc.orderOf(b));
    }
    for (const e of cand) {
      if (!this.doc.isVisible(e) || this.births.has(e.id)) continue;
      const b = cachedBox(e);
      if (b.maxX < wb.minX || b.minX > wb.maxX || b.maxY < wb.minY || b.minY > wb.maxY) continue;
      const c = this.colorFor(e);
      if (e.type !== 'text' && b.maxX - b.minX < tiny && b.maxY - b.minY < tiny) {
        let d = dots.get(c); if (!d) dots.set(c, (d = [])); d.push({ x: b.minX, y: b.minY });
        continue;
      }
      let g = groups.get(c); if (!g) groups.set(c, (g = [])); g.push(e);
    }
    // agrupa por cor (em ordem de cor, como antes) para reduzir trocas de estado
    const items: [string, Entity][] = [];
    for (const c of [...groups.keys()].sort()) for (const e of groups.get(c)!) items.push([c, e]);
    return { items, dots };
  }

  /** Prepara o redesenho da camada do desenho; o traçado em si acontece em lotes (drawChunk). */
  private renderStatic() {
    const ctx = this.sctx, v = this.view;
    const t0 = performance.now();
    this.patches = [];
    this.staticCanvas.style.transform = '';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    if (this.showGrid) this.drawGrid(ctx);
    this.drawAxes(ctx);
    const { items, dots } = this.collect(v.worldBox());
    this.job = { items, dots, i: 0, last: 0, t0, clip: null };
    this.rendered = { s: v.s, cx: v.cx, cy: v.cy, version: v.version };
    this.drawChunk();
  }

  /**
   * Traça uma lista já agrupada por cor. Cada traçado leva no máximo BATCH objetos: um caminho
   * gigante por cor custa mais que o dobro para pintar (medido: 1,9 s contra 0,8 s com 100 mil).
   */
  private drawItems(ctx: CanvasRenderingContext2D, items: [string, Entity][], from: number, to: number) {
    const v = this.view;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = this.lite ? 1 : 1.25;
    resetTextFont(ctx);
    let color = '', n = 0;
    ctx.beginPath();
    for (let j = from; j < to; j++) {
      const [c, e] = items[j];
      if (e.type === 'hatch') { if (color) ctx.stroke(); fillHatch(ctx, e, v, c); color = ''; ctx.beginPath(); continue; }
      if (c !== color) { if (color) ctx.stroke(); ctx.strokeStyle = c; color = c; ctx.beginPath(); n = 0; }
      else if (n >= BATCH) { ctx.stroke(); ctx.beginPath(); n = 0; }
      pathEntity(ctx, e, v, c, this.lite);
      n++;
    }
    if (color) ctx.stroke();
  }

  private drawDots(ctx: CanvasRenderingContext2D, dots: Map<string, Pt[]>) {
    const v = this.view;
    for (const [c, list] of dots) {
      ctx.fillStyle = c;
      for (const p of list) { const q = v.toScreen(p); ctx.fillRect(q.x, q.y, 1, 1); }
    }
  }

  /** Traça um lote do desenho. O tamanho do lote se ajusta para manter a tela fluida. */
  private drawChunk() {
    const job = this.job!, ctx = this.sctx;
    const now = performance.now();
    if (job.last) {
      // o custo real de rasterização aparece no intervalo entre quadros: mira ~25 ms (modo leve: ~14 ms)
      const dt = now - job.last;
      const aim = this.lite ? 14 : 25;
      this.chunk = Math.max(800, Math.min(40000, Math.round(this.chunk * Math.min(2, Math.max(0.4, aim / Math.max(dt, 1))))));
    }
    job.last = now;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const c = job.clip;
    if (c) { ctx.save(); ctx.beginPath(); ctx.rect(c.minX, c.minY, c.maxX - c.minX, c.maxY - c.minY); ctx.clip(); }
    const end = Math.min(job.items.length, job.i + this.chunk);
    this.drawItems(ctx, job.items, job.i, end);
    job.i = end;
    const done = job.i >= job.items.length;
    if (done) this.drawDots(ctx, job.dots);
    if (c) ctx.restore();
    if (done) {
      // desenho completo que coube num quadro só: o custo dele decide o pan/zoom rápido
      if (job.t0 && !c) this.lastFullMs = performance.now() - job.t0;
      this.job = null;
    } else if (!c) { job.t0 = 0; this.lastFullMs = 999; } // não coube num quadro: caro
  }

  /**
   * Redesenha as regiões alteradas (recortadas), com tudo o que passa por elas. Região com muita
   * coisa é desenhada em lotes, ao longo de vários quadros, como o desenho completo — a tela não
   * trava numa edição grande.
   */
  private drawPatches() {
    const ctx = this.sctx, v = this.view, d = this.dpr;
    const t0 = performance.now();
    while (this.patches.length && !this.job) {
      const r = this.patches.shift()!;
      // alinhado a pixels do dispositivo: o recorte não deixa emenda visível
      const x0 = Math.floor(r.minX * d) / d, y0 = Math.floor(r.minY * d) / d;
      const x1 = Math.ceil(r.maxX * d) / d, y1 = Math.ceil(r.maxY * d) / d;
      const clip = { minX: x0, minY: y0, maxX: x1, maxY: y1 };
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      if (this.showGrid) this.drawGrid(ctx, clip);
      this.drawAxes(ctx);
      ctx.restore();
      // margem grande na busca: letras (acentos de textos grandes) e traços de objetos vizinhos
      // que entram na região
      const m = Math.min(4000, Math.max(48, this.maxTextHeight() * v.s * 0.7));
      const wa = v.toWorld(x0 - m, y1 + m), wz = v.toWorld(x1 + m, y0 - m);
      const { items, dots } = this.collect({ minX: wa.x, minY: wa.y, maxX: wz.x, maxY: wz.y }, true);
      this.job = { items, dots, i: 0, last: 0, t0: 0, clip };
      this.drawChunk();
      if (performance.now() - t0 > 12) break;
    }
  }

  /** maior altura de texto/cota do desenho (guardada até o desenho mudar) */
  private maxH: { version: number; h: number } = { version: -1, h: 0 };
  private maxTextHeight() {
    if (this.maxH.version !== this.doc.version) {
      let h = 0;
      for (const e of this.doc.d.entities) {
        if (e.type === 'text' && e.h > h) h = e.h;
        else if (e.type === 'dim' && (e.h ?? 0) > h) h = e.h!;
      }
      this.maxH = { version: this.doc.version, h };
    }
    return this.maxH.h;
  }

  /** desenhando o arquivo em lotes? (a interface pode mostrar um aviso) */
  get drawingProgress() { return this.job ? this.job.i / Math.max(this.job.items.length, 1) : 1; }

  /** vista usada no último desenho completo da camada estática */
  private rendered = { s: 0, cx: 0, cy: 0, version: -1 };
  private lastViewVersion = -1;
  private lastViewChange = 0;

  private drawGrid(ctx: CanvasRenderingContext2D, region?: Box) {
    const v = this.view;
    let step = Math.pow(10, Math.floor(Math.log10(40 / v.s)));
    while (step * v.s < 18) step *= step.toString().startsWith('2') ? 2.5 : 2;
    let wb = v.worldBox();
    if (region) { const a = v.toWorld(region.minX - 3, region.maxY + 3), b = v.toWorld(region.maxX + 3, region.minY - 3); wb = { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y }; }
    const x0 = Math.floor(wb.minX / step) * step, y0 = Math.floor(wb.minY / step) * step;
    const major = step * 5;
    const dot = this.paper ? 'rgba(27,26,34,0.22)' : 'rgba(233,240,255,0.16)';
    const big = this.paper ? 'rgba(27,26,34,0.45)' : 'rgba(212,255,58,0.42)';
    for (let i = 0, x = x0; x <= wb.maxX; x = x0 + ++i * step) {
      for (let j = 0, y = y0; y <= wb.maxY; y = y0 + ++j * step) {
        const p = v.toScreen({ x, y });
        const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6 && Math.abs(y / major - Math.round(y / major)) < 1e-6;
        if (isMajor) { ctx.fillStyle = big; ctx.fillRect(p.x - 1.5, p.y - 0.5, 3, 1); ctx.fillRect(p.x - 0.5, p.y - 1.5, 1, 3); }
        else { ctx.fillStyle = dot; ctx.fillRect(p.x - 0.6, p.y - 0.6, 1.2, 1.2); }
      }
    }
  }

  private drawAxes(ctx: CanvasRenderingContext2D) {
    const o = this.view.toScreen({ x: 0, y: 0 });
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = this.paper ? 'rgba(255,90,54,0.45)' : 'rgba(255,90,54,0.35)';
    ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(this.view.w, o.y); ctx.stroke();
    ctx.strokeStyle = this.paper ? 'rgba(20,140,180,0.45)' : 'rgba(139,233,255,0.35)';
    ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, this.view.h); ctx.stroke();
    ctx.setLineDash([]);
    // ícone UCS
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff5a36'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + 34, o.y); ctx.stroke();
    ctx.strokeStyle = '#8be9ff'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - 34); ctx.stroke();
    ctx.font = `600 10px ${TEXT_FONT}`; ctx.fillStyle = '#ff5a36'; ctx.fillText('X', o.x + 37, o.y + 4);
    ctx.fillStyle = '#8be9ff'; ctx.fillText('Y', o.x - 3, o.y - 38);
    ctx.restore();
  }

  // ---------------------------------------------------------------- caminhos em cache (muitos objetos)

  private pathCache = new WeakMap<Entity[], { paths: Path2D[]; ox: number; oy: number; s: number }>();
  /** caminhos (de BATCH em BATCH entidades) em coordenadas do mundo; refeitos se o zoom mudar muito */
  private bulkPath(ents: Entity[]) {
    const s = this.view.s;
    let c = this.pathCache.get(ents);
    const far = c && Math.hypot(c.ox - this.view.cx, c.oy - this.view.cy) * s > 1e5;
    if (!c || c.s / s > 4 || s / c.s > 4 || far) {
      // origem no centro da vista: coordenadas pequenas, sem perder precisão em desenhos
      // georreferenciados (o caminho e a matriz do canvas usam float32)
      const ox = this.view.cx, oy = this.view.cy;
      const paths: Path2D[] = [];
      for (let i = 0; i < ents.length; i += BATCH) {
        const path = new Path2D();
        for (let j = i; j < Math.min(ents.length, i + BATCH); j++) pathWorld(path, ents[j], ox, oy, s);
        paths.push(path);
      }
      c = { paths, ox, oy, s };
      this.pathCache.set(ents, c);
    }
    return c;
  }

  /** matriz: coordenadas do caminho em cache → pixels do dispositivo (com m aplicada no mundo) */
  private worldToDevice(ox: number, oy: number, m?: Mat): Mat {
    const v = this.view, d = this.dpr;
    const U: Mat = [1, 0, 0, -1, ox, oy];
    const S: Mat = [v.s, 0, 0, -v.s, v.w / 2 - v.cx * v.s, v.h / 2 + v.cy * v.s];
    const D: Mat = [d, 0, 0, d, 0, 0];
    return compose(D, compose(S, m ? compose(m, U) : U));
  }

  /**
   * Imagem de muitas entidades (seleção grande, prévia enorme), desenhada aos poucos — no máximo
   * ~10 ms por quadro — e refeita só quando a lista, a vista, o tema ou o tamanho mudam.
   */
  private layers = new Map<string, { canvas: HTMLCanvasElement; ents: Entity[]; version: number; paper: boolean; i: number; ox: number; oy: number }>();
  private layerOf(name: string, ents: Entity[], color: string, width: number) {
    const v = this.view;
    let L = this.layers.get(name);
    if (!L || L.ents !== ents || L.version !== v.version || L.paper !== this.paper || L.canvas.width !== this.canvas.width || L.canvas.height !== this.canvas.height) {
      const canvas = L?.canvas ?? document.createElement('canvas');
      if (canvas.width !== this.canvas.width || canvas.height !== this.canvas.height) { canvas.width = this.canvas.width; canvas.height = this.canvas.height; }
      const c = canvas.getContext('2d')!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      // origem no centro da vista (precisão em coordenadas grandes, como UTM)
      L = { canvas, ents, version: v.version, paper: this.paper, i: 0, ox: v.cx, oy: v.cy };
      this.layers.set(name, L);
    }
    if (L.i < ents.length) {
      const c = L.canvas.getContext('2d')!;
      c.setTransform(...this.worldToDevice(L.ox, L.oy));
      c.lineWidth = width / v.s; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = color;
      const t0 = performance.now();
      do {
        const path = new Path2D(), end = Math.min(ents.length, L.i + BATCH);
        for (let j = L.i; j < end; j++) pathWorld(path, ents[j], L.ox, L.oy, v.s);
        c.stroke(path);
        L.i = end;
      } while (L.i < ents.length && performance.now() - t0 < 10);
      // ainda falta: continua no próximo quadro
      if (L.i < ents.length) this.overlayDirty = true;
    }
    return L.canvas;
  }

  // ---------------------------------------------------------------- quadro

  /** algo na camada de cima muda sozinho com o tempo? */
  private animating() {
    const ov = this.overlay;
    if (this.ripples.length || this.particles.length || this.births.size) return true;
    if (this.lite) return false;
    return !!((ov.cursor && ov.showCrosshair) || (ov.selection.size && ov.selEnts.length <= BIG) || ov.preview.length || ov.snap || (ov.window && ov.window.b.x < ov.window.a.x));
  }
  private overlayVersion = -1;

  frame() {
    const now = performance.now();
    const ctx = this.ctx, v = this.view, ov = this.overlay;
    if (v.version !== this.lastViewVersion) { this.lastViewVersion = v.version; this.lastViewChange = now; }
    // Desenho pesado + vista mudando agora (zoom/arraste): reaproveita a última imagem
    // transformada e só redesenha tudo quando o movimento para.
    const moving = now - this.lastViewChange < 140;
    if (v.version !== this.rendered.version) this.dirty = true;
    const fast = this.dirty && this.fastView && moving && this.rendered.version >= 0;
    if (fast) {
      // zoom/arraste em andamento: só transforma a imagem já desenhada (GPU, custo zero)
      const o = this.rendered, k = v.s / o.s;
      const tx = v.w / 2 - k * (v.w / 2) + (o.cx - v.cx) * v.s;
      const ty = v.h / 2 - k * (v.h / 2) - (o.cy - v.cy) * v.s;
      this.staticCanvas.style.transform = `matrix(${k},0,0,${k},${tx},${ty})`;
      this.job = null; this.patches = [];
    } else if (this.dirty) { this.dirty = false; this.renderStatic(); }
    else if (this.job) this.drawChunk();
    else if (this.patches.length) this.drawPatches();

    // camada de cima: só quando algo mudou ou está animando
    if (!this.overlayDirty && v.version === this.overlayVersion && !this.animating()) return;
    this.overlayDirty = false; this.overlayVersion = v.version;
    const lite = this.lite;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const t = lite ? 0 : (now - this.start) / 1000;
    const glow = (color: string, blur: number) => { if (!lite) { ctx.shadowColor = color; ctx.shadowBlur = blur; } };

    // entidades recém-nascidas: animação de "tinta" percorrendo o traço
    for (const [id, t0] of this.births) {
      const e = this.doc.byId(id);
      const k = Math.min(1, (now - t0) / 520);
      if (!e || k >= 1 || ov.selection.has(id) || lite) { this.births.delete(id); if (e) this.patchEntity(e); continue; }
      const ease = 1 - Math.pow(1 - k, 3);
      const color = this.colorFor(e);
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 1.25 + 4 * (1 - ease);
      ctx.shadowColor = color; ctx.shadowBlur = 18 * (1 - ease);
      const len = 4000;
      ctx.setLineDash([len * ease, len]);
      ctx.beginPath(); pathEntity(ctx, e, v, color); ctx.stroke();
      ctx.restore();
    }

    // selecionadas: brilho pulsante + tracejado correndo (muitas: imagem pronta, sem animação)
    if (ov.selection.size && ov.selEnts.length) {
      if (ov.selEnts.length > BIG) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.layerOf('sel', ov.selEnts, '#d4ff3a', 1.5), 0, 0);
        ctx.restore();
      } else {
        ctx.save();
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 5]); ctx.lineDashOffset = -t * 30;
        glow('#d4ff3a', 8 + Math.sin(t * 4) * 4);
        ctx.strokeStyle = '#d4ff3a';
        ctx.beginPath();
        for (const e of ov.selEnts) pathEntity(ctx, e, v, '#d4ff3a');
        ctx.stroke();
        ctx.restore();
      }
    }

    // destaque ao passar o mouse
    if (ov.hover && !ov.selection.has(ov.hover)) {
      const e = this.doc.byId(ov.hover);
      if (e) {
        const c = this.colorFor(e);
        ctx.save(); ctx.lineWidth = 3.2; ctx.strokeStyle = c; glow(c, 14);
        ctx.beginPath(); pathEntity(ctx, e, v, c); ctx.stroke(); ctx.restore();
      }
    }

    // pré-visualização da ferramenta ativa
    if (ov.preview.length) {
      ctx.save();
      ctx.strokeStyle = '#ff5a36'; ctx.lineWidth = 1.6; ctx.setLineDash([10, 6]); ctx.lineDashOffset = -t * 40;
      glow('#ff5a36', 10);
      ctx.beginPath();
      for (const e of ov.preview) pathEntity(ctx, e as Entity, v, '#ff5a36');
      ctx.stroke();
      ctx.restore();
    }
    // prévia de transformação com muitos objetos: um caminho só, levado pela matriz
    if (ov.xform && ov.xform.ents.length > HUGE) {
      // dezenas de milhares de objetos: a imagem deles (feita uma vez) levada pela matriz na tela
      const img = this.layerOf('xform', ov.xform.ents, '#ff5a36', 1);
      const W: Mat = compose([this.dpr, 0, 0, this.dpr, 0, 0], [v.s, 0, 0, -v.s, v.w / 2 - v.cx * v.s, v.h / 2 + v.cy * v.s]);
      ctx.save();
      ctx.setTransform(...compose(W, compose(ov.xform.m, invert(W))));
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else if (ov.xform && ov.xform.ents.length) {
      const p = this.bulkPath(ov.xform.ents);
      const M = this.worldToDevice(p.ox, p.oy, ov.xform.m);
      const k = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) / this.dpr || 1;
      ctx.save();
      ctx.setTransform(...M);
      // traço de 1 px: o mais barato de pintar a cada quadro
      ctx.strokeStyle = '#ff5a36'; ctx.lineWidth = 1 / k; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      for (const path of p.paths) ctx.stroke(path);
      ctx.restore();
    }
    if (ov.guides.length) {
      ctx.save(); ctx.strokeStyle = 'rgba(139,233,255,0.6)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath();
      for (const g of ov.guides) g.forEach((p, i) => { const q = v.toScreen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.stroke(); ctx.restore();
    }

    // grips: losangos num caminho só, só os que estão na tela (no máximo 2000, como o AutoCAD)
    if (ov.grips.length) {
      const diamond = (path: Path2D, q: Pt, s: number) => { const r = s * Math.SQRT2; path.moveTo(q.x, q.y - r); path.lineTo(q.x + r, q.y); path.lineTo(q.x, q.y + r); path.lineTo(q.x - r, q.y); path.closePath(); };
      const normal = new Path2D();
      let hot: Pt | null = null, drawn = 0;
      for (let i = 0; i < ov.grips.length && drawn < 2000; i++) {
        const q = v.toScreen(ov.grips[i]);
        if (q.x < -10 || q.y < -10 || q.x > v.w + 10 || q.y > v.h + 10) continue;
        if (i === ov.activeGrip) hot = q; else { diamond(normal, q, 4.5); drawn++; }
      }
      ctx.save();
      ctx.lineWidth = 1.6;
      ctx.fillStyle = '#0d0c10'; ctx.strokeStyle = '#d4ff3a'; ctx.fill(normal); ctx.stroke(normal);
      if (hot) { const h = new Path2D(); diamond(h, hot, 6); ctx.fillStyle = '#ff5a36'; ctx.strokeStyle = '#ff5a36'; ctx.fill(h); ctx.stroke(h); }
      ctx.restore();
    }

    // janela de seleção
    if (ov.window) {
      const { a, b } = ov.window;
      const crossing = b.x < a.x;
      ctx.save();
      ctx.fillStyle = crossing ? 'rgba(255,90,54,0.10)' : 'rgba(212,255,58,0.08)';
      ctx.strokeStyle = crossing ? '#ff5a36' : '#d4ff3a';
      ctx.lineWidth = 1.4;
      if (crossing) { ctx.setLineDash([6, 4]); ctx.lineDashOffset = t * 20; }
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }

    // ondas de clique
    this.ripples = this.ripples.filter((r) => now - r.t0 < 700);
    for (const r of this.ripples) {
      const k = (now - r.t0) / 700;
      const q = v.toScreen(r);
      ctx.save();
      ctx.strokeStyle = r.color; ctx.globalAlpha = (1 - k) * 0.9; ctx.lineWidth = 2 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, 6 + k * 46, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = (1 - k) * 0.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, 3 + k * 22, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // partículas de "dissolução" ao apagar
    if (this.particles.length) {
      ctx.save();
      for (const p of this.particles) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.vx *= 0.985; p.life -= 0.018;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
      ctx.restore();
      this.particles = this.particles.filter((p) => p.life > 0);
    }

    // marcador de snap
    if (ov.snap && ov.cursor) this.drawSnap(ctx, ov.snap, t);

    // cursor em mira
    if (ov.cursor && ov.showCrosshair) this.drawCursor(ctx, ov.cursor, t);
  }

  private drawSnap(ctx: CanvasRenderingContext2D, s: SnapHit, t: number) {
    const q = this.view.toScreen(s.p);
    const r = 7 + Math.sin(t * 8) * 1.2;
    ctx.save();
    ctx.strokeStyle = '#8be9ff'; ctx.lineWidth = 2;
    if (!this.lite) { ctx.shadowColor = '#8be9ff'; ctx.shadowBlur = 10; }
    ctx.beginPath();
    switch (s.kind) {
      case 'end': ctx.rect(q.x - r, q.y - r, r * 2, r * 2); break;
      case 'mid': ctx.moveTo(q.x, q.y - r); ctx.lineTo(q.x + r, q.y + r * 0.8); ctx.lineTo(q.x - r, q.y + r * 0.8); ctx.closePath(); break;
      case 'center': ctx.arc(q.x, q.y, r, 0, Math.PI * 2); break;
      case 'quad': ctx.moveTo(q.x, q.y - r); ctx.lineTo(q.x + r, q.y); ctx.lineTo(q.x, q.y + r); ctx.lineTo(q.x - r, q.y); ctx.closePath(); break;
      case 'inter': ctx.moveTo(q.x - r, q.y - r); ctx.lineTo(q.x + r, q.y + r); ctx.moveTo(q.x + r, q.y - r); ctx.lineTo(q.x - r, q.y + r); break;
      case 'near': ctx.moveTo(q.x - r, q.y - r); ctx.lineTo(q.x + r, q.y + r); ctx.lineTo(q.x - r, q.y + r); ctx.lineTo(q.x + r, q.y - r); ctx.closePath(); break;
      case 'grid': ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); break;
    }
    ctx.stroke();
    const names: Record<string, string> = { end: 'extremidade', mid: 'meio', center: 'centro', quad: 'quadrante', inter: 'interseção', near: 'próximo', grid: 'grade' };
    ctx.shadowBlur = 0;
    ctx.font = `600 10px ${TEXT_FONT}`;
    const label = names[s.kind];
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = '#8be9ff'; ctx.fillRect(q.x + 12, q.y + 10, w, 16);
    ctx.fillStyle = '#0d0c10'; ctx.fillText(label, q.x + 17, q.y + 21.5);
    ctx.restore();
  }

  private drawCursor(ctx: CanvasRenderingContext2D, c: Pt, t: number) {
    const v = this.view;
    ctx.save();
    ctx.strokeStyle = this.paper ? 'rgba(27,26,34,0.55)' : 'rgba(233,240,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, c.y + 0.5); ctx.lineTo(c.x - 14, c.y + 0.5); ctx.moveTo(c.x + 14, c.y + 0.5); ctx.lineTo(v.w, c.y + 0.5);
    ctx.moveTo(c.x + 0.5, 0); ctx.lineTo(c.x + 0.5, c.y - 14); ctx.moveTo(c.x + 0.5, c.y + 14); ctx.lineTo(c.x + 0.5, v.h);
    ctx.stroke();
    ctx.strokeStyle = '#d4ff3a'; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]); ctx.lineDashOffset = t * 12;
    ctx.beginPath(); ctx.arc(c.x, c.y, 10, t * 1.5, t * 1.5 + Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#d4ff3a'; ctx.fillRect(c.x - 1, c.y - 1, 2, 2);
    const w = this.overlay.world;
    const label = this.overlay.label ?? (w ? `${fmt(w.x)} , ${fmt(w.y)}` : '');
    if (label) {
      ctx.font = `500 11px ${TEXT_FONT}`;
      const tw = ctx.measureText(label).width + 14;
      const x = Math.min(c.x + 20, v.w - tw - 4), y = Math.max(c.y - 34, 4);
      ctx.fillStyle = 'rgba(13,12,16,0.88)'; ctx.strokeStyle = '#d4ff3a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x, y, tw, 20, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e9f0ff'; ctx.fillText(label, x + 7, y + 14);
    }
    ctx.restore();
  }
}

export const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(Math.abs(n) >= 1000 ? 1 : 2).replace('.', ',');
