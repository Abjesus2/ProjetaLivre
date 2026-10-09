import type { Entity, HatchEnt, Pt } from '../core/types';
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
    case 'hatch':
      for (const l of e.loops) { l.forEach((p, i) => { const q = S(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); if (l.length) ctx.closePath(); }
      break;
  }
}

/** Preenche uma hachura: sólida, ou com as linhas do padrão recortadas pelo contorno. */
export function fillHatch(ctx: CanvasRenderingContext2D, e: HatchEnt, v: View, color: string) {
  const path = new Path2D();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of e.loops) {
    l.forEach((p, i) => {
      const q = v.toScreen(p);
      if (i) path.lineTo(q.x, q.y); else path.moveTo(q.x, q.y);
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    });
    path.closePath();
  }
  if (!isFinite(minX)) return;
  ctx.save();
  ctx.fillStyle = color;
  // espaçamento das linhas do padrão, em pixels
  const lines = (e.pattern ?? []).map((d) => {
    const dir = { x: Math.cos(d.angle), y: Math.sin(d.angle) };
    const gap = Math.abs(d.offset.x * -dir.y + d.offset.y * dir.x) * v.s;
    return { d, dir, gap };
  }).filter((l) => l.gap > 0);
  if (e.solid || !lines.length || lines.some((l) => l.gap < 3)) {
    ctx.globalAlpha = e.solid ? 0.55 : 0.16;
    ctx.fill(path, 'evenodd');
    ctx.restore();
    return;
  }
  ctx.clip(path, 'evenodd');
  ctx.strokeStyle = color; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.85;
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  ctx.beginPath();
  for (const { d, dir, gap } of lines) {
    // direção na tela (y invertido) e normal
    const sd = { x: dir.x, y: -dir.y }, sn = { x: -sd.y, y: sd.x };
    const b = v.toScreen(d.base);
    // distância do centro da área até a linha-base, ao longo da normal
    const c0 = (cx - b.x) * sn.x + (cy - b.y) * sn.y;
    const k0 = Math.floor((c0 - diag / 2) / gap), k1 = Math.ceil((c0 + diag / 2) / gap);
    if (k1 - k0 > 3000) continue;
    for (let k = k0; k <= k1; k++) {
      const px = b.x + sn.x * k * gap, py = b.y + sn.y * k * gap;
      const t = (cx - px) * sd.x + (cy - py) * sd.y;
      ctx.moveTo(px + sd.x * (t - diag), py + sd.y * (t - diag));
      ctx.lineTo(px + sd.x * (t + diag), py + sd.y * (t + diag));
    }
  }
  ctx.stroke();
  ctx.restore();
}

export function drawText(ctx: CanvasRenderingContext2D, p: Pt, h: number, text: string, rot: number, v: View, color: string) {
  const px = h * v.s * TEXT_EM;
  const q = v.toScreen(p);
  if (px < 1.5) {
    // texto pequeno demais para ler: mostra só um traço no lugar (como o AutoCAD faz)
    if (px < 0.35) return;
    const w = text.split('\n')[0].length * px * 0.6;
    ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(-rot);
    ctx.fillStyle = color; ctx.globalAlpha = 0.45; ctx.fillRect(0, -px * 0.6, Math.max(w, 1), Math.max(px * 0.6, 0.6));
    ctx.restore();
    return;
  }
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
