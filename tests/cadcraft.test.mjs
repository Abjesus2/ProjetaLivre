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

// ---- arquivo inválido: erro com mensagem, e o leitor continua funcionando
let msg = '';
try { cc.open(new TextEncoder().encode('isto não é um desenho'), 'ruim.dwg'); } catch (e) { msg = e.message; }
check('arquivo inválido dá erro com mensagem', msg.length > 0, msg.slice(0, 80));
cc.open(fx('sample-floorplan.dxf'), 'sample-floorplan.dxf');
check('leitor continua funcionando depois do erro', cc.info().entities > 0);

console.log('== CADCraft (leitor e listas de desenho) ==');
for (const r of R) console.log(r);
process.exit(R.some((r) => r.startsWith('FALHA')) ? 1 : 0);
