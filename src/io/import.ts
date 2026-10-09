import type { Drawing, Entity, Layer, NewEntity, Pt } from '../core/types';
import { uid } from '../core/types';
import { aciToHex, rgbIntToHex } from '../core/aci';
import { compose, rotateAbout, scaleAbout, transformEntity, translate, textWidth, LINE_GAP, type Mat, I } from '../core/geom';
import { newDrawing, PALETTE } from '../core/doc';

const TEXT_EM_SVG = 1 / 0.72;
export const OPEN_ACCEPT = '.dwg,.dxf,.svg,.plv,.json';

/** Estrutura intermediária no formato do dxf-parser (o DWG é adaptado para ela). */
interface RawLayer { name: string; color?: string; visible: boolean; locked?: boolean }
interface RawDoc { entities: any[]; blocks: Record<string, { base: Pt; entities: any[] }>; layers: RawLayer[]; angleDeg: boolean }

export async function openFile(file: File): Promise<Drawing> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const name = file.name.replace(/\.[^.]+$/, '');
  let d: Drawing;
  if (ext === 'dxf') d = fromRaw(await parseDxf(await file.text()), name);
  else if (ext === 'dwg') d = fromRaw(await parseDwg(await file.arrayBuffer()), name);
  else if (ext === 'svg') d = parseSvg(await file.text(), name);
  else if (ext === 'plv' || ext === 'json') d = parseNative(await file.text(), name);
  else throw new Error(`Formato “.${ext}” não suportado. Use DWG, DXF, SVG ou PLV.`);
  return d;
}

// ---------------------------------------------------------------- nativo
export function parseNative(text: string, name: string): Drawing {
  const j = JSON.parse(text);
  const d: Drawing = j.drawing ?? j;
  if (!Array.isArray(d.entities) || !Array.isArray(d.layers)) throw new Error('Arquivo .plv inválido');
  d.name = d.name || name;
  for (const e of d.entities) if (!e.id) e.id = uid();
  return d;
}

// ---------------------------------------------------------------- DXF (dxf-parser)
async function parseDxf(text: string): Promise<RawDoc> {
  const { default: DxfParser } = await import('dxf-parser');
  const dxf: any = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Não foi possível ler o DXF');
  const layers: RawLayer[] = Object.values(dxf.tables?.layer?.layers ?? {}).map((l: any) => ({
    name: String(l.name),
    color: l.colorIndex != null && l.colorIndex > 0 ? aciToHex(l.colorIndex) : typeof l.color === 'number' ? rgbIntToHex(l.color) : undefined,
    visible: l.visible !== false && !l.frozen,
  }));
  const blocks: RawDoc['blocks'] = {};
  for (const [k, b] of Object.entries<any>(dxf.blocks ?? {})) blocks[k] = { base: b.position ?? { x: 0, y: 0 }, entities: b.entities ?? [] };
  const entities = (dxf.entities ?? []).filter((e: any) => !e.inPaperSpace).map((e: any) => ({ ...e, _color: dxfColor(e) }));
  for (const b of Object.values(blocks)) b.entities = b.entities.map((e: any) => ({ ...e, _color: dxfColor(e) }));
  return { entities, blocks, layers, angleDeg: true };
}
function dxfColor(e: any): string | null | undefined {
  if (e.colorIndex === 0) return null; // PorBloco
  if (e.colorIndex === 256 || e.colorIndex == null) return typeof e.color === 'number' && e.colorIndex == null ? rgbIntToHex(e.color) : undefined;
  return typeof e.color === 'number' ? rgbIntToHex(e.color) : aciToHex(e.colorIndex);
}

// ---------------------------------------------------------------- DWG (LibreDWG em WebAssembly)
let libPromise: Promise<any> | null = null;
async function libredwg() {
  if (!libPromise) {
    libPromise = (async () => {
      const mod = await import('@mlightcad/libredwg-web');
      return { mod, lib: await mod.LibreDwg.create() };
    })();
  }
  return libPromise;
}

async function parseDwg(buf: ArrayBuffer): Promise<RawDoc> {
  const { mod, lib } = await libredwg();
  const ptr = lib.dwg_read_data(buf, mod.Dwg_File_Type.DWG);
  if (ptr == null) throw new Error('Não foi possível ler o DWG (versão não suportada ou arquivo corrompido)');
  let db: any;
  try { db = lib.convert(ptr); } finally { try { lib.dwg_free(ptr); } catch { /* ignore */ } }
  const layers: RawLayer[] = (db.tables?.LAYER?.entries ?? []).map((l: any) => ({
    name: String(l.name),
    color: l.colorIndex > 0 && l.colorIndex < 256 ? aciToHex(l.colorIndex) : typeof l.color === 'number' && l.color >= 0 ? rgbIntToHex(l.color) : undefined,
    visible: !l.off && !l.frozen,
    // o campo `locked` da libredwg-web não é confiável; o bit 4 de standardFlag é o oficial
    locked: ((l.standardFlag ?? 0) & 4) !== 0,
  }));
  const blocks: RawDoc['blocks'] = {};
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
    if (/^\*(model|paper)_space/i.test(b.name)) continue;
    blocks[b.name] = { base: b.basePoint ?? { x: 0, y: 0 }, entities: (b.entities ?? []).map(dwgToRaw) };
  }
  const entities = (db.entities ?? []).filter((e: any) => !e.isInPaperSpace).map(dwgToRaw);
  return { entities, blocks, layers, angleDeg: false };
}

function dwgColor(e: any): string | null | undefined {
  if (e.colorIndex === 0) return null;
  if (e.colorIndex > 0 && e.colorIndex < 256) return aciToHex(e.colorIndex);
  return undefined;
}

function dwgToRaw(e: any): any {
  const base = { type: e.type, layer: e.layer, _color: dwgColor(e) };
  switch (e.type) {
    case 'LINE': return { ...base, vertices: [e.startPoint, e.endPoint] };
    case 'LWPOLYLINE': return { ...base, vertices: e.vertices, shape: !!(e.flag & 1) || !!(e.flag & 512) };
    case 'POLYLINE2D': case 'POLYLINE3D': return { ...base, type: 'POLYLINE', vertices: e.vertices, shape: !!(e.flag & 1) };
    case 'MTEXT': return { ...base, position: e.insertionPoint, height: e.textHeight, text: e.text, rotation: e.rotation, attachmentPoint: e.attachmentPoint, direction: e.direction };
    case 'INSERT': return { ...e, ...base, position: e.insertionPoint, attribs: (e.attribs ?? []).map((a: any) => ({ ...base, type: 'TEXT', ...(a.text ?? {}), _color: dwgColor(a) })) };
    case 'DIMENSION': return { ...base, block: e.name };
    case 'SPLINE': return { ...base, controlPoints: e.controlPoints, knotValues: e.knots, degreeOfSplineCurve: e.degree, fitPoints: e.fitPoints, weights: e.weights };
    case 'SOLID': case '3DFACE': return { ...base, points: [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean) };
    case 'ATTRIB': return { ...base, type: 'TEXT', ...(e.text ?? {}) };
    default: return { ...e, ...base };
  }
}

// ---------------------------------------------------------------- conversão comum
function fromRaw(raw: RawDoc, name: string): Drawing {
  const d = newDrawing(name);
  d.layers = [];
  const seen = new Map<string, Layer>();
  const addLayer = (n: string, color?: string, visible = true, locked = false) => {
    let l = seen.get(n);
    if (!l) { l = { name: n, color: color ?? PALETTE[seen.size % PALETTE.length], visible, locked }; seen.set(n, l); d.layers.push(l); }
    return l;
  };
  addLayer('0', '#ffffff');
  for (const l of raw.layers) { const x = addLayer(l.name, l.color, l.visible, l.locked); if (l.color) x.color = l.color; x.visible = l.visible; }
  const out: Entity[] = [];
  const rad = (v: number | undefined) => (v ?? 0) * (raw.angleDeg ? Math.PI / 180 : 1);

  const emit = (e: NewEntity, m: Mat, inherit: { layer?: string; color?: string | null }) => {
    let layer = e.layer;
    if (inherit.layer && (layer === '0' || !layer)) layer = inherit.layer;
    addLayer(layer);
    let color = (e as any).color as string | null | undefined;
    if (color === null) color = inherit.color ?? undefined;
    const ent = { ...e, layer, id: uid() } as Entity;
    if (color) ent.color = color; else delete ent.color;
    out.push(m === I ? ent : transformEntity(ent, m));
  };

  const convert = (r: any, m: Mat, inherit: { layer?: string; color?: string | null }, depth: number) => {
    if (out.length > 400000) return;
    const layer = String(r.layer ?? '0');
    const color = r._color as string | null | undefined;
    const b = { layer, color } as any;
    const P = (p: any): Pt => ({ x: +p?.x || 0, y: +p?.y || 0 });
    switch (r.type) {
      case 'LINE': if (r.vertices?.length >= 2) emit({ type: 'line', ...b, a: P(r.vertices[0]), b: P(r.vertices[1]) }, m, inherit); break;
      case 'CIRCLE': emit({ type: 'circle', ...b, c: P(r.center), r: +r.radius }, m, inherit); break;
      case 'ARC': emit({ type: 'arc', ...b, c: P(r.center), r: +r.radius, start: +r.startAngle, end: +r.endAngle }, m, inherit); break;
      case 'ELLIPSE': emit({ type: 'ellipse', ...b, c: P(r.center), major: P(r.majorAxisEndPoint), ratio: +r.axisRatio || 1, start: +r.startAngle || 0, end: r.endAngle == null ? Math.PI * 2 : +r.endAngle }, m, inherit); break;
      case 'LWPOLYLINE': case 'POLYLINE': {
        const vs = (r.vertices ?? []).filter((v: any) => v && isFinite(v.x));
        if (vs.length < 2) break;
        const bulges = vs.map((v: any) => +v.bulge || 0);
        emit({ type: 'poly', ...b, pts: vs.map(P), closed: !!r.shape, ...(bulges.some((x: number) => x) ? { bulges } : {}) }, m, inherit);
        break;
      }
      case 'SPLINE': {
        const pts = splinePoints(r);
        if (pts.length >= 2) emit({ type: 'poly', ...b, pts, closed: false }, m, inherit);
        break;
      }
      case 'POINT': emit({ type: 'point', ...b, p: P(r.position) }, m, inherit); break;
      case 'TEXT': {
        const text = String(r.text ?? '').trim(); if (!text) break;
        const h = +r.textHeight || +r.height || 1;
        let p = P(r.startPoint ?? r.position);
        const rot = rad(r.rotation);
        const ha = r.halign ?? 0, va = r.valign ?? 0;
        if ((ha || va) && r.endPoint && (r.endPoint.x || r.endPoint.y)) {
          p = P(r.endPoint);
          const w = textWidth({ text, h });
          const dx = ha === 1 || ha === 4 ? -w / 2 : ha === 2 ? -w : 0;
          const dy = va === 2 || ha === 4 ? -h / 2 : va === 3 ? -h : 0;
          p = { x: p.x + dx * Math.cos(rot) - dy * Math.sin(rot), y: p.y + dx * Math.sin(rot) + dy * Math.cos(rot) };
        }
        emit({ type: 'text', ...b, p, h, text, rot }, m, inherit);
        break;
      }
      case 'MTEXT': {
        const text = cleanMText(String(r.text ?? '')); if (!text.trim()) break;
        const h = +r.height || +r.textHeight || 1;
        let rot = rad(r.rotation);
        if (r.direction && (r.direction.x || r.direction.y)) rot = Math.atan2(r.direction.y, r.direction.x);
        else if (r.directionVector && (r.directionVector.x || r.directionVector.y)) rot = Math.atan2(r.directionVector.y, r.directionVector.x);
        const lines = text.split('\n');
        const w = Math.max(...lines.map((t) => textWidth({ text: t, h })));
        const ap = r.attachmentPoint ?? 1;
        const col = (ap - 1) % 3, row = Math.floor((ap - 1) / 3);
        const total = h * (1 + (lines.length - 1) * LINE_GAP);
        const dx = col === 1 ? -w / 2 : col === 2 ? -w : 0;
        const dy = row === 0 ? -h : row === 1 ? total / 2 - h : total - h;
        const p0 = P(r.position);
        const p = { x: p0.x + dx * Math.cos(rot) - dy * Math.sin(rot), y: p0.y + dx * Math.sin(rot) + dy * Math.cos(rot) };
        emit({ type: 'text', ...b, p, h, text, rot }, m, inherit);
        break;
      }
      case 'SOLID': case '3DFACE': {
        const pts = (r.points ?? r.vertices ?? []).map(P);
        if (pts.length >= 3) {
          // SOLID usa a ordem 1-2-4-3
          const ordered = r.type === 'SOLID' && pts.length === 4 ? [pts[0], pts[1], pts[3], pts[2]] : pts;
          emit({ type: 'poly', ...b, pts: ordered, closed: true }, m, inherit);
        }
        break;
      }
      case 'INSERT': case 'DIMENSION': {
        const blk = raw.blocks[r.type === 'INSERT' ? r.name : r.block];
        if (blk && depth < 10) {
          const nextInherit = { layer: layer === '0' ? inherit.layer : layer, color: color === null ? inherit.color : color ?? addLayer(layer).color };
          if (r.type === 'DIMENSION') { for (const c of blk.entities) convert(c, m, nextInherit, depth + 1); }
          else {
            const cols = Math.max(1, r.columnCount || 1), rows = Math.max(1, r.rowCount || 1);
            for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
              const pos = P(r.position);
              const ins = { x: pos.x + j * (r.columnSpacing || 0), y: pos.y + i * (r.rowSpacing || 0) };
              const local = compose(rotateAbout(ins, rad(r.rotation)), compose(translate(ins.x, ins.y), compose(scaleAbout({ x: 0, y: 0 }, r.xScale ?? 1, r.yScale ?? 1), translate(-blk.base.x, -blk.base.y))));
              const mm = compose(m, local);
              for (const c of blk.entities) convert(c, mm, nextInherit, depth + 1);
            }
          }
        }
        for (const a of r.attribs ?? []) convert(a, m, inherit, depth + 1);
        break;
      }
    }
  };

  for (const r of raw.entities) convert(r, I, {}, 0);
  d.entities = out;
  d.current = '0';
  return d;
}

function cleanMText(s: string) {
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*);/g, (_m, a) => a.replace(/[#^]/g, '/'))
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');
}

/** Avalia NURBS (de Boor) ou interpola os pontos de ajuste. */
function splinePoints(r: any): Pt[] {
  const cps: Pt[] = (r.controlPoints ?? []).map((p: any) => ({ x: +p.x, y: +p.y }));
  const knots: number[] = r.knotValues ?? r.knots ?? [];
  const k: number = r.degreeOfSplineCurve ?? r.degree ?? 3;
  const w: number[] | undefined = r.weights?.length === cps.length ? r.weights : undefined;
  if (cps.length > k && knots.length === cps.length + k + 1) {
    const out: Pt[] = [];
    const t0 = knots[k], t1 = knots[cps.length];
    const n = Math.min(2000, cps.length * 16);
    for (let s = 0; s <= n; s++) {
      const t = Math.min(t0 + ((t1 - t0) * s) / n, t1 - 1e-12);
      let span = k; while (span < cps.length - 1 && t >= knots[span + 1]) span++;
      const d = Array.from({ length: k + 1 }, (_, j) => {
        const p = cps[span - k + j], ww = w ? w[span - k + j] : 1;
        return { x: p.x * ww, y: p.y * ww, w: ww };
      });
      for (let rr = 1; rr <= k; rr++) for (let j = k; j >= rr; j--) {
        const i = span - k + j;
        const den = knots[i + k - rr + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
      }
      out.push({ x: d[k].x / d[k].w, y: d[k].y / d[k].w });
    }
    return out;
  }
  const fit: Pt[] = (r.fitPoints ?? []).map((p: any) => ({ x: +p.x, y: +p.y }));
  if (fit.length >= 2) return catmull(fit);
  return cps;
}

function catmull(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    for (let s = 0; s < 12; s++) {
      const t = s / 12, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

// ---------------------------------------------------------------- SVG
export function parseSvg(text: string, name: string): Drawing {
  const d = newDrawing(name);
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement as unknown as SVGSVGElement;
  if (svg.nodeName.toLowerCase() !== 'svg') throw new Error('SVG inválido');
  host.appendChild(document.importNode(svg, true));
  document.body.appendChild(host);
  try {
    const root = host.querySelector('svg') as SVGSVGElement;
    const rootInv = root.getCTM()?.inverse() ?? new DOMMatrix();
    const toW = (m: DOMMatrix, x: number, y: number): Pt => { const q = new DOMPoint(x, y).matrixTransform(m); return { x: q.x, y: -q.y }; };
    const colorOf = (el: Element): string | undefined => {
      const cs = getComputedStyle(el);
      const c = cs.stroke && cs.stroke !== 'none' ? cs.stroke : cs.fill && cs.fill !== 'none' ? cs.fill : '';
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('') : undefined;
    };
    const add = (e: any, el: Element) => { const c = colorOf(el); d.entities.push({ ...e, layer: '0', id: uid(), ...(c && c !== '#000000' ? { color: c } : {}) }); };
    root.querySelectorAll('path,line,rect,circle,ellipse,polyline,polygon,text').forEach((el) => {
      if (el.closest('defs,clipPath,mask,symbol,marker,pattern')) return;
      const g = el as SVGGraphicsElement;
      const m = rootInv.multiply(g.getCTM() ?? new DOMMatrix());
      const tag = el.tagName.toLowerCase();
      const num = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0;
      if (tag === 'line') { add({ type: 'line', a: toW(m, num('x1'), num('y1')), b: toW(m, num('x2'), num('y2')) }, el); return; }
      if (tag === 'circle' && Math.abs(m.a * m.d - m.b * m.c) > 0 && Math.abs(Math.hypot(m.a, m.b) - Math.hypot(m.c, m.d)) < 1e-6) {
        add({ type: 'circle', c: toW(m, num('cx'), num('cy')), r: num('r') * Math.hypot(m.a, m.b) }, el); return;
      }
      if (tag === 'text') {
        const t = el.textContent?.trim(); if (!t) return;
        const fs = parseFloat(getComputedStyle(el).fontSize) || 12;
        const k = Math.hypot(m.a, m.b);
        add({ type: 'text', p: toW(m, num('x'), num('y')), h: (fs * k) / TEXT_EM_SVG, text: t, rot: -Math.atan2(m.b, m.a) }, el); return;
      }
      if (tag === 'rect') {
        const x = num('x'), y = num('y'), w = num('width'), h = num('height');
        if (!num('rx') && !num('ry')) { add({ type: 'poly', pts: [toW(m, x, y), toW(m, x + w, y), toW(m, x + w, y + h), toW(m, x, y + h)], closed: true }, el); return; }
      }
      if (tag === 'polyline' || tag === 'polygon') {
        const nums = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
        const pts: Pt[] = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push(toW(m, nums[i], nums[i + 1]));
        if (pts.length >= 2) add({ type: 'poly', pts, closed: tag === 'polygon' }, el); return;
      }
      // caminhos genéricos: amostragem ao longo do comprimento, quebrando nos saltos (moveTo)
      const geo = el as SVGGeometryElement;
      const L = geo.getTotalLength?.() ?? 0;
      if (!L) return;
      const n = Math.min(4000, Math.max(16, Math.ceil(L / 1.5)));
      const step = L / n;
      let cur: Pt[] = [];
      let prev: DOMPoint | null = null;
      const flush = () => { if (cur.length >= 2) add({ type: 'poly', pts: simplify(cur), closed: false }, el); cur = []; };
      for (let i = 0; i <= n; i++) {
        const q = geo.getPointAtLength(i * step);
        if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) > step * 3) flush();
        cur.push(toW(m, q.x, q.y)); prev = q;
      }
      flush();
    });
  } finally { host.remove(); }
  return d;
}

/** remove pontos colineares para deixar as polilinhas leves */
function simplify(p: Pt[]): Pt[] {
  if (p.length < 3) return p;
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = out[out.length - 1], b = p[i], c = p[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    if (Math.abs(cross) / len > 1e-3 * len || Math.abs(cross) / len > 0.02) out.push(b);
  }
  out.push(p[p.length - 1]);
  return out;
}

