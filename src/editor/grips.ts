import type { Entity, Pt } from '../core/types';
import { ang, dist, ellipsePoint, mid, polar, sub, sweep, transformEntity, translate } from '../core/geom';

export interface Grip { p: Pt; apply: (p: Pt) => Entity }

/** Pontos de controle ("grips") de cada entidade e como cada um a altera. */
export function gripsOf(e: Entity): Grip[] {
  const move = (from: Pt) => (p: Pt) => transformEntity(e, translate(p.x - from.x, p.y - from.y));
  switch (e.type) {
    case 'line':
      return [
        { p: e.a, apply: (p) => ({ ...e, a: p }) },
        { p: mid(e.a, e.b), apply: move(mid(e.a, e.b)) },
        { p: e.b, apply: (p) => ({ ...e, b: p }) },
      ];
    case 'circle':
      return [
        { p: e.c, apply: move(e.c) },
        ...[0, 1, 2, 3].map((i) => ({ p: polar(e.c, e.r, (i * Math.PI) / 2), apply: (p: Pt) => ({ ...e, r: Math.max(dist(e.c, p), 1e-9) }) })),
      ];
    case 'arc': {
      const sw = sweep(e.start, e.end);
      return [
        { p: e.c, apply: move(e.c) },
        { p: polar(e.c, e.r, e.start), apply: (p) => ({ ...e, start: ang(e.c, p) }) },
        { p: polar(e.c, e.r, e.start + sw / 2), apply: (p) => ({ ...e, r: Math.max(dist(e.c, p), 1e-9) }) },
        { p: polar(e.c, e.r, e.end), apply: (p) => ({ ...e, end: ang(e.c, p) }) },
      ];
    }
    case 'ellipse':
      return [
        { p: e.c, apply: move(e.c) },
        { p: ellipsePoint(e, 0), apply: (p) => ({ ...e, major: sub(p, e.c) }) },
        { p: ellipsePoint(e, Math.PI / 2), apply: (p) => ({ ...e, ratio: Math.max(dist(e.c, p) / Math.hypot(e.major.x, e.major.y), 1e-3) }) },
      ];
    case 'poly':
      return e.pts.map((v, i) => ({ p: v, apply: (p: Pt) => ({ ...e, pts: e.pts.map((q, j) => (j === i ? p : q)) }) }));
    case 'text': return [{ p: e.p, apply: (p) => ({ ...e, p }) }];
    case 'hatch': return [];
    case 'point': return [{ p: e.p, apply: (p) => ({ ...e, p }) }];
    case 'dim':
      return [
        { p: e.a, apply: (p) => ({ ...e, a: p }) },
        { p: e.b, apply: (p) => ({ ...e, b: p }) },
        { p: e.off, apply: (p) => ({ ...e, off: p }) },
      ];
  }
}

