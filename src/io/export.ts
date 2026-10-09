import type { Drawing, Entity, Pt } from '../core/types';
import { boxValid, dimGeometry, drawingBox, sweep, tessellate, ellipsePoint, TEXT_EM, LINE_GAP } from '../core/geom';
import { hexToAci, inkOnLight } from '../core/aci';
import { View } from '../render/view';
import { pathEntity, fillHatch } from '../render/draw';

export type Background = 'light' | 'dark' | 'transparent';
export interface ExportOptions {
  background: Background;
  pixels: number;            // lado maior (raster)
  paper: 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
  orientation: 'landscape' | 'portrait';
  pdfScale: number;          // 0 = ajustar à página; senão 1:N (unidades em mm)
  feed: number;              // G-code
  laser: boolean;            // G-code: M3/M5 em vez de eixo Z
  onlyVisible: boolean;
}

export const DEFAULT_EXPORT: ExportOptions = {
  background: 'light', pixels: 3000, paper: 'A3', orientation: 'landscape', pdfScale: 0, feed: 1200, laser: true, onlyVisible: true,
};

export interface FormatDef { ext: string; label: string; desc: string; mime: string; kind: 'vector' | 'raster' | 'machine' | 'data'; run: (d: Drawing, o: ExportOptions) => Promise<Blob> | Blob }

const BG = { light: '#ffffff', dark: '#0d0c10', transparent: '' };

function prepared(d: Drawing, o: ExportOptions) {
  const vis = new Set(d.layers.filter((l) => l.visible).map((l) => l.name));
  const ents = o.onlyVisible ? d.entities.filter((e) => vis.has(e.layer)) : d.entities;
  const layerColor = new Map(d.layers.map((l) => [l.name, l.color]));
  const color = (e: Entity) => {
    const c = e.color ?? layerColor.get(e.layer) ?? '#ffffff';
    return o.background === 'dark' ? c : inkOnLight(c);
  };
  const box = drawingBox(ents);
  return { ents, color, box: boxValid(box) ? box : { minX: 0, minY: 0, maxX: 100, maxY: 100 } };
}

const fmtN = (n: number) => (Math.round(n * 1e4) / 1e4).toString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- PLV (nativo)
function exportPlv(d: Drawing): Blob {
  return new Blob([JSON.stringify({ format: 'projetalivre', version: 1, savedAt: new Date().toISOString(), drawing: d }, null, 1)], { type: 'application/json' });
}

// ---------------------------------------------------------------- DXF (@tarikjabiri/dxf)
const safeLayer = (n: string) => n.replace(/[<>/\\":;?*|=`]/g, '') || '0';
async function exportDxf(d: Drawing, o: ExportOptions): Promise<Blob> {
  const { DxfWriter, point3d, LWPolylineFlags, Units, HatchBoundaryPaths, HatchPolylineBoundary, HatchPredefinedPatterns, pattern } = await import('@tarikjabiri/dxf');
  const w = new DxfWriter();
  w.setUnits(Units.Millimeters);
  const trueColor = (hex: string) => String(parseInt(hex.slice(1), 16));
  for (const l of d.layers) {
    const layer = w.addLayer(safeLayer(l.name), hexToAci(l.color), 'CONTINUOUS');
    layer.colorNumber = hexToAci(l.color);
    (layer as any).trueColor = trueColor(l.color);
  }
  const { ents } = prepared(d, { ...o, onlyVisible: false });
  const deg = (r: number) => (r * 180) / Math.PI;
  for (const e of ents) {
    const opt: any = { layerName: safeLayer(e.layer) };
    if (e.color) { opt.colorNumber = hexToAci(e.color); opt.trueColor = trueColor(e.color); }
    switch (e.type) {
      case 'line': w.addLine(point3d(e.a.x, e.a.y), point3d(e.b.x, e.b.y), opt); break;
      case 'circle': w.addCircle(point3d(e.c.x, e.c.y), e.r, opt); break;
      case 'arc': w.addArc(point3d(e.c.x, e.c.y), e.r, deg(e.start), deg(e.end), opt); break;
      case 'ellipse': w.addEllipse(point3d(e.c.x, e.c.y), point3d(e.major.x, e.major.y), e.ratio, e.start, e.start + sweep(e.start, e.end), opt); break;
      case 'poly': w.addLWPolyline(e.pts.map((p, i) => ({ point: { x: p.x, y: p.y }, bulge: e.bulges?.[i] ?? 0 })), { ...opt, flags: e.closed ? LWPolylineFlags.Closed : LWPolylineFlags.None }); break;
      case 'point': w.addPoint(e.p.x, e.p.y, 0, opt); break;
      case 'hatch': {
        // contornos como polilinhas fechadas; preenchimento sólido como HATCH SOLID
        const loops = e.loops.filter((l) => l.length > 2);
        for (const l of loops) w.addLWPolyline(l.map((p) => ({ point: p })), { ...opt, flags: LWPolylineFlags.Closed });
        if (e.solid && loops.length) {
          const paths = new HatchBoundaryPaths();
          for (const l of loops) paths.addPolylineBoundary(new HatchPolylineBoundary(l.map((p) => ({ x: p.x, y: p.y }))));
          w.addHatch(paths, pattern({ name: HatchPredefinedPatterns.SOLID }), opt);
        }
        break;
      }
      case 'text': e.text.split('\n').forEach((ln, i) => {
        const dy = -i * e.h * LINE_GAP;
        w.addText(point3d(e.p.x - dy * Math.sin(e.rot), e.p.y + dy * Math.cos(e.rot)), e.h, ln, { ...opt, rotation: deg(e.rot) });
      }); break;
      case 'dim': {
        const g = dimGeometry(e);
        for (const l of g.lines) w.addLWPolyline(l.map((p) => ({ point: p })), opt);
        w.addText(point3d(g.text.p.x, g.text.p.y), g.text.h, g.text.text, { ...opt, rotation: deg(g.text.rot) });
        break;
      }
    }
  }
  return new Blob([w.stringify()], { type: 'application/dxf' });
}

// ---------------------------------------------------------------- SVG
function exportSvg(d: Drawing, o: ExportOptions): Blob {
  const { ents, color, box } = prepared(d, o);
  const pad = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.04 || 1;
  const W = box.maxX - box.minX + pad * 2, H = box.maxY - box.minY + pad * 2;
  const X = (x: number) => fmtN(x - box.minX + pad), Y = (y: number) => fmtN(box.maxY - y + pad);
  const sw = fmtN(Math.max(W, H) / 1000);
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmtN(W)} ${fmtN(H)}" width="${fmtN(W)}mm" height="${fmtN(H)}mm">`);
  out.push(`<!-- Gerado por ProjetaLivre — ${esc(d.name)} -->`);
  if (o.background !== 'transparent') out.push(`<rect width="100%" height="100%" fill="${BG[o.background]}"/>`);
  const path = (pts: Pt[], closed = false) => 'M' + pts.map((p) => `${X(p.x)} ${Y(p.y)}`).join(' L') + (closed ? ' Z' : '');
  const text = (p: Pt, h: number, t: string, rot: number, c: string) =>
    t.split('\n').map((ln, i) => `<text x="${X(p.x)}" y="${fmtN(+Y(p.y) + i * h * LINE_GAP)}" font-family="JetBrains Mono, monospace" font-size="${fmtN(h * TEXT_EM)}" fill="${c}" transform="rotate(${fmtN((-rot * 180) / Math.PI)} ${X(p.x)} ${Y(p.y)})">${esc(ln)}</text>`).join('');
  for (const l of d.layers) {
    const list = ents.filter((e) => e.layer === l.name);
    if (!list.length) continue;
    out.push(`<g id="${esc(l.name)}" fill="none" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">`);
    for (const e of list) {
      const c = color(e);
      switch (e.type) {
        case 'line': out.push(`<line x1="${X(e.a.x)}" y1="${Y(e.a.y)}" x2="${X(e.b.x)}" y2="${Y(e.b.y)}" stroke="${c}"/>`); break;
        case 'circle': out.push(`<circle cx="${X(e.c.x)}" cy="${Y(e.c.y)}" r="${fmtN(e.r)}" stroke="${c}"/>`); break;
        case 'arc': {
          const s = sweep(e.start, e.end);
          const p1 = { x: e.c.x + e.r * Math.cos(e.start), y: e.c.y + e.r * Math.sin(e.start) };
          const p2 = { x: e.c.x + e.r * Math.cos(e.start + s), y: e.c.y + e.r * Math.sin(e.start + s) };
          out.push(`<path d="M${X(p1.x)} ${Y(p1.y)} A${fmtN(e.r)} ${fmtN(e.r)} 0 ${s > Math.PI ? 1 : 0} 0 ${X(p2.x)} ${Y(p2.y)}" stroke="${c}"/>`);
          break;
        }
        case 'text': out.push(text(e.p, e.h, e.text, e.rot, c)); break;
        case 'point': out.push(`<circle cx="${X(e.p.x)}" cy="${Y(e.p.y)}" r="${sw}" fill="${c}" stroke="none"/>`); break;
        case 'hatch': out.push(`<path d="${e.loops.filter((l) => l.length > 2).map((l) => path(l, true)).join(' ')}" fill="${c}" fill-opacity="${e.solid ? 0.8 : 0.2}" fill-rule="evenodd" stroke="none"/>`); break;
        case 'dim': {
          const g = dimGeometry(e);
          for (const l2 of g.lines) out.push(`<path d="${path(l2)}" stroke="${c}"/>`);
          out.push(text(g.text.p, g.text.h, g.text.text, g.text.rot, c));
          break;
        }
        default: for (const p of tessellate(e, 4)) out.push(`<path d="${path(p, e.type === 'poly' && e.closed)}" stroke="${c}"/>`);
      }
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return new Blob([out.join('\n')], { type: 'image/svg+xml' });
}

// ---------------------------------------------------------------- Raster (PNG/JPG/WEBP)
function rasterize(d: Drawing, o: ExportOptions, mime: string): Promise<Blob> {
  const { ents, color, box } = prepared(d, o);
  const bw = box.maxX - box.minX || 1, bh = box.maxY - box.minY || 1;
  const long = Math.max(256, Math.min(12000, o.pixels));
  const W = bw >= bh ? long : Math.max(64, Math.round((long * bw) / bh));
  const H = bw >= bh ? Math.max(64, Math.round((long * bh) / bw)) : long;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const bg = o.background === 'transparent' && mime === 'image/jpeg' ? 'light' : o.background;
  if (bg !== 'transparent') { ctx.fillStyle = BG[bg]; ctx.fillRect(0, 0, W, H); }
  const v = new View(); v.w = W; v.h = H; v.fit(box, 0.04);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, long / 1600);
  for (const e of ents) {
    const col = color(e);
    if (e.type === 'hatch') { fillHatch(ctx, e, v, col); continue; }
    ctx.strokeStyle = col;
    ctx.beginPath(); pathEntity(ctx, e, v, col); ctx.stroke();
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao gerar imagem'))), mime, 0.95));
}

// ---------------------------------------------------------------- PDF (jsPDF)
const PAPER: Record<ExportOptions['paper'], [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
async function exportPdf(d: Drawing, o: ExportOptions): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const [pw0, ph0] = PAPER[o.paper];
  const [pw, ph] = o.orientation === 'landscape' ? [pw0, ph0] : [ph0, pw0];
  const pdf = new jsPDF({ orientation: o.orientation, unit: 'mm', format: o.paper.toLowerCase() });
  const { ents, color, box } = prepared(d, { ...o, background: o.background === 'dark' ? 'dark' : 'light' });
  if (o.background === 'dark') { pdf.setFillColor('#0d0c10'); pdf.rect(0, 0, pw, ph, 'F'); }
  const margin = 10;
  const bw = box.maxX - box.minX || 1, bh = box.maxY - box.minY || 1;
  const k = o.pdfScale > 0 ? 1 / o.pdfScale : Math.min((pw - margin * 2) / bw, (ph - margin * 2 - 8) / bh);
  const ox = (pw - bw * k) / 2, oy = (ph - 8 - bh * k) / 2;
  const X = (x: number) => ox + (x - box.minX) * k, Y = (y: number) => oy + (box.maxY - y) * k;
  pdf.setLineWidth(0.18); pdf.setLineCap('round'); pdf.setLineJoin('round');
  for (const e of ents) {
    const c = color(e);
    pdf.setDrawColor(c); pdf.setTextColor(c);
    const textAt = (p: Pt, h: number, t: string, rot: number) => {
      pdf.setFontSize(Math.max(1, (h * TEXT_EM * k) / 0.3528));
      t.split('\n').forEach((ln, i) => {
        const dy = -i * h * LINE_GAP;
        pdf.text(ln, X(p.x - dy * Math.sin(rot)), Y(p.y + dy * Math.cos(rot)), { angle: (rot * 180) / Math.PI });
      });
    };
    if (e.type === 'circle') { pdf.circle(X(e.c.x), Y(e.c.y), e.r * k, 'S'); continue; }
    if (e.type === 'hatch') {
      // sólida: preenchimento cheio; com padrão: preenchimento translúcido
      pdf.setFillColor(c);
      const G = (pdf as any).GState;
      if (!e.solid && G) pdf.setGState(new G({ opacity: 0.2 }));
      for (const l of e.loops) { if (l.length < 3) continue; pdf.moveTo(X(l[0].x), Y(l[0].y)); for (const p of l.slice(1)) pdf.lineTo(X(p.x), Y(p.y)); pdf.close(); }
      pdf.fillEvenOdd();
      if (!e.solid && G) pdf.setGState(new G({ opacity: 1 }));
      continue;
    }
    if (e.type === 'text') { textAt(e.p, e.h, e.text, e.rot); continue; }
    const paths = e.type === 'dim' ? dimGeometry(e).lines : tessellate(e, k * 4);
    for (const p of paths) {
      if (p.length < 2) continue;
      pdf.moveTo(X(p[0].x), Y(p[0].y));
      for (let i = 1; i < p.length; i++) pdf.lineTo(X(p[i].x), Y(p[i].y));
      if (e.type === 'poly' && e.closed) pdf.close();
      pdf.stroke();
    }
    if (e.type === 'dim') { const g = dimGeometry(e); textAt(g.text.p, g.text.h, g.text.text, g.text.rot); }
  }
  // carimbo
  pdf.setFontSize(7); pdf.setTextColor(o.background === 'dark' ? '#d4ff3a' : '#555555');
  const scaleTxt = o.pdfScale > 0 ? `1:${o.pdfScale}` : 'ajustado à folha';
  pdf.text(`${d.name}  ·  escala ${scaleTxt}  ·  ProjetaLivre  ·  ${new Date().toLocaleDateString('pt-BR')}`, margin, ph - 5);
  return pdf.output('blob');
}

// ---------------------------------------------------------------- HPGL (plotters)
function machinePaths(d: Drawing, o: ExportOptions) {
  const { ents, box } = prepared(d, o);
  const groups = d.layers.map((l) => ({ layer: l.name, paths: [] as Pt[][] }));
  for (const e of ents) {
    const g = groups.find((x) => x.layer === e.layer)!;
    let paths: Pt[][];
    if (e.type === 'text') paths = [];
    else if (e.type === 'dim') paths = dimGeometry(e).lines;
    else if (e.type === 'ellipse') { const s = sweep(e.start, e.end); paths = [Array.from({ length: 121 }, (_, i) => ellipsePoint(e, e.start + (s * i) / 120))]; }
    else paths = tessellate(e, 8);
    if (e.type === 'poly' && e.closed && paths[0]?.length) paths[0] = [...paths[0], paths[0][0]];
    g.paths.push(...paths.filter((p) => p.length >= 2));
  }
  return { groups: groups.filter((g) => g.paths.length), box };
}

function exportHpgl(d: Drawing, o: ExportOptions): Blob {
  const { groups, box } = machinePaths(d, o);
  const U = (v: number) => Math.round(v * 40); // 40 unidades = 1 mm
  const out = ['IN;', 'PA;'];
  groups.forEach((g, i) => {
    out.push(`SP${(i % 8) + 1};`);
    for (const p of g.paths) {
      out.push(`PU${U(p[0].x - box.minX)},${U(p[0].y - box.minY)};`);
      out.push('PD' + p.slice(1).map((q) => `${U(q.x - box.minX)},${U(q.y - box.minY)}`).join(',') + ';');
    }
  });
  out.push('PU;SP0;');
  return new Blob([out.join('\n')], { type: 'application/vnd.hp-hpgl' });
}

// ---------------------------------------------------------------- G-code (CNC / laser)
function exportGcode(d: Drawing, o: ExportOptions): Blob {
  const { groups, box } = machinePaths(d, o);
  const f = (v: number) => v.toFixed(3);
  const out = [`; ProjetaLivre — ${d.name}`, `; ${o.laser ? 'modo laser (M3/M5)' : 'modo fresa (eixo Z)'} · origem no canto inferior esquerdo`, 'G21 ; milímetros', 'G90 ; absoluto', o.laser ? 'M5' : 'G0 Z5'];
  for (const g of groups) {
    out.push(`; camada ${g.layer}`);
    for (const p of g.paths) {
      out.push(`G0 X${f(p[0].x - box.minX)} Y${f(p[0].y - box.minY)}`);
      out.push(o.laser ? 'M3 S1000' : `G1 Z-1 F${Math.round(o.feed / 3)}`);
      for (const q of p.slice(1)) out.push(`G1 X${f(q.x - box.minX)} Y${f(q.y - box.minY)} F${o.feed}`);
      out.push(o.laser ? 'M5' : 'G0 Z5');
    }
  }
  out.push('G0 X0 Y0', 'M2');
  return new Blob([out.join('\n')], { type: 'text/plain' });
}

// ---------------------------------------------------------------- GeoJSON
function exportGeoJson(d: Drawing, o: ExportOptions): Blob {
  const { ents } = prepared(d, o);
  const features = ents.flatMap((e): object[] => {
    const props = { layer: e.layer, type: e.type, ...(e.color ? { color: e.color } : {}), ...(e.type === 'text' ? { text: e.text } : {}) };
    if (e.type === 'point' || e.type === 'text') { const p = e.p; return [{ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.x, p.y] } }]; }
    const paths = tessellate(e, 8).filter((p) => p.length >= 2);
    return [{ type: 'Feature', properties: props, geometry: { type: 'MultiLineString', coordinates: paths.map((p) => p.map((q) => [q.x, q.y])) } }];
  });
  return new Blob([JSON.stringify({ type: 'FeatureCollection', name: d.name, features })], { type: 'application/geo+json' });
}

export const FORMATS: FormatDef[] = [
  { ext: 'plv', label: 'ProjetaLivre', desc: 'Projeto nativo, reabre tudo: camadas, cotas e cores', mime: 'application/json', kind: 'data', run: exportPlv },
  { ext: 'dxf', label: 'DXF', desc: 'Abre no AutoCAD, LibreCAD, QCAD, FreeCAD…', mime: 'application/dxf', kind: 'vector', run: exportDxf },
  { ext: 'svg', label: 'SVG', desc: 'Vetor para web, Inkscape, Illustrator, Figma', mime: 'image/svg+xml', kind: 'vector', run: exportSvg },
  { ext: 'pdf', label: 'PDF', desc: 'Prancha A4–A0, ajustada ou em escala 1:N', mime: 'application/pdf', kind: 'vector', run: exportPdf },
  { ext: 'png', label: 'PNG', desc: 'Imagem sem perdas, com transparência', mime: 'image/png', kind: 'raster', run: (d, o) => rasterize(d, o, 'image/png') },
  { ext: 'jpg', label: 'JPG', desc: 'Imagem leve para enviar e compartilhar', mime: 'image/jpeg', kind: 'raster', run: (d, o) => rasterize(d, o, 'image/jpeg') },
  { ext: 'webp', label: 'WEBP', desc: 'Imagem moderna e compacta', mime: 'image/webp', kind: 'raster', run: (d, o) => rasterize(d, o, 'image/webp') },
  { ext: 'plt', label: 'HPGL', desc: 'Plotters de pena e de recorte', mime: 'application/vnd.hp-hpgl', kind: 'machine', run: exportHpgl },
  { ext: 'gcode', label: 'G-code', desc: 'Corte a laser e fresadoras CNC', mime: 'text/plain', kind: 'machine', run: exportGcode },
  { ext: 'geojson', label: 'GeoJSON', desc: 'Geometria para SIG (QGIS, mapas)', mime: 'application/geo+json', kind: 'data', run: exportGeoJson },
];

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

