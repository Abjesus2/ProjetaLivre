import type { Entity, Pt } from '../core/types';
import { TAU, bulgeArc, normAng, segIntersect, sweep, tessellate, dimGeometry } from '../core/geom';

export type Prim = { k: 'seg'; a: Pt; b: Pt } | { k: 'arc'; c: Pt; r: number; s: number; sw: number };

/** Decompõe a entidade em segmentos e arcos exatos (base para interseções). */
export function entityPrims(e: Entity): Prim[] {
  switch (e.type) {
    case 'line': return [{ k: 'seg', a: e.a, b: e.b }];
    case 'circle': return [{ k: 'arc', c: e.c, r: e.r, s: 0, sw: TAU }];
    case 'arc': return [{ k: 'arc', c: e.c, r: e.r, s: e.start, sw: sweep(e.start, e.end) }];
    case 'poly': {
      const out: Prim[] = [], n = e.pts.length;
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n], bu = e.bulges?.[i] ?? 0;
        if (Math.abs(bu) > 1e-9) {
          const ar = bulgeArc(a, b, bu);
          out.push(ar.sweep >= 0 ? { k: 'arc', c: ar.c, r: ar.r, s: ar.start, sw: ar.sweep } : { k: 'arc', c: ar.c, r: ar.r, s: ar.start + ar.sweep, sw: -ar.sweep });
        } else out.push({ k: 'seg', a, b });
      }
      return out;
    }
    case 'ellipse': return segsOf(tessellate(e, 40));
    case 'dim': return segsOf(dimGeometry(e).lines);
    default: return [];
  }
}

const segsOf = (paths: Pt[][]): Prim[] => {
  const out: Prim[] = [];
  for (const p of paths) for (let i = 0; i < p.length - 1; i++) out.push({ k: 'seg', a: p[i], b: p[i + 1] });
  return out;
};

export const inArc = (t: number, s: number, sw: number) => sw >= TAU - 1e-9 || normAng(t - s) <= sw + 1e-9;

function segArc(a: Pt, b: Pt, c: Pt, r: number, s: number, sw: number): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (A < 1e-18 || disc < 0) return [];
  const sq = Math.sqrt(disc), out: Pt[] = [];
  for (const t of disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    if (inArc(Math.atan2(p.y - c.y, p.x - c.x), s, sw)) out.push(p);
  }
  return out;
}

function arcArc(p: Prim & { k: 'arc' }, q: Prim & { k: 'arc' }): Pt[] {
  const dx = q.c.x - p.c.x, dy = q.c.y - p.c.y, d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > p.r + q.r + 1e-9 || d < Math.abs(p.r - q.r) - 1e-9) return [];
  const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(p.r * p.r - a * a, 0));
  const mx = p.c.x + (a * dx) / d, my = p.c.y + (a * dy) / d;
  const pts = h < 1e-12 ? [{ x: mx, y: my }] : [{ x: mx + (h * dy) / d, y: my - (h * dx) / d }, { x: mx - (h * dy) / d, y: my + (h * dx) / d }];
  return pts.filter((z) => inArc(Math.atan2(z.y - p.c.y, z.x - p.c.x), p.s, p.sw) && inArc(Math.atan2(z.y - q.c.y, z.x - q.c.x), q.s, q.sw));
}

export function intersectPrims(p: Prim, q: Prim): Pt[] {
  if (p.k === 'seg' && q.k === 'seg') { const r = segIntersect(p.a, p.b, q.a, q.b); return r ? [r.p] : []; }
  if (p.k === 'seg' && q.k === 'arc') return segArc(p.a, p.b, q.c, q.r, q.s, q.sw);
  if (p.k === 'arc' && q.k === 'seg') return segArc(q.a, q.b, p.c, p.r, p.s, p.sw);
  return arcArc(p as any, q as any);
}

const primCache = new WeakMap<Entity, Prim[]>();
/** primitivas da entidade, guardadas (as entidades nunca mudam no lugar) */
export function primsOf(e: Entity): Prim[] {
  let p = primCache.get(e);
  if (!p) { p = entityPrims(e); primCache.set(e, p); }
  return p;
}

/** a primitiva passa a no máximo `tol` do ponto? (interseções mais longe que isso não interessam) */
export function primNear(q: Prim, p: Pt, tol: number): boolean {
  if (q.k === 'arc') return Math.abs(Math.hypot(p.x - q.c.x, p.y - q.c.y) - q.r) <= tol;
  const minX = Math.min(q.a.x, q.b.x) - tol, maxX = Math.max(q.a.x, q.b.x) + tol;
  const minY = Math.min(q.a.y, q.b.y) - tol, maxY = Math.max(q.a.y, q.b.y) + tol;
  if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
  const dx = q.b.x - q.a.x, dy = q.b.y - q.a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - q.a.x) * dx + (p.y - q.a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (q.a.x + t * dx), p.y - (q.a.y + t * dy)) <= tol;
}

export function intersectEntities(e1: Entity, e2: Entity): Pt[] {
  const out: Pt[] = [];
  const P = primsOf(e1), Q = primsOf(e2);
  if (P.length * Q.length > 20000) return out;
  for (const p of P) for (const q of Q) out.push(...intersectPrims(p, q));
  return out;
}
