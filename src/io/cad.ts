import { aciToHex, rgbIntToHex } from '../core/aci';
import { EXTRA_DXF_HANDLERS } from './dxfExtra';
import { fromRaw, type RawDoc, type RawLayer, type CadResult } from './raw';
export type { CadResult } from './raw';

// Leitura de DWG/DXF sem depender do DOM: roda dentro de um Web Worker para não travar a tela.

export type Progress = (stage: string, pct: number) => void;

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