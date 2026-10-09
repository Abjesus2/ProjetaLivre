import type { Entity, NewEntity, Pt } from '../core/types';
import type { Box } from '../core/geom';
import { entityBox, tessellate, dist } from '../core/geom';
import type { Doc } from '../core/doc';
import { View } from './view';
import { pathEntity, TEXT_FONT } from './draw';

export type SnapKind = 'end' | 'mid' | 'center' | 'quad' | 'inter' | 'near' | 'grid';
export interface SnapHit { p: Pt; kind: SnapKind }

export interface Overlay {
  cursor: Pt | null;           // posição em tela
  world: Pt | null;            // posição no mundo (já com snap)
  snap: SnapHit | null;
  selection: Set<string>;
  hover: string | null;
  preview: NewEntity[];
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
export const cachedBox = (e: Entity) => { let b = boxCache.get(e); if (!b) { b = entityBox(e); boxCache.set(e, b); } return b; };

export class Renderer {
  ctx: CanvasRenderingContext2D;
  staticCanvas = document.createElement('canvas');
  sctx: CanvasRenderingContext2D;
  dpr = 1;
  dirty = true;
  paper = false;
  showGrid = true;
  private ripples: Ripple[] = [];
  private particles: Particle[] = [];
  private births = new Map<string, number>();
  private start = performance.now();

  constructor(public canvas: HTMLCanvasElement, public view: View, public doc: Doc, public overlay: Overlay) {
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.staticCanvas.getContext('2d')!;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.staticCanvas]) { c.width = Math.max(1, r.width * this.dpr); c.height = Math.max(1, r.height * this.dpr); }
    this.view.w = r.width; this.view.h = r.height; this.view.version++;
    this.dirty = true;
  }

  ripple(p: Pt, color = '#d4ff3a') { this.ripples.push({ x: p.x, y: p.y, t0: performance.now(), color }); }
  born(id: string) { this.births.set(id, performance.now()); this.dirty = true; }
  dissolve(ents: Entity[]) {
    for (const e of ents) {
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
  }

  get ink() { return this.paper ? '#1b1a22' : '#e9f0ff'; }

  private colorFor(e: Entity) {
    const c = this.doc.colorOf(e);
    if (!this.paper) return c;
    const n = parseInt(c.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 200 ? '#1b1a22' : c;
  }

  private renderStatic() {
    const ctx = this.sctx, v = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    if (this.showGrid) this.drawGrid(ctx);
    this.drawAxes(ctx);
    const wb = v.worldBox();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // agrupa por cor para reduzir trocas de estado
    const groups = new Map<string, Entity[]>();
    for (const e of this.doc.d.entities) {
      if (!this.doc.isVisible(e)) continue;
      if (this.overlay.selection.has(e.id) || this.births.has(e.id)) continue;
      const b = cachedBox(e);
      if (b.maxX < wb.minX || b.minX > wb.maxX || b.maxY < wb.minY || b.minY > wb.maxY) continue;
      const c = this.colorFor(e);
      let g = groups.get(c); if (!g) groups.set(c, (g = [])); g.push(e);
    }
    ctx.lineWidth = 1.25;
    for (const [c, list] of groups) {
      ctx.strokeStyle = c;
      ctx.beginPath();
      for (const e of list) pathEntity(ctx, e, v, c);
      ctx.stroke();
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D) {
    const v = this.view;
    let step = Math.pow(10, Math.floor(Math.log10(40 / v.s)));
    while (step * v.s < 18) step *= step.toString().startsWith('2') ? 2.5 : 2;
    const wb = v.worldBox();
    const x0 = Math.floor(wb.minX / step) * step, y0 = Math.floor(wb.minY / step) * step;
    const major = step * 5;
    const dot = this.paper ? 'rgba(27,26,34,0.22)' : 'rgba(233,240,255,0.16)';
    const big = this.paper ? 'rgba(27,26,34,0.45)' : 'rgba(212,255,58,0.42)';
    for (let x = x0; x <= wb.maxX; x += step) {
      for (let y = y0; y <= wb.maxY; y += step) {
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

  frame() {
    const now = performance.now();
    const ctx = this.ctx, v = this.view, ov = this.overlay;
    if (this.dirty) { this.renderStatic(); this.dirty = false; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const t = (now - this.start) / 1000;

    // entidades recém-nascidas: animação de "tinta" percorrendo o traço
    for (const [id, t0] of this.births) {
      const e = this.doc.byId(id);
      const k = Math.min(1, (now - t0) / 520);
      if (!e || k >= 1 || ov.selection.has(id)) { this.births.delete(id); this.dirty = true; continue; }
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

    // selecionadas: brilho pulsante + tracejado correndo
    if (ov.selection.size) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]); ctx.lineDashOffset = -t * 30;
      ctx.shadowColor = '#d4ff3a'; ctx.shadowBlur = 8 + Math.sin(t * 4) * 4;
      ctx.strokeStyle = '#d4ff3a';
      ctx.beginPath();
      for (const id of ov.selection) { const e = this.doc.byId(id); if (e) pathEntity(ctx, e, v, '#d4ff3a'); }
      ctx.stroke();
      ctx.restore();
    }

    // destaque ao passar o mouse
    if (ov.hover && !ov.selection.has(ov.hover)) {
      const e = this.doc.byId(ov.hover);
      if (e) {
        const c = this.colorFor(e);
        ctx.save(); ctx.lineWidth = 3.2; ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 14;
        ctx.beginPath(); pathEntity(ctx, e, v, c); ctx.stroke(); ctx.restore();
      }
    }

    // pré-visualização da ferramenta ativa
    if (ov.preview.length) {
      ctx.save();
      ctx.strokeStyle = '#ff5a36'; ctx.lineWidth = 1.6; ctx.setLineDash([10, 6]); ctx.lineDashOffset = -t * 40;
      ctx.shadowColor = '#ff5a36'; ctx.shadowBlur = 10;
      ctx.beginPath();
      for (const e of ov.preview) pathEntity(ctx, e as Entity, v, '#ff5a36');
      ctx.stroke();
      ctx.restore();
    }
    if (ov.guides.length) {
      ctx.save(); ctx.strokeStyle = 'rgba(139,233,255,0.6)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath();
      for (const g of ov.guides) g.forEach((p, i) => { const q = v.toScreen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.stroke(); ctx.restore();
    }

    // grips
    ov.grips.forEach((g, i) => {
      const q = v.toScreen(g);
      const hot = i === ov.activeGrip;
      ctx.save();
      ctx.translate(q.x, q.y); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = hot ? '#ff5a36' : '#0d0c10'; ctx.strokeStyle = hot ? '#ff5a36' : '#d4ff3a'; ctx.lineWidth = 1.6;
      const s = hot ? 6 : 4.5;
      ctx.fillRect(-s, -s, s * 2, s * 2); ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    });

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
    ctx.strokeStyle = '#8be9ff'; ctx.lineWidth = 2; ctx.shadowColor = '#8be9ff'; ctx.shadowBlur = 10;
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
