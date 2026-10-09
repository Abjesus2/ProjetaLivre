import type { Entity, Pt } from '../core/types';
import { dimGeometry, polySegments, sweep, TEXT_EM, LINE_GAP } from '../core/geom';
import type { View } from './view';

export const TEXT_FONT = '"JetBrains Mono", ui-monospace, monospace';

/** Traça o caminho de uma entidade no contexto (sem stroke). Textos são desenhados aqui mesmo. */
export function pathEntity(ctx: CanvasRenderingContext2D, e: Entity, v: View, color: string) {
  const S = (p: Pt) => v.toScreen(p);
  switch (e.type) {
    case 'line': { const a = S(e.a), b = S(e.b); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); break; }
    case 'circle': { const c = S(e.c); ctx.moveTo(c.x + e.r * v.s, c.y); ctx.arc(c.x, c.y, e.r * v.s, 0, Math.PI * 2); break; }
    case 'arc': {
      const c = S(e.c), sw = sweep(e.start, e.end);
      const r = e.r * v.s;
      ctx.moveTo(c.x + r * Math.cos(-e.start), c.y + r * Math.sin(-e.start));
      ctx.arc(c.x, c.y, r, -e.start, -(e.start + sw), true);
      break;
    }
    case 'ellipse': {
      const c = S(e.c), R = Math.hypot(e.major.x, e.major.y) * v.s;
      const rot = -Math.atan2(e.major.y, e.major.x);
      const sw = sweep(e.start, e.end);
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(rot);
      ctx.moveTo(R * Math.cos(-e.start), R * e.ratio * Math.sin(-e.start));
      ctx.restore();
      ctx.ellipse(c.x, c.y, R, Math.max(R * e.ratio, 0.01), rot, -e.start, -(e.start + sw), true);
      break;
    }
    case 'poly': {
      const pts = e.bulges?.some((b) => b) ? polySegments(e, v.s) : e.pts;
      pts.forEach((p, i) => { const q = S(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      if (e.closed && pts === e.pts && pts.length > 1) ctx.closePath();
      break;
    }
    case 'point': { const p = S(e.p); ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + 4); break; }
    case 'text': drawText(ctx, e.p, e.h, e.text, e.rot, v, color); break;
    case 'dim': {
      const g = dimGeometry(e);
      for (const l of g.lines) l.forEach((p, i) => { const q = S(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      drawText(ctx, g.text.p, g.text.h, g.text.text, g.text.rot, v, color);
      break;
    }
  }
}

export function drawText(ctx: CanvasRenderingContext2D, p: Pt, h: number, text: string, rot: number, v: View, color: string) {
  const px = h * v.s * TEXT_EM;
  if (px < 1.5) return;
  const q = v.toScreen(p);
  ctx.save();
  ctx.translate(q.x, q.y);
  ctx.rotate(-rot);
  ctx.font = `${px}px ${TEXT_FONT}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  const lines = text.split('\n');
  lines.forEach((ln, i) => ctx.fillText(ln, 0, i * h * v.s * LINE_GAP));
  ctx.restore();
}
