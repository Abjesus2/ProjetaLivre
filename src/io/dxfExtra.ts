// Tipos de objeto que o dxf-parser ignora (hachuras, atributos de bloco, chamadas, tabelas…).
// Cada leitor junta os pares "código/valor" do DXF e devolve um objeto no mesmo formato que
// a libredwg-web usa para DWG, para que a conversão seja uma só.
import { ACI } from '../core/aci';

type Pair = [number, any];
const DEG = Math.PI / 180;

function collect(scanner: any, curr: any): { pairs: Pair[]; base: any } {
  const base: any = { type: curr.value };
  const pairs: Pair[] = [];
  curr = scanner.next();
  while (!scanner.isEOF() && curr.code !== 0) {
    switch (curr.code) {
      case 8: base.layer = curr.value; break;
      case 62: base.colorIndex = curr.value; if (curr.value > 0 && curr.value < 256) base.color = parseInt(ACI[curr.value].slice(1), 16); break;
      case 420: base.color = curr.value; break;
      case 67: base.inPaperSpace = curr.value !== 0; break;
      case 60: base.visible = curr.value === 0; break;
      default: pairs.push([curr.code, curr.value]);
    }
    curr = scanner.next();
  }
  // como os leitores do dxf-parser: para no código 0 da próxima entidade, sem voltar
  return { pairs, base };
}

/** leitor sequencial de pares */
class Reader {
  i = 0;
  constructor(public p: Pair[]) {}
  get done() { return this.i >= this.p.length; }
  peek() { return this.p[this.i]?.[0]; }
  next() { return this.p[this.i++]; }
  /** valor do próximo código igual a `code` a partir da posição atual */
  take(code: number, dflt?: any) { const j = this.p.findIndex((q, k) => k >= this.i && q[0] === code); if (j < 0) return dflt; this.i = j + 1; return this.p[j][1]; }
  pt(cx: number) { const x = this.take(cx, 0); const y = this.p[this.i]?.[0] === cx + 10 ? this.next()[1] : 0; if (this.p[this.i]?.[0] === cx + 20) this.i++; return { x: +x, y: +y }; }
}
const first = (p: Pair[], code: number, d?: any) => { const f = p.find((q) => q[0] === code); return f ? f[1] : d; };
const point = (p: Pair[], cx: number) => ({ x: +first(p, cx, 0), y: +first(p, cx + 10, 0) });
const all = (p: Pair[], code: number) => p.filter((q) => q[0] === code).map((q) => q[1]);

function handler(name: string, build: (pairs: Pair[], base: any) => any) {
  return class {
    ForEntityName = name;
    parseEntity(scanner: any, curr: any) { const { pairs, base } = collect(scanner, curr); return { ...base, ...build(pairs, base) }; }
  };
}

const Hatch = handler('HATCH', (p) => {
  const r = new Reader(p);
  const patternName = r.take(2, '');
  const solidFill = r.take(70, 0);
  const nPaths = r.take(91, 0);
  const boundaryPaths: any[] = [];
  for (let k = 0; k < nPaths; k++) {
    const flag = r.take(92, 0);
    if (flag & 2) {
      const hasBulge = r.take(72, 0); const isClosed = r.take(73, 1); const n = r.take(93, 0);
      const vertices: any[] = [];
      for (let j = 0; j < n; j++) { const v: any = r.pt(10); v.bulge = hasBulge && r.peek() === 42 ? +r.next()[1] : 0; vertices.push(v); }
      boundaryPaths.push({ boundaryPathTypeFlag: flag, hasBulge: !!hasBulge, isClosed: !!isClosed, vertices });
    } else {
      const n = r.take(93, 0);
      const edges: any[] = [];
      for (let j = 0; j < n; j++) {
        const t = r.take(72, 1);
        if (t === 1) edges.push({ type: 1, start: r.pt(10), end: r.pt(11) });
        else if (t === 2) edges.push({ type: 2, center: r.pt(10), radius: +r.take(40, 0), startAngle: r.take(50, 0) * DEG, endAngle: r.take(51, 360) * DEG, isCCW: !!r.take(73, 1) });
        else if (t === 3) edges.push({ type: 3, center: r.pt(10), end: r.pt(11), lengthOfMinorAxis: +r.take(40, 1), startAngle: r.take(50, 0) * DEG, endAngle: r.take(51, 360) * DEG, isCCW: !!r.take(73, 1) });
        else if (t === 4) {
          const degree = r.take(94, 3); r.take(73); r.take(74);
          const nk = r.take(95, 0), nc = r.take(96, 0);
          const knots: number[] = []; for (let q = 0; q < nk; q++) knots.push(+r.take(40, 0));
          const controlPoints: any[] = [];
          for (let q = 0; q < nc; q++) { const c: any = r.pt(10); if (r.peek() === 42) c.weight = +r.next()[1]; controlPoints.push(c); }
          const fitDatum: any[] = [];
          if (r.peek() === 97) { const nf = r.next()[1]; for (let q = 0; q < nf; q++) fitDatum.push(r.pt(11)); }
          edges.push({ type: 4, degree, knots, controlPoints, fitDatum });
        }
      }
      boundaryPaths.push({ boundaryPathTypeFlag: flag, edges });
    }
    const nSrc = r.peek() === 97 ? r.next()[1] : 0;
    for (let q = 0; q < nSrc; q++) if (r.peek() === 330) r.next();
  }
  const nDef = r.take(78, 0);
  const definitionLines: any[] = [];
  for (let k = 0; k < nDef; k++) {
    const angle = r.take(53, 0) * DEG; const base = r.pt(43); const offset = { x: +r.take(45, 0), y: +r.take(46, 0) };
    const nd = r.peek() === 79 ? r.next()[1] : 0; for (let q = 0; q < nd; q++) if (r.peek() === 49) r.next();
    definitionLines.push({ angle, base, offset });
  }
  return { patternName, solidFill, boundaryPaths, definitionLines };
});

const Leader = handler('LEADER', (p) => {
  const xs = all(p, 10), ys = all(p, 20);
  return { vertices: xs.map((x, i) => ({ x: +x, y: +(ys[i] ?? 0) })) };
});

const XLine = handler('XLINE', (p) => ({ firstPoint: point(p, 10), unitDirection: point(p, 11) }));
const Ray = handler('RAY', (p) => ({ firstPoint: point(p, 10), unitDirection: point(p, 11) }));

const Attrib = handler('ATTRIB', (p) => ({
  text: String(first(p, 1, '')),
  startPoint: point(p, 10), endPoint: point(p, 11),
  textHeight: +first(p, 40, 1), rotation: +first(p, 50, 0),
  halign: +first(p, 72, 0), valign: +first(p, 74, 0),
  invisible: (+first(p, 70, 0) & 1) === 1,
}));

const Tolerance = handler('TOLERANCE', (p) => ({ text: String(first(p, 1, '')), insertionPoint: point(p, 10) }));

const Table = handler('ACAD_TABLE', (p) => ({ name: String(first(p, 2, '')), startPoint: point(p, 10), directionVector: point(p, 11) }));

const MLine = handler('MLINE', (p) => {
  const r = new Reader(p);
  const scale = +r.take(40, 1); r.i = 0;
  const flags = +r.take(71, 0);
  const nv = +r.take(72, 0), nl = +r.take(73, 0);
  r.pt(10);
  const vertices: any[] = [];
  for (let k = 0; k < nv; k++) {
    const vertex = r.pt(11), vertexDirection = r.pt(12), miterDirection = r.pt(13);
    const lines: any[] = [];
    for (let j = 0; j < nl; j++) {
      const ns = r.take(74, 0); const segmentParams: number[] = [];
      for (let q = 0; q < ns; q++) if (r.peek() === 41) segmentParams.push(+r.next()[1]);
      const na = r.peek() === 75 ? r.next()[1] : 0; for (let q = 0; q < na; q++) if (r.peek() === 42) r.next();
      lines.push({ segmentParams });
    }
    vertices.push({ vertex, vertexDirection, miterDirection, lines });
  }
  return { scale, flags, vertices };
});

const MultiLeader = handler('MULTILEADER', (p) => {
  // conteúdo de texto, posição e linhas de chamada (dentro das seções LEADER_LINE{ … })
  const textContent = String(p.find((q) => q[0] === 304 && q[1] !== 'LEADER_LINE{')?.[1] ?? '');
  const anchorIdx = p.findIndex((q) => q[0] === 12);
  const textAnchor = anchorIdx >= 0 ? { x: +p[anchorIdx][1], y: +(p[anchorIdx + 1]?.[1] ?? 0) } : undefined;
  const textHeight = +first(p, 41, 2.5);
  const leaderLines: any[] = [];
  let cur: any[] | null = null;
  for (let i = 0; i < p.length; i++) {
    const [c, v] = p[i];
    if (c === 304 && v === 'LEADER_LINE{') cur = [];
    else if (c === 305 && cur) { if (cur.length) leaderLines.push({ vertices: cur }); cur = null; }
    else if (c === 10 && cur && p[i + 1]?.[0] === 20) cur.push({ x: +v, y: +p[i + 1][1] });
  }
  // último ponto da chamada (código 10 da seção LEADER{ é o ponto de conexão)
  const leaderIdx = p.findIndex((q) => q[0] === 302 && q[1] === 'LEADER{');
  let lastLeaderLinePoint: any;
  if (leaderIdx >= 0) { const j = p.findIndex((q, k) => k > leaderIdx && q[0] === 10); if (j >= 0) lastLeaderLinePoint = { x: +p[j][1], y: +p[j + 1][1] }; }
  return { textContent, textAnchor, textHeight, leaderSections: [{ lastLeaderLinePoint, leaderLines }] };
});

// tipos que reconhecemos mas não desenhamos (contados no aviso ao abrir)
const skip = (name: string) => handler(name, () => ({}));

export const EXTRA_DXF_HANDLERS = [Hatch, Leader, XLine, Ray, Attrib, Tolerance, Table, MLine, MultiLeader, skip('WIPEOUT'), skip('IMAGE'), skip('VIEWPORT'), skip('3DSOLID'), skip('REGION'), skip('BODY'), skip('OLE2FRAME')];
