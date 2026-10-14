import type { Entity, NewEntity, Pt } from '../core/types';
import { add, ang, bulgeArc, closestOnSeg, dimGeometry, dist, mul, normAng, polar, sub, sweep, TAU } from '../core/geom';
import { primsOf, intersectPrims } from './intersect';

const strip = <T extends Entity>(e: T): Omit<T, 'id'> => { const { id: _id, ...rest } = e; return rest; };

// ---------------------------------------------------------------- deslocamento (offset)
function lineOffset(a: Pt, b: Pt, d: number): [Pt, Pt] {
  const L = dist(a, b) || 1;
  const n = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L };
  return [add(a, mul(n, d)), add(b, mul(n, d))];
}
function lineLine(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = sub(b, a), s = sub(d, c), den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return add(a, mul(r, t));
}
const sideOf = (a: Pt, b: Pt, p: Pt) => Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) || 1;

export function offsetEntity(e: Entity, d: number, side: Pt): NewEntity | null {
  switch (e.type) {
    case 'line': {
      const [a, b] = lineOffset(e.a, e.b, d * sideOf(e.a, e.b, side));
      return { ...strip(e), a, b };
    }
    case 'circle': case 'arc': {
      const r = dist(side, e.c) < e.r ? e.r - d : e.r + d;
      if (r <= 1e-9) return null;
      return { ...strip(e), r } as NewEntity;
    }
    case 'poly': {
      if (e.bulges?.some((b) => b) || e.pts.length < 2) return null;
      const n = e.pts.length, segs = e.closed ? n : n - 1;
      // lado definido pelo segmento mais próximo do clique
      let bi = 0, bd = Infinity;
      for (let i = 0; i < segs; i++) { const q = closestOnSeg(side, e.pts[i], e.pts[(i + 1) % n]); const dd = dist(q, side); if (dd < bd) { bd = dd; bi = i; } }
      const sgn = sideOf(e.pts[bi], e.pts[(bi + 1) % n], side);
      const offs: [Pt, Pt][] = [];
      for (let i = 0; i < segs; i++) offs.push(lineOffset(e.pts[i], e.pts[(i + 1) % n], d * sgn));
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const prev = e.closed ? offs[(i - 1 + segs) % segs] : offs[i - 1];
        const next = offs[i] ?? null;
        if (prev && next) pts.push(lineLine(prev[0], prev[1], next[0], next[1]) ?? next[0]);
        else if (next) pts.push(next[0]);
        else if (prev) pts.push(prev[1]);
      }
      return { ...strip(e), pts };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- aparar (trim)
function cutsOn(target: Entity, cutters: Entity[]): Pt[] {
  const tp = primsOf(target);
  const out: Pt[] = [];
  for (const c of cutters) {
    if (c.id === target.id) continue;
    for (const q of primsOf(c)) for (const p of tp) out.push(...intersectPrims(p, q));
  }
  return out;
}

/** Retorna as partes que permanecem (vazio = apagar), ou null se não há o que aparar. */
export function trimEntity(e: Entity, click: Pt, cutters: Entity[]): NewEntity[] | null {
  const pts = cutsOn(e, cutters);
  const eps = 1e-7;
  switch (e.type) {
    case 'line': {
      const L2 = (e.b.x - e.a.x) ** 2 + (e.b.y - e.a.y) ** 2;
      const par = (p: Pt) => ((p.x - e.a.x) * (e.b.x - e.a.x) + (p.y - e.a.y) * (e.b.y - e.a.y)) / L2;
      const ts = pts.map(par).filter((t) => t > eps && t < 1 - eps);
      if (!ts.length) return null;
      const tc = par(click);
      const lo = Math.max(0, ...ts.filter((t) => t < tc)), hi = Math.min(1, ...ts.filter((t) => t > tc));
      const at = (t: number) => ({ x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t });
      const out: NewEntity[] = [];
      if (lo > eps) out.push({ ...strip(e), a: e.a, b: at(lo) });
      if (hi < 1 - eps) out.push({ ...strip(e), a: at(hi), b: e.b });
      return out;
    }
    case 'circle': {
      const as = [...new Set(pts.map((p) => +normAng(ang(e.c, p)).toFixed(9)))].sort((a, b) => a - b);
      if (as.length < 2) return null;
      const ac = normAng(ang(e.c, click));
      let lo = as[as.length - 1], hi = as[0];
      for (const a of as) { if (a < ac) lo = a; }
      for (const a of [...as].reverse()) { if (a > ac) hi = a; }
      return [{ type: 'arc', layer: e.layer, color: e.color, c: e.c, r: e.r, start: hi, end: lo }];
    }
    case 'arc': {
      const sw = sweep(e.start, e.end);
      const us = pts.map((p) => normAng(ang(e.c, p) - e.start)).filter((u) => u > eps && u < sw - eps);
      if (!us.length) return null;
      const uc = normAng(ang(e.c, click) - e.start);
      const lo = Math.max(0, ...us.filter((u) => u < uc)), hi = Math.min(sw, ...us.filter((u) => u > uc));
      const out: NewEntity[] = [];
      if (lo > eps) out.push({ ...strip(e), start: e.start, end: e.start + lo });
      if (hi < sw - eps) out.push({ ...strip(e), start: e.start + hi, end: e.end });
      return out;
    }
    case 'poly': {
      if (e.bulges?.some((b) => b)) return null;
      const n = e.pts.length, N = e.closed ? n : n - 1;
      const segPar = (p: Pt) => {
        let best = 0, bd = Infinity;
        for (let i = 0; i < N; i++) {
          const a = e.pts[i], b = e.pts[(i + 1) % n];
          const q = closestOnSeg(p, a, b), d = dist(q, p);
          if (d < bd) { bd = d; const L = dist(a, b); best = i + (L ? dist(a, q) / L : 0); }
        }
        return best;
      };
      const ps = [...new Set(pts.map((p) => +segPar(p).toFixed(9)))].filter((u) => u > eps && u < N - eps).sort((a, b) => a - b);
      const pc = segPar(click);
      const at = (u: number) => { const i = Math.min(Math.floor(u), N - 1), t = u - i; const a = e.pts[i], b = e.pts[(i + 1) % n]; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; };
      const range = (u0: number, u1: number): Pt[] => {
        // u1 pode passar de N (polilinha fechada, volta pelo início)
        const out = [at(u0 % N)];
        for (let k = Math.floor(u0) + 1; k < u1; k++) out.push(e.pts[k % n]);
        out.push(at(u1 > N ? u1 - N : u1));
        return out;
      };
      if (!e.closed) {
        if (!ps.length) return null;
        const lo = Math.max(0, ...ps.filter((u) => u < pc)), hi = Math.min(N, ...ps.filter((u) => u > pc));
        const out: NewEntity[] = [];
        if (lo > eps) out.push({ ...strip(e), closed: false, pts: range(0, lo), bulges: undefined });
        if (hi < N - eps) out.push({ ...strip(e), closed: false, pts: range(hi, N), bulges: undefined });
        return out;
      }
      if (ps.length < 2) return null;
      let lo = ps[ps.length - 1] - N, hi = ps[0];
      for (const u of ps) if (u < pc) lo = u;
      for (const u of [...ps].reverse()) if (u > pc) hi = u;
      if (lo < 0) lo += N;
      const end = lo < hi ? lo + N : lo;
      return [{ ...strip(e), closed: false, pts: range(hi, end), bulges: undefined }];
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- explodir
export function explodeEntity(e: Entity): NewEntity[] | null {
  const base = { layer: e.layer, color: e.color };
  if (e.type === 'poly') {
    const out: NewEntity[] = [], n = e.pts.length, segs = e.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = e.pts[i], b = e.pts[(i + 1) % n], bu = e.bulges?.[i] ?? 0;
      if (Math.abs(bu) > 1e-9) {
        const ar = bulgeArc(a, b, bu);
        const s = ar.start, en = ar.start + ar.sweep;
        out.push({ type: 'arc', ...base, c: ar.c, r: ar.r, start: ar.sweep > 0 ? s : en, end: ar.sweep > 0 ? en : s });
      } else out.push({ type: 'line', ...base, a, b });
    }
    return out;
  }
  if (e.type === 'dim') {
    const g = dimGeometry(e);
    const out: NewEntity[] = g.lines.map((l) => ({ type: 'poly', ...base, pts: l, closed: false }) as NewEntity);
    out.push({ type: 'text', ...base, ...g.text });
    return out;
  }
  if (e.type === 'hatch') return e.loops.filter((l) => l.length > 1).map((pts) => ({ type: 'poly', ...base, pts, closed: true }) as NewEntity);
  return null;
}

/** Arco por 3 pontos */
export function arc3(p1: Pt, p2: Pt, p3: Pt): { c: Pt; r: number; start: number; end: number } | null {
  const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(d) < 1e-12) return null;
  const s1 = p1.x ** 2 + p1.y ** 2, s2 = p2.x ** 2 + p2.y ** 2, s3 = p3.x ** 2 + p3.y ** 2;
  const c = { x: (s1 * (p2.y - p3.y) + s2 * (p3.y - p1.y) + s3 * (p1.y - p2.y)) / d, y: (s1 * (p3.x - p2.x) + s2 * (p1.x - p3.x) + s3 * (p2.x - p1.x)) / d };
  const r = dist(c, p1);
  const a1 = ang(c, p1), a3 = ang(c, p3);
  const ccw = d > 0;
  return ccw ? { c, r, start: a1, end: a3 } : { c, r, start: a3, end: a1 };
}

export function regularPolygon(c: Pt, corner: Pt, sides: number): Pt[] {
  const r = dist(c, corner), a0 = ang(c, corner);
  return Array.from({ length: sides }, (_, i) => polar(c, r, a0 + (i * TAU) / sides));
}
