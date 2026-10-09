import type { Drawing, Pt } from '../core/types';
import { uid } from '../core/types';
import { newDrawing } from '../core/doc';
import { createParseWorker } from './workerFactory';
import { seedBoxes } from '../render/renderer';

const TEXT_EM_SVG = 1 / 0.72;
export const OPEN_ACCEPT = '.dwg,.dxf,.svg,.plv,.json';

export type Progress = (stage: string, pct: number) => void;

/** desenho aberto + tipos de objeto que não puderam ser exibidos (com a contagem) */
export interface Opened { drawing: Drawing; skipped: Record<string, number> }

export async function openFile(file: File, progress: Progress = () => {}, signal?: AbortSignal): Promise<Opened> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const name = file.name.replace(/\.[^.]+$/, '');
  progress('Lendo o arquivo do disco…', 3);
  if (ext === 'dxf' || ext === 'dwg') return readInWorker(ext, await file.arrayBuffer(), name, progress, signal);
  if (ext === 'svg') { progress('Interpretando SVG…', 30); return { drawing: parseSvg(await file.text(), name), skipped: {} }; }
  if (ext === 'plv' || ext === 'json') { progress('Lendo projeto…', 30); return { drawing: parseNative(await file.text(), name), skipped: {} }; }
  throw new Error(`Formato “.${ext}” não suportado. Use DWG, DXF, SVG ou PLV.`);
}

/** Lê DWG/DXF num Web Worker: a interface continua respondendo e o usuário pode cancelar. */
function readInWorker(kind: 'dxf' | 'dwg', data: ArrayBuffer, name: string, progress: Progress, signal?: AbortSignal): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const w = createParseWorker();
    const finish = () => { w.terminate(); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { finish(); reject(new DOMException('Leitura cancelada', 'AbortError')); };
    signal?.addEventListener('abort', onAbort);
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') progress(m.stage, m.pct);
      else if (m.type === 'done') {
        finish();
        const d: Drawing = JSON.parse(new TextDecoder().decode(m.json));
        if (m.boxes) seedBoxes(d.entities, m.boxes);
        resolve({ drawing: d, skipped: m.skipped ?? {} });
      }
      else if (m.type === 'error') { finish(); reject(new Error(m.message)); }
    };
    w.onerror = (ev) => { finish(); reject(new Error(ev.message || 'Falha no leitor de arquivos')); };
    w.postMessage({ kind, data, name }, [data]);
  });
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

