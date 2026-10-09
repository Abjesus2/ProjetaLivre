import type { Entity, Pt, PolyEnt } from './types';

export const TAU = Math.PI * 2;
export const pt = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const ang = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
export const polar = (c: Pt, r: number, t: number): Pt => ({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
export const normAng = (t: number) => ((t % TAU) + TAU) % TAU;
/** varredura anti-horária de s até e, em (0, 2π] */
export const sweep = (s: number, e: number) => { const d = normAng(e - s); return d === 0 ? TAU : d; };

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export const boxValid = (b: Box) => b.minX <= b.maxX && b.minY <= b.maxY;
export function growBox(b: Box, p: Pt) {
  if (p.x < b.minX) b.minX = p.x; if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x; if (p.y > b.maxY) b.maxY = p.y;
}

// ---------- matrizes afins 2x3: [a b c d e f] → x' = a x + c y + e ; y' = b x + d y + f
export type Mat = [number, number, number, number, number, number];
export const I: Mat = [1, 0, 0, 1, 0, 0];
export const apply = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export const applyVec = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y });
export const compose = (m: Mat, n: Mat): Mat => [
  // m depois de n
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const translate = (dx: number, dy: number): Mat => [1, 0, 0, 1, dx, dy];
export const rotateAbout = (c: Pt, t: number): Mat => {
  const co = Math.cos(t), si = Math.sin(t);
  return [co, si, -si, co, c.x - co * c.x + si * c.y, c.y - si * c.x - co * c.y];
};
export const scaleAbout = (c: Pt, kx: number, ky = kx): Mat => [kx, 0, 0, ky, c.x - kx * c.x, c.y - ky * c.y];
export function mirrorAbout(a: Pt, b: Pt): Mat {
  const t = ang(a, b), co = Math.cos(2 * t), si = Math.sin(2 * t);
  // reflexão pela reta que passa pela origem com ângulo t, conjugada por translação
  const r: Mat = [co, si, si, -co, 0, 0];
  return compose(translate(a.x, a.y), compose(r, translate(-a.x, -a.y)));
}
const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];

/** Aplica uma transformação afim a uma entidade (retorna nova entidade). */
export function transformEntity<E extends Entity>(e: E, m: Mat): E {
  const k = Math.sqrt(Math.abs(det(m)));
  const flip = det(m) < 0;
  const o: any = structuredClone(e);
  switch (o.type) {
    case 'line': o.a = apply(m, o.a); o.b = apply(m, o.b); break;
    case 'point': o.p = apply(m, o.p); break;
    case 'dim': o.a = apply(m, o.a); o.b = apply(m, o.b); o.off = apply(m, o.off); if (o.h) o.h *= k; break;
    case 'circle': o.c = apply(m, o.c); o.r *= k; break;
    case 'arc': {
      const s = apply(m, polar(o.c, o.r, o.start));
      const en = apply(m, polar(o.c, o.r, o.end));
      o.c = apply(m, o.c); o.r *= k;
      const a1 = ang(o.c, s), a2 = ang(o.c, en);
      if (flip) { o.start = a2; o.end = a1; } else { o.start = a1; o.end = a2; }
      break;
    }
    case 'ellipse': {
      o.c = apply(m, o.c); o.major = applyVec(m, o.major);
      if (flip) { const s = o.start; o.start = -o.end; o.end = -s; }
      break;
    }
    case 'poly':
      o.pts = o.pts.map((p: Pt) => apply(m, p));
      if (flip && o.bulges) o.bulges = o.bulges.map((b: number) => -b);
      break;
    case 'text': {
      o.p = apply(m, o.p); o.h *= k;
      const v = applyVec(m, { x: Math.cos(o.rot), y: Math.sin(o.rot) });
      o.rot = Math.atan2(v.y, v.x);
      if (flip) o.rot += Math.PI; // mantém texto legível
      break;
    }
  }
  return o;
}

// ---------- tesselação (usada em seleção, limites e exportações vetoriais simples)
function arcPts(c: Pt, r: number, s: number, sw: number, scale = 1): Pt[] {
  const n = Math.max(8, Math.min(256, Math.ceil(Math.abs(sw) * Math.sqrt(Math.max(r * scale, 1)) * 2)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(polar(c, r, s + (sw * i) / n));
  return out;
}

export function bulgeArc(p1: Pt, p2: Pt, b: number) {
  const theta = 4 * Math.atan(b);
  const d = dist(p1, p2);
  const r = d / (2 * Math.sin(Math.abs(theta) / 2));
  const m = mid(p1, p2);
  const h = Math.sqrt(Math.max(r * r - (d * d) / 4, 0)) * Math.sign(b) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const n = { x: -(p2.y - p1.y) / d, y: (p2.x - p1.x) / d };
  const c = add(m, mul(n, h));
  return { c, r, start: ang(c, p1), sweep: theta };
}

export function polySegments(e: PolyEnt, scale = 1): Pt[] {
  const out: Pt[] = [];
  const n = e.pts.length;
  const segs = e.closed ? n : n - 1;
  if (n) out.push(e.pts[0]);
  for (let i = 0; i < segs; i++) {
    const p1 = e.pts[i], p2 = e.pts[(i + 1) % n];
    const b = e.bulges?.[i] ?? 0;
    if (Math.abs(b) > 1e-9 && dist(p1, p2) > 1e-12) {
      const a = bulgeArc(p1, p2, b);
      out.push(...arcPts(a.c, a.r, a.start, a.sweep, scale).slice(1));
    } else out.push(p2);
  }
  return out;
}

export function ellipsePoint(e: { c: Pt; major: Pt; ratio: number }, t: number): Pt {
  const minor = { x: -e.major.y * e.ratio, y: e.major.x * e.ratio };
  return { x: e.c.x + e.major.x * Math.cos(t) + minor.x * Math.sin(t), y: e.c.y + e.major.y * Math.cos(t) + minor.y * Math.sin(t) };
}

/** Lista de polilinhas que aproximam a entidade. `scale` = px por unidade (qualidade). */
export function tessellate(e: Entity, scale = 1): Pt[][] {
  switch (e.type) {
    case 'line': return [[e.a, e.b]];
    case 'circle': return [arcPts(e.c, e.r, 0, TAU, scale)];
    case 'arc': return [arcPts(e.c, e.r, e.start, sweep(e.start, e.end), scale)];
    case 'ellipse': {
      const sw = sweep(e.start, e.end);
      const R = Math.hypot(e.major.x, e.major.y);
      const n = Math.max(16, Math.min(256, Math.ceil(sw * Math.sqrt(Math.max(R * scale, 1)) * 2)));
      const out: Pt[] = [];
      for (let i = 0; i <= n; i++) out.push(ellipsePoint(e, e.start + (sw * i) / n));
      return [out];
    }
    case 'poly': return [polySegments(e, scale)];
    case 'point': return [[e.p, e.p]];
    case 'text': return [textBoxPts(e)];
    case 'dim': return dimGeometry(e).lines;
  }
}

/** altura h = altura das maiúsculas (como no AutoCAD); o corpo da fonte é h / 0.72 */
export const TEXT_EM = 1 / 0.72;
export const LINE_GAP = 1.667;
export function textWidth(t: { text: string; h: number }) { return Math.max(...t.text.split('\n').map((l) => l.length)) * t.h * TEXT_EM * 0.6; }
export function textBoxPts(t: { p: Pt; h: number; text: string; rot: number }): Pt[] {
  const w = textWidth(t), co = Math.cos(t.rot), si = Math.sin(t.rot);
  const below = -(t.text.split('\n').length - 1) * t.h * LINE_GAP - t.h * 0.25;
  const corner = (x: number, y: number) => ({ x: t.p.x + x * co - y * si, y: t.p.y + x * si + y * co });
  return [corner(0, below), corner(w, below), corner(w, t.h), corner(0, t.h), corner(0, below)];
}

/** Geometria derivada de uma cota alinhada */
export function dimGeometry(d: { a: Pt; b: Pt; off: Pt; h?: number }) {
  const L = dist(d.a, d.b) || 1e-9;
  const u = { x: (d.b.x - d.a.x) / L, y: (d.b.y - d.a.y) / L };
  const n = { x: -u.y, y: u.x };
  const h = (d.off.x - d.a.x) * n.x + (d.off.y - d.a.y) * n.y;
  const s = Math.sign(h) || 1;
  const da = add(d.a, mul(n, h)), db = add(d.b, mul(n, h));
  const textH = d.h && d.h > 0 ? d.h : Math.max(L * 0.03, 1e-6);
  const size = textH * 0.9;
  const ext = size * 0.6;
  const arrow = (p: Pt, dir: number) => {
    const back = add(p, mul(u, size * dir));
    return [add(back, mul(n, size * 0.3)), p, add(back, mul(n, -size * 0.3))];
  };
  const lines: Pt[][] = [
    [add(d.a, mul(n, s * ext * 0.3)), add(da, mul(n, s * ext))],
    [add(d.b, mul(n, s * ext * 0.3)), add(db, mul(n, s * ext))],
    [da, db], arrow(da, 1), arrow(db, -1),
  ];
  let rot = Math.atan2(u.y, u.x);
  if (rot > Math.PI / 2 + 1e-6 || rot < -Math.PI / 2 + 1e-6) rot += Math.PI;
  const label = formatLen(L);
  const tw = textWidth({ text: label, h: textH });
  const mp = mid(da, db);
  const ru = { x: Math.cos(rot), y: Math.sin(rot) }, rn = { x: -ru.y, y: ru.x };
  const textP = add(add(mp, mul(ru, -tw / 2)), mul(rn, textH * 0.35));
  return { lines, text: { p: textP, h: textH, text: label, rot }, length: L };
}

export function formatLen(v: number) {
  const r = Math.round(v * 100) / 100;
  return String(r).replace('.', ',');
}

export function entityBox(e: Entity): Box {
  const b = emptyBox();
  if (e.type === 'circle') { growBox(b, { x: e.c.x - e.r, y: e.c.y - e.r }); growBox(b, { x: e.c.x + e.r, y: e.c.y + e.r }); return b; }
  for (const path of tessellate(e)) for (const p of path) growBox(b, p);
  if (e.type === 'dim') for (const p of textBoxPts(dimGeometry(e).text)) growBox(b, p);
  return b;
}

export function drawingBox(ents: Entity[]): Box {
  const b = emptyBox();
  for (const e of ents) { const eb = entityBox(e); if (boxValid(eb)) { growBox(b, { x: eb.minX, y: eb.minY }); growBox(b, { x: eb.maxX, y: eb.maxY }); } }
  return b;
}

/** Limites ignorando objetos muito distantes (lixo comum em DWG/DXF reais). */
export function robustBox(ents: Entity[]): Box {
  const full = drawingBox(ents);
  if (ents.length < 8 || !boxValid(full)) return full;
  const boxes = ents.map(entityBox).filter(boxValid);
  const q = (arr: number[], p: number) => arr.sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
  const r = { minX: q(boxes.map((b) => b.minX), 0.02), minY: q(boxes.map((b) => b.minY), 0.02), maxX: q(boxes.map((b) => b.maxX), 0.98), maxY: q(boxes.map((b) => b.maxY), 0.98) };
  const rw = Math.max(r.maxX - r.minX, 1e-9), rh = Math.max(r.maxY - r.minY, 1e-9);
  if (full.maxX - full.minX < rw * 8 && full.maxY - full.minY < rh * 8) return full;
  const m = Math.max(rw, rh);
  const out = emptyBox();
  for (const b of boxes) {
    if (b.minX < r.minX - m || b.maxX > r.maxX + m || b.minY < r.minY - m || b.maxY > r.maxY + m) continue;
    growBox(out, { x: b.minX, y: b.minY }); growBox(out, { x: b.maxX, y: b.maxY });
  }
  return boxValid(out) ? out : full;
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export function distToEntity(e: Entity, p: Pt, scale: number): number {
  if (e.type === 'circle') return Math.abs(dist(p, e.c) - e.r);
  if (e.type === 'text') {
    const box = textBoxPts(e);
    if (pointInPoly(p, box)) return 0;
  }
  let best = Infinity;
  for (const path of tessellate(e, scale)) {
    if (path.length === 1) best = Math.min(best, dist(p, path[0]));
    for (let i = 0; i < path.length - 1; i++) best = Math.min(best, distToSeg(p, path[i], path[i + 1]));
  }
  if (e.type === 'dim') {
    const tb = textBoxPts(dimGeometry(e).text);
    if (pointInPoly(p, tb)) return 0;
  }
  return best;
}

export function pointInPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** interseção de segmentos; retorna parâmetro t no primeiro e o ponto */
export function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number; p: Pt } | null {
  const r = sub(b, a), s = sub(d, c);
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const q = sub(c, a);
  const t = (q.x * s.y - q.y * s.x) / den;
  const u = (q.x * r.y - q.y * r.x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u, p: add(a, mul(r, t)) };
}

export function segBoxHit(a: Pt, b: Pt, box: Box) {
  const inside = (p: Pt) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
  if (inside(a) || inside(b)) return true;
  const c = [pt(box.minX, box.minY), pt(box.maxX, box.minY), pt(box.maxX, box.maxY), pt(box.minX, box.maxY)];
  for (let i = 0; i < 4; i++) if (segIntersect(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

/** Comprimento total aproximado */
export function entityLength(e: Entity): number {
  if (e.type === 'circle') return TAU * e.r;
  if (e.type === 'arc') return e.r * sweep(e.start, e.end);
  if (e.type === 'text' || e.type === 'point') return 0;
  let L = 0;
  for (const path of tessellate(e, 50)) for (let i = 0; i < path.length - 1; i++) L += dist(path[i], path[i + 1]);
  return L;
}

export function polyArea(pts: Pt[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}
