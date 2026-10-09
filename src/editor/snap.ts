import type { Entity, Pt } from '../core/types';
import { dist, mid, polar, ellipsePoint, sweep, closestOnSeg, tessellate, dimGeometry } from '../core/geom';
import { intersectEntities } from './intersect';
import type { SnapHit, SnapKind } from '../render/renderer';
import { cachedBox } from '../render/renderer';

export interface SnapSettings {
  osnap: boolean;
  grid: boolean;
  gridStep: number;
  kinds: Record<Exclude<SnapKind, 'grid'>, boolean>;
}

export function snapPoints(e: Entity): { p: Pt; kind: SnapKind }[] {
  const out: { p: Pt; kind: SnapKind }[] = [];
  switch (e.type) {
    case 'line': out.push({ p: e.a, kind: 'end' }, { p: e.b, kind: 'end' }, { p: mid(e.a, e.b), kind: 'mid' }); break;
    case 'circle':
      out.push({ p: e.c, kind: 'center' });
      for (let i = 0; i < 4; i++) out.push({ p: polar(e.c, e.r, (i * Math.PI) / 2), kind: 'quad' });
      break;
    case 'arc': {
      const sw = sweep(e.start, e.end);
      out.push({ p: e.c, kind: 'center' }, { p: polar(e.c, e.r, e.start), kind: 'end' }, { p: polar(e.c, e.r, e.end), kind: 'end' }, { p: polar(e.c, e.r, e.start + sw / 2), kind: 'mid' });
      break;
    }
    case 'ellipse':
      out.push({ p: e.c, kind: 'center' });
      for (let i = 0; i < 4; i++) out.push({ p: ellipsePoint(e, (i * Math.PI) / 2), kind: 'quad' });
      break;
    case 'poly': {
      const n = e.pts.length;
      e.pts.forEach((p) => out.push({ p, kind: 'end' }));
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) if (!e.bulges?.[i]) out.push({ p: mid(e.pts[i], e.pts[(i + 1) % n]), kind: 'mid' });
      break;
    }
    case 'point': out.push({ p: e.p, kind: 'end' }); break;
    case 'text': out.push({ p: e.p, kind: 'end' }); break;
    case 'dim': {
      const g = dimGeometry(e);
      out.push({ p: e.a, kind: 'end' }, { p: e.b, kind: 'end' }, { p: g.lines[2][0], kind: 'end' }, { p: g.lines[2][1], kind: 'end' });
      break;
    }
  }
  return out;
}

export function findSnap(ents: Entity[], p: Pt, scale: number, st: SnapSettings, exclude?: Set<string>): SnapHit | null {
  const tol = 14 / scale;
  let best: SnapHit | null = null, bd = tol;
  const near: Entity[] = [];
  if (st.osnap) {
    for (const e of ents) {
      if (exclude?.has(e.id)) continue;
      const b = cachedBox(e);
      if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue;
      near.push(e);
      for (const s of snapPoints(e)) {
        if (!st.kinds[s.kind as keyof SnapSettings['kinds']]) continue;
        const d = dist(s.p, p);
        if (d < bd) { bd = d; best = { p: s.p, kind: s.kind }; }
      }
    }
    if (st.kinds.inter && near.length > 1 && near.length < 60) {
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        for (const q of intersectEntities(near[i], near[j])) {
          const d = dist(q, p);
          if (d < bd) { bd = d; best = { p: q, kind: 'inter' }; }
        }
      }
    }
    if (!best && st.kinds.near) {
      let nd = tol * 0.7;
      for (const e of near) for (const path of tessellate(e, scale)) for (let i = 0; i < path.length - 1; i++) {
        const q = closestOnSeg(p, path[i], path[i + 1]);
        const d = dist(q, p);
        if (d < nd) { nd = d; best = { p: q, kind: 'near' }; }
      }
    }
  }
  if (!best && st.grid) {
    const g = st.gridStep;
    best = { p: { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }, kind: 'grid' };
  }
  return best;
}
