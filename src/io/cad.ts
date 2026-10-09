import type { Drawing, Entity, Layer, NewEntity, Pt } from '../core/types';
import { uid } from '../core/types';
import { aciToHex, rgbIntToHex } from '../core/aci';
import { compose, rotateAbout, scaleAbout, transformEntity, translate, textWidth, LINE_GAP, type Mat, I } from '../core/geom';
import { newDrawing, PALETTE } from '../core/doc';
import { EXTRA_DXF_HANDLERS } from './dxfExtra';
import { robustBox } from '../core/geom';

// Leitura de DWG/DXF sem depender do DOM: roda dentro de um Web Worker para não travar a tela.

export type Progress = (stage: string, pct: number) => void;

/** Estrutura intermediária no formato do dxf-parser (o DWG é adaptado para ela). */
interface RawLayer { name: string; color?: string; visible: boolean; locked?: boolean }
interface RawDoc {
  entities: any[];
  /** objetos dos layouts (paper space): carimbos, legendas, molduras */
  paper: any[];
  blocks: Record<string, { base: Pt; entities: any[] }>;
  /** identificador do bloco → nome (tabelas do DWG apontam para o bloco pelo identificador) */
  blockByHandle?: Record<string, string>;
  layers: RawLayer[];
  angleDeg: boolean;
}

/** desenho + o que não pôde ser exibido */
export interface CadResult { drawing: Drawing; skipped: Record<string, number> }

export async function readCad(kind: 'dxf' | 'dwg', data: ArrayBuffer, name: string, progress: Progress): Promise<CadResult> {
  let raw: RawDoc;
  if (kind === 'dxf') {
    progress('Interpretando DXF…', 12);
    raw = await parseDxf(new TextDecoder().decode(data));
  } else {
    progress('Carregando o leitor de DWG (LibreDWG)…', 8);
    const lib = await libredwg();
    progress('Interpretando DWG…', 35);
    raw = await parseDwg(data, lib);
  }
  return fromRaw(raw, name, (done, total) => progress(`Convertendo objetos… ${done.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}`, 55 + Math.round((done / Math.max(total, 1)) * 40)));
}

// ---------------------------------------------------------------- DXF (dxf-parser)
async function parseDxf(text: string): Promise<RawDoc> {
  const { default: DxfParser } = await import('dxf-parser');
  const parser: any = new DxfParser();
  for (const H of EXTRA_DXF_HANDLERS) parser.registerEntityHandler(H);
  const dxf: any = parser.parseSync(text);
  if (!dxf) throw new Error('Não foi possível ler o DXF');
  const layers: RawLayer[] = Object.values(dxf.tables?.layer?.layers ?? {}).map((l: any) => ({
    name: String(l.name),
    color: l.colorIndex != null && l.colorIndex > 0 ? aciToHex(l.colorIndex) : typeof l.color === 'number' ? rgbIntToHex(l.color) : undefined,
    visible: l.visible !== false && !l.frozen,
  }));
  const blocks: RawDoc['blocks'] = {};
  for (const [k, b] of Object.entries<any>(dxf.blocks ?? {})) blocks[k] = { base: b.position ?? { x: 0, y: 0 }, entities: b.entities ?? [] };
  const all = (dxf.entities ?? []).map((e: any) => ({ ...e, _color: dxfColor(e) }));
  for (const b of Object.values(blocks)) b.entities = b.entities.map((e: any) => ({ ...e, _color: dxfColor(e) }));
  return { entities: all.filter((e: any) => !e.inPaperSpace), paper: all.filter((e: any) => e.inPaperSpace), blocks, layers, angleDeg: true };
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

async function parseDwg(buf: ArrayBuffer, { mod, lib }: { mod: any; lib: any }): Promise<RawDoc> {
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
  const blockByHandle: Record<string, string> = {};
  const paper: any[] = [];
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
    if (/^\*model_space/i.test(b.name)) continue;
    if (/^\*paper_space/i.test(b.name)) { paper.push(...(b.entities ?? []).map(dwgToRaw)); continue; }
    blocks[b.name] = { base: b.basePoint ?? { x: 0, y: 0 }, entities: (b.entities ?? []).map(dwgToRaw) };
    if (b.handle) blockByHandle[String(b.handle)] = b.name;
  }
  const entities = (db.entities ?? []).filter((e: any) => !e.isInPaperSpace).map(dwgToRaw);
  paper.push(...(db.entities ?? []).filter((e: any) => e.isInPaperSpace).map(dwgToRaw));
  return { entities, paper, blocks, blockByHandle, layers, angleDeg: false };
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
function fromRaw(raw: RawDoc, name: string, onCount: (done: number, total: number) => void): CadResult {
  const skipped: Record<string, number> = {};
  const skip = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  const infinite: { r: any; m: Mat; inherit: any }[] = [];
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
      case 'TEXT': case 'ATTRIB': {
        if (r.invisible) break;
        const text = cleanMText(String(r.text ?? '')).trim(); if (!text) break;
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
        else if (!blk) skip(`bloco ausente (${r.type === 'INSERT' ? r.name : r.block})`);
        for (const a of r.attribs ?? []) convert(a, m, inherit, depth + 1);
        break;
      }
      case 'ACAD_TABLE': {
        // a tabela é desenhada pelo seu bloco anônimo (*T…), posicionado no ponto de inserção
        const bname = r.name || raw.blockByHandle?.[String(r.blockRecordHandle)] || '';
        const blk = raw.blocks[bname];
        if (!blk) { skip('ACAD_TABLE'); break; }
        const pos = P(r.startPoint), dir = r.directionVector ? P(r.directionVector) : { x: 1, y: 0 };
        const mm = compose(m, compose(rotateAbout(pos, Math.atan2(dir.y, dir.x) || 0), translate(pos.x, pos.y)));
        for (const c of blk.entities) convert(c, mm, { layer: layer === '0' ? inherit.layer : layer, color: color ?? inherit.color }, depth + 1);
        break;
      }
      case 'HATCH': {
        const loops = hatchLoops(r);
        if (!loops.length) { skip('HATCH'); break; }
        const solid = r.solidFill === 1 || String(r.patternName).toUpperCase() === 'SOLID';
        const pattern = (r.definitionLines ?? []).map((d: any) => ({ angle: +d.angle || 0, base: P(d.base), offset: P(d.offset) }));
        emit({ type: 'hatch', ...b, loops, solid, ...(pattern.length && !solid ? { pattern } : {}), name: r.patternName } as NewEntity, m, inherit);
        break;
      }
      case 'LEADER': {
        const pts = (r.vertices ?? []).map(P);
        if (pts.length >= 2) emit({ type: 'poly', ...b, pts, closed: false }, m, inherit);
        break;
      }
      case 'MULTILEADER': {
        for (const sec of r.leaderSections ?? []) {
          const last = sec.lastLeaderLinePoint ? P(sec.lastLeaderLinePoint) : null;
          for (const ln of sec.leaderLines ?? []) {
            const pts = (ln.vertices ?? []).map(P);
            if (last) pts.push(last);
            if (pts.length >= 2) emit({ type: 'poly', ...b, pts, closed: false }, m, inherit);
          }
          if (last && sec.doglegVector && sec.doglegLength) {
            const dv = P(sec.doglegVector);
            emit({ type: 'line', ...b, a: last, b: { x: last.x + dv.x * sec.doglegLength, y: last.y + dv.y * sec.doglegLength } }, m, inherit);
          }
        }
        if (r.textContent && r.textAnchor) convert({ type: 'MTEXT', layer, _color: color, position: r.textAnchor, height: r.textHeight, text: r.textContent, attachmentPoint: 1, rotation: r.textRotation ?? 0 }, m, inherit, depth + 1);
        break;
      }
      case 'MLINE': {
        const vs = r.vertices ?? [];
        const n = Math.max(0, ...vs.map((v: any) => v.lines?.length ?? 0));
        for (let j = 0; j < n; j++) {
          const pts = vs.map((v: any) => { const o = +(v.lines?.[j]?.segmentParams?.[0] ?? 0), md = P(v.miterDirection), p = P(v.vertex); return { x: p.x + md.x * o, y: p.y + md.y * o }; });
          if (pts.length >= 2) emit({ type: 'poly', ...b, pts, closed: !!(r.flags & 2) }, m, inherit);
        }
        break;
      }
      case 'TOLERANCE': {
        const text = cleanMText(String(r.text ?? '')).replace(/%%v/gi, ' | ').trim();
        if (text) convert({ type: 'MTEXT', layer, _color: color, position: r.insertionPoint, height: r.textHeight ?? 2.5, text, attachmentPoint: 1 }, m, inherit, depth + 1);
        break;
      }
      case 'XLINE': case 'RAY': infinite.push({ r, m, inherit }); break; // desenhadas depois, do tamanho do desenho
      case 'ATTDEF': case 'SEQEND': case 'VERTEX': case 'VIEWPORT': break; // definições de atributo não aparecem em blocos inseridos
      default: skip(String(r.type));
    }
  };

  const total = raw.entities.length;
  raw.entities.forEach((r, i) => {
    convert(r, I, {}, 0);
    if (i % 2000 === 0) onCount(i, total);
  });
  onCount(total, total);

  // linhas de construção (infinitas): desenhadas com 2× o tamanho do desenho
  if (infinite.length) {
    const box = robustBox(out);
    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1) * 2;
    for (const { r, m, inherit } of infinite) {
      const p = { x: +r.firstPoint?.x || 0, y: +r.firstPoint?.y || 0 }, u = { x: +r.unitDirection?.x || 1, y: +r.unitDirection?.y || 0 };
      const a = r.type === 'RAY' ? p : { x: p.x - u.x * span, y: p.y - u.y * span };
      emit({ type: 'line', layer: String(r.layer ?? '0'), color: r._color, a, b: { x: p.x + u.x * span, y: p.y + u.y * span } } as NewEntity, m, inherit);
    }
  }

  // layouts (paper space): convertidos à parte e colocados ao lado do desenho, numa camada própria
  const paperRaw = raw.paper.filter((r) => r.type !== 'VIEWPORT');
  if (paperRaw.length) {
    const start = out.length;
    for (const r of paperRaw) convert(r, I, {}, 0);
    const added = out.splice(start);
    if (added.length) {
      const model = robustBox(out), sheet = robustBox(added);
      const gap = Math.max(model.maxX - model.minX, sheet.maxX - sheet.minX, 1) * 0.15;
      const dx = isFinite(model.maxX) ? model.maxX + gap - sheet.minX : 0, dy = isFinite(model.minY) ? model.minY - sheet.minY : 0;
      const m = translate(dx, dy);
      const sheetLayer = 'Folha (layout)';
      addLayer(sheetLayer, '#c792ff');
      for (const e of added) { const t = transformEntity(e, m); if (!t.color) t.color = addLayer(t.layer).color; t.layer = sheetLayer; out.push(t); }
    }
  }

  d.entities = out;
  d.current = '0';
  return { drawing: d, skipped };
}

/** Contornos de uma hachura (polilinhas e arestas linha/arco/elipse/spline) em pontos. */
function hatchLoops(r: any): Pt[][] {
  const loops: Pt[][] = [];
  const P = (p: any): Pt => ({ x: +p?.x || 0, y: +p?.y || 0 });
  const arcPts = (c: Pt, rx: number, ry: number, rot: number, a0: number, a1: number, ccw: boolean) => {
    // em arestas horárias o DXF guarda os ângulos espelhados
    let s = ccw ? a0 : -a0, e = ccw ? a1 : -a1;
    let sw = e - s;
    if (ccw) { while (sw <= 0) sw += Math.PI * 2; } else { while (sw >= 0) sw -= Math.PI * 2; }
    if (Math.abs(Math.abs(a1 - a0) - Math.PI * 2) < 1e-9) sw = ccw ? Math.PI * 2 : -Math.PI * 2;
    const n = Math.max(8, Math.ceil(Math.abs(sw) / (Math.PI / 32)));
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = s + (sw * i) / n, x = rx * Math.cos(t), y = ry * Math.sin(t);
      out.push({ x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot) });
    }
    return out;
  };
  for (const path of r.boundaryPaths ?? []) {
    const pts: Pt[] = [];
    if (path.vertices) {
      const vs = path.vertices.map((v: any) => ({ ...P(v), bulge: +v.bulge || 0 }));
      vs.forEach((v: any, i: number) => {
        pts.push({ x: v.x, y: v.y });
        const nx = vs[(i + 1) % vs.length];
        if (v.bulge && (i < vs.length - 1 || path.isClosed !== false)) {
          const theta = 4 * Math.atan(v.bulge), d = Math.hypot(nx.x - v.x, nx.y - v.y);
          if (d > 0) {
            const rr = d / (2 * Math.sin(Math.abs(theta) / 2)), mx = (v.x + nx.x) / 2, my = (v.y + nx.y) / 2;
            const h = Math.sqrt(Math.max(rr * rr - (d * d) / 4, 0)) * Math.sign(v.bulge) * (Math.abs(theta) > Math.PI ? -1 : 1);
            const c = { x: mx - ((nx.y - v.y) / d) * h, y: my + ((nx.x - v.x) / d) * h };
            const a0 = Math.atan2(v.y - c.y, v.x - c.x);
            const n = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 32)));
            for (let k = 1; k < n; k++) pts.push({ x: c.x + rr * Math.cos(a0 + (theta * k) / n), y: c.y + rr * Math.sin(a0 + (theta * k) / n) });
          }
        }
      });
    } else {
      for (const ed of path.edges ?? []) {
        let seg: Pt[] = [];
        if (ed.type === 1) seg = [P(ed.start), P(ed.end)];
        else if (ed.type === 2) seg = arcPts(P(ed.center), +ed.radius, +ed.radius, 0, +ed.startAngle, +ed.endAngle, ed.isCCW !== false);
        else if (ed.type === 3) {
          const mj = P(ed.end), R = Math.hypot(mj.x, mj.y);
          seg = arcPts(P(ed.center), R, R * (+ed.lengthOfMinorAxis || 1), Math.atan2(mj.y, mj.x), +ed.startAngle, +ed.endAngle, ed.isCCW !== false);
        } else if (ed.type === 4) {
          seg = splinePoints({ controlPoints: ed.controlPoints, knotValues: ed.knots, degreeOfSplineCurve: ed.degree, weights: ed.controlPoints?.map((c: any) => c.weight ?? 1), fitPoints: ed.fitDatum });
        }
        // evita repetir o ponto de junção entre arestas
        if (pts.length && seg.length && Math.hypot(pts[pts.length - 1].x - seg[0].x, pts[pts.length - 1].y - seg[0].y) < 1e-9) seg = seg.slice(1);
        pts.push(...seg);
      }
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
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
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%');
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
