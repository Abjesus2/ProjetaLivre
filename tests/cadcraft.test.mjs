// Leitor CADCraft (WebAssembly) e o caminho até o editor e o visualizador: lê DWG e DXF, a lista de
// desenho é coerente, o detalhe de uma janela é um recorte, o formato do editor vira objetos
// editáveis, e um arquivo inválido dá erro sem derrubar o leitor.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadCraft } from './.build/bridge.mjs';
import { parseDisplay, visibleRuns } from './.build/format.mjs';
import { fromRaw } from './.build/raw.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const R = [];
const check = (n, ok, extra = '') => R.push(`${ok ? 'OK  ' : 'FALHA'} | ${n}${extra ? ' -> ' + extra : ''}`);
const fx = (f) => readFileSync(join(here, 'fixtures', f));

const mod = await WebAssembly.compile(readFileSync(join(here, '..', 'src', 'io', 'cadcraft', 'projetalivre_cadcraft.wasm')));
const cc = await CadCraft.create(mod);

/** coerência interna da lista de desenho */
function coherent(d) {
  const nv = d.lineCol.length, problems = [];
  if (d.lineIdx.some((i) => i >= nv)) problems.push('índice fora dos vértices');
  if (d.lineIdx.length % 2) problems.push('índices ímpares');
  for (const [k, st, end] of [['linhas', d.lineStart, d.lineIdx.length], ['triângulos', d.triStart, d.triCol.length], ['pontos', d.ptStart, d.ptCol.length]]) {
    for (let i = 1; i < st.length; i++) if (st[i] < st[i - 1]) problems.push(`${k}: camadas fora de ordem`);
    if (st[st.length - 1] !== end) problems.push(`${k}: fim da última camada`);
  }
  if (d.triCol.length % 3) problems.push('triângulos incompletos');
  if (![...d.linePos, ...d.triPos, ...d.ptPos].every(Number.isFinite)) problems.push('coordenada inválida');
  const inside = (a, b) => a.x0 >= b.x0 - 1e-6 && a.y0 >= b.y0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.y1 <= b.y1 + 1e-6;
  if (!inside(d.robust, d.full)) problems.push('extensão robusta fora da completa');
  return problems;
}

// ---- DWG
cc.open(fx('sample-bracket.dwg'), 'sample-bracket.dwg');
const dwgInfo = cc.info();
check('DWG abre e lista camadas e objetos', dwgInfo.layers.length > 1 && dwgInfo.entities > 0, `${dwgInfo.layers.length} camadas, ${dwgInfo.entities} objetos`);
const dwgView = parseDisplay(cc.display(0));
check('lista de desenho do DWG é coerente', coherent(dwgView).length === 0, coherent(dwgView).join('; '));
check('uma faixa de traços por camada (+ sem camada)', dwgView.layers === dwgInfo.layers.length + 1 && dwgView.lineStart.length === dwgView.layers + 1);
check('o DWG desenha traços', dwgView.lineIdx.length > 0);
// desligar camadas tira traços
const all = visibleRuns(dwgView.lineStart, () => true).reduce((s, [a, z]) => s + z - a, 0);
const some = visibleRuns(dwgView.lineStart, (l) => l % 2 === 0).reduce((s, [a, z]) => s + z - a, 0);
check('camadas desligadas não entram no desenho', all === dwgView.lineIdx.length && some < all);
const dwgRaw = JSON.parse(cc.raw());
const dwgEd = fromRaw(dwgRaw, 'b', () => {});
check('DWG vira objetos editáveis', dwgEd.drawing.entities.length >= dwgInfo.entities, `${dwgEd.drawing.entities.length} objetos`);

// ---- mesmo desenho em DXF: mesmas camadas e objetos
cc.open(fx('sample-bracket.dxf'), 'sample-bracket.dxf');
const dxfInfo = cc.info();
const names = (i) => i.layers.map((l) => l.name).sort().join('|');
check('DWG e DXF do mesmo desenho têm as mesmas camadas', names(dxfInfo) === names(dwgInfo));
const dxfEd = fromRaw(JSON.parse(cc.raw()), 'b', () => {});
check('DWG e DXF do mesmo desenho dão os mesmos objetos editáveis', dxfEd.drawing.entities.length === dwgEd.drawing.entities.length, `${dxfEd.drawing.entities.length} × ${dwgEd.drawing.entities.length}`);

// ---- planta em DXF: textos continuam textos editáveis; folhas; janela de detalhe
cc.open(fx('sample-floorplan.dxf'), 'sample-floorplan.dxf');
const fp = fromRaw(JSON.parse(cc.raw()), 'f', () => {});
const texts = fp.drawing.entities.filter((e) => e.type === 'text').map((e) => e.text);
check('textos do DXF chegam ao editor como texto', texts.some((t) => /LIVING/i.test(t)), texts.join(', '));
const used = new Set(fp.drawing.entities.map((e) => e.layer));
check('todo objeto do editor está numa camada existente', [...used].every((n) => fp.drawing.layers.some((l) => l.name === n)));
const fpInfo = cc.info();
const base = parseDisplay(cc.display(0));
const cx = (base.robust.x0 + base.robust.x1) / 2, cy = (base.robust.y0 + base.robust.y1) / 2;
const w = (base.robust.x1 - base.robust.x0) / 6, h = (base.robust.y1 - base.robust.y0) / 6;
const det = parseDisplay(cc.display(0, base.tolerance / 10, [cx - w, cy - h, cx + w, cy + h]));
check('detalhe de uma janela é coerente', coherent(det).length === 0, coherent(det).join('; '));
const bw = base.full.x1 - base.full.x0, bh = base.full.y1 - base.full.y0;
const corner = parseDisplay(cc.display(0, base.tolerance, [base.full.x0, base.full.y0, base.full.x0 + bw / 10, base.full.y0 + bh / 10]));
check('janela num canto traz menos traços que o desenho todo', corner.lineIdx.length < base.lineIdx.length, `${corner.lineIdx.length / 2} × ${base.lineIdx.length / 2} segmentos`);
const away = parseDisplay(cc.display(0, base.tolerance, [base.full.x1 + bw * 5, base.full.y1 + bh * 5, base.full.x1 + bw * 6, base.full.y1 + bh * 6]));
check('janela longe do desenho não traz nada', away.lineIdx.length === 0 && away.triCol.length === 0);
check('detalhe usa tolerância mais fina', det.tolerance < base.tolerance);
check('folhas listadas sem quebrar', Array.isArray(fpInfo.sheets) && fpInfo.activeSheet >= 0 && fpInfo.activeSheet <= fpInfo.sheets.length);
if (fpInfo.sheets.length) {
  const sheet = parseDisplay(cc.display(1));
  check('folha tem o papel como enquadramento', sheet.sheet !== null && sheet.sheet.x1 > sheet.sheet.x0);
}

// ---- bloco inserido numa camada congelada: some inteiro (como no AutoCAD), inclusive o conteúdo
// que está em camadas ligadas; aparece só se a camada for mostrada. Muitos blocos (mais cópias que
// o limite do renderizador, 2 milhões): a imagem não fica cortada.
const dxf = (n) => {
  const o = []; const g = (c, v) => o.push(String(c), String(v));
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, 5);
  for (const [name, flags, color] of [['0', 0, 7], ['PALETES', 0, 1], ['EIXOS', 0, 8], ['XREF', 1, 7], ['FIM', 0, 3]]) { g(0, 'LAYER'); g(2, name); g(70, flags); g(62, color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'BLOCKS');
  g(0, 'BLOCK'); g(8, '0'); g(2, 'PALETE'); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, 'PALETE');
  for (let i = 0; i < 150; i++) { g(0, 'LINE'); g(8, 'PALETES'); g(10, i % 10); g(20, Math.floor(i / 10)); g(30, 0); g(11, (i % 10) + 0.8); g(21, Math.floor(i / 10) + 0.5); g(31, 0); }
  g(0, 'ENDBLK'); g(8, '0');
  g(0, 'BLOCK'); g(8, '0'); g(2, 'GRADE'); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, 'GRADE');
  for (let i = 0; i < 30; i++) { g(0, 'LINE'); g(8, 'EIXOS'); g(10, i * 70); g(20, -500); g(30, 0); g(11, i * 70); g(21, 3000); g(31, 0); }
  g(0, 'ENDBLK'); g(8, '0'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  g(0, 'INSERT'); g(8, 'XREF'); g(2, 'GRADE'); g(10, 0); g(20, 0); g(30, 0);
  for (let i = 0; i < n; i++) { g(0, 'INSERT'); g(8, 'PALETES'); g(2, 'PALETE'); g(10, (i % 200) * 12); g(20, Math.floor(i / 200) * 18); g(30, 0); }
  g(0, 'CIRCLE'); g(8, 'FIM'); g(10, 1200); g(20, 900); g(30, 0); g(40, 300);
  g(0, 'ENDSEC'); g(0, 'EOF');
  return new TextEncoder().encode(o.join('\n') + '\n');
};
const segs = (d, info, name) => { const i = info.layers.findIndex((l) => l.name === name); return (d.lineStart[i + 1] - d.lineStart[i]) / 2; };
cc.open(dxf(20), 'congelada.dxf');
let info = cc.info();
let img = parseDisplay(cc.display(0));
check('bloco em camada congelada não aparece (nem o conteúdo em camada ligada)', segs(img, info, 'EIXOS') === 0 && segs(img, info, 'PALETES') > 0);
check('camada congelada com objetos aparece na lista como usada', info.layers.find((l) => l.name === 'XREF')?.used === true);
const mask = new Uint8Array(info.layers.length); mask[info.layers.findIndex((l) => l.name === 'XREF')] = 1;
cc.forceLayers(mask);
img = parseDisplay(cc.display(0));
check('ao mostrar a camada congelada, o bloco aparece', segs(img, info, 'EIXOS') > 0);
cc.forceLayers(new Uint8Array(info.layers.length));
const ed = fromRaw(JSON.parse(cc.raw()), 'c', () => {});
const eixos = ed.drawing.entities.filter((e) => e.type === 'line' && Math.abs(e.a.y + 500) < 1e-6 && Math.abs(e.b.y - 3000) < 1e-6);
const xref = ed.drawing.layers.find((l) => l.name === 'XREF');
check('no editor, o conteúdo do bloco congelado fica oculto junto com a camada dele', eixos.length === 30 && eixos.every((e) => e.layer === 'XREF') && xref && !xref.visible);
check('no editor, ele mantém a cor que teria na camada original', eixos.every((e) => e.color && e.color.toLowerCase() !== (xref?.color ?? '').toLowerCase()), eixos[0]?.color);

const N = 20000; // 3 milhões de cópias de objetos de blocos
cc.open(dxf(N), 'muitos-blocos.dxf');
info = cc.info();
img = parseDisplay(cc.display(0));
check('muitos blocos: imagem completa, sem corte', !img.truncated && segs(img, info, 'PALETES') === N * 150, `${segs(img, info, 'PALETES')} de ${N * 150} segmentos`);
check('muitos blocos: o último objeto do desenho aparece', segs(img, info, 'FIM') > 0);
check('muitos blocos: lista coerente', coherent(img).length === 0, coherent(img).join('; '));

// ---- bloco inserido em pé (extrusão (0,-1,0): uma vista lateral 100×300 num desenho 3D), solto e
// dentro de outro bloco: visto de cima, fica de perfil (vira uma linha na posição dele), como no
// AutoCAD; antes aparecia deitado na planta, com linhas compridas que não existem na vista de cima.
const tiltDxf = () => {
  const o = []; const g = (c, v) => o.push(String(c), String(v));
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, 3);
  for (const [n, c] of [['0', 7], ['ELEV', 8], ['PLANTA', 3]]) { g(0, 'LAYER'); g(2, n); g(70, 0); g(62, c); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC'); g(0, 'SECTION'); g(2, 'BLOCKS');
  g(0, 'BLOCK'); g(8, '0'); g(2, 'ELEV'); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, 'ELEV');
  for (const x of [0, 50, 100]) { g(0, 'LINE'); g(8, 'ELEV'); g(10, x); g(20, 0); g(30, 0); g(11, x); g(21, 300); g(31, 0); }
  for (const y of [0, 100, 200, 300]) { g(0, 'LINE'); g(8, 'ELEV'); g(10, 0); g(20, y); g(30, 0); g(11, 100); g(21, y); g(31, 0); }
  g(0, 'ENDBLK'); g(8, '0');
  g(0, 'BLOCK'); g(8, '0'); g(2, 'GRUPO'); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, 'GRUPO');
  g(0, 'INSERT'); g(8, '0'); g(2, 'ELEV'); g(10, 500); g(20, 0); g(30, -200); g(210, 0); g(220, -1); g(230, 0);
  g(0, 'ENDBLK'); g(8, '0'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  g(0, 'LINE'); g(8, 'PLANTA'); g(10, 400); g(20, 150); g(30, 0); g(11, 700); g(21, 150); g(31, 0);
  g(0, 'INSERT'); g(8, '0'); g(2, 'ELEV'); g(10, 500); g(20, 0); g(30, -200); g(210, 0); g(220, -1); g(230, 0);
  g(0, 'INSERT'); g(8, '0'); g(2, 'GRUPO'); g(10, 0); g(20, 1000); g(30, 0);
  // círculo e arco em pé (centros no mundo (700,200,50) e (900,200,50))
  g(0, 'CIRCLE'); g(8, 'ELEV'); g(10, 700); g(20, 50); g(30, -200); g(40, 40); g(210, 0); g(220, -1); g(230, 0);
  g(0, 'ARC'); g(8, 'ELEV'); g(10, 900); g(20, 50); g(30, -200); g(40, 40); g(50, 0); g(51, 180); g(210, 0); g(220, -1); g(230, 0);
  g(0, 'ENDSEC'); g(0, 'EOF');
  return new TextEncoder().encode(o.join('\n') + '\n');
};
cc.open(tiltDxf(), 'em-pe.dxf');
info = cc.info();
img = parseDisplay(cc.display(0));
const li = info.layers.findIndex((l) => l.name === 'ELEV');
const ys = [];
for (let k = img.lineStart[li]; k < img.lineStart[li + 1]; k++) ys.push(img.linePos[img.lineIdx[k] * 2 + 1] + img.origin.y);
const near = (v, t) => Math.abs(v - t) < 1e-3;
check('bloco, círculo e arco em pé ficam de perfil na vista de cima (também dentro de outro bloco)', ys.length > 0 && ys.every((y) => near(y, 200) || near(y, 1200)) && ys.some((y) => near(y, 1200)), `y em ${[...new Set(ys.map((y) => y.toFixed(1)))].join(', ')}`);
const edT = fromRaw(JSON.parse(cc.raw()), 't', () => {});
const ysEd = edT.drawing.entities.filter((e) => e.layer === 'ELEV').flatMap((e) => (e.type === 'line' ? [e.a.y, e.b.y] : (e.pts ?? []).map((q) => q.y)));
check('no editor também', ysEd.length > 0 && ysEd.every((y) => near(y, 200) || near(y, 1200)));

// ---- arquivo inválido: erro com mensagem, e o leitor continua funcionando
let msg = '';
try { cc.open(new TextEncoder().encode('isto não é um desenho'), 'ruim.dwg'); } catch (e) { msg = e.message; }
check('arquivo inválido dá erro com mensagem', msg.length > 0, msg.slice(0, 80));
cc.open(fx('sample-floorplan.dxf'), 'sample-floorplan.dxf');
check('leitor continua funcionando depois do erro', cc.info().entities > 0);

console.log('== CADCraft (leitor e listas de desenho) ==');
for (const r of R) console.log(r);
process.exit(R.some((r) => r.startsWith('FALHA')) ? 1 : 0);
