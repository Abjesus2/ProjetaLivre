// Caixas exatas de arcos/elipses/polilinhas com curvas e transformação sem cópia profunda.
import { entityBox, tessellate, transformEntity, translate, rotateAbout, scaleAbout, mirrorAbout, compose, textWidth } from './.build/geom.mjs';

const R = [];
const check = (n, ok, extra = '') => R.push(`${ok ? 'OK  ' : 'FALHA'} | ${n}${extra ? ' -> ' + extra : ''}`);
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rr = (a, b) => a + rnd() * (b - a);

const randomEnt = (k) => {
  const c = { x: rr(-500, 500), y: rr(-500, 500) };
  switch (k % 4) {
    case 0: return { id: 'a', type: 'arc', layer: '0', c, r: rr(0.01, 3000), start: rr(-7, 7), end: rr(-7, 7) };
    case 1: return { id: 'e', type: 'ellipse', layer: '0', c, major: { x: rr(-300, 300), y: rr(-300, 300) }, ratio: rr(0.05, 1), start: rr(0, 6.28), end: rr(0, 6.28) };
    case 2: {
      const n = 2 + Math.floor(rnd() * 5);
      const pts = Array.from({ length: n }, () => ({ x: rr(-200, 200), y: rr(-200, 200) }));
      return { id: 'p', type: 'poly', layer: '0', pts, closed: rnd() < 0.5, bulges: pts.map(() => (rnd() < 0.7 ? rr(-3, 3) : 0)) };
    }
    default: return { id: 'c', type: 'circle', layer: '0', c, r: rr(0.01, 900) };
  }
};

// a caixa exata contém todos os pontos de uma amostragem bem densa e não é maior que ela
let contains = true, tight = true, worst = '';
for (let k = 0; k < 4000; k++) {
  const e = randomEnt(k);
  const b = entityBox(e);
  const pts = tessellate(e, 1e4).flat();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const size = Math.max(maxX - minX, maxY - minY, 1);
  const eps = 1e-9 * Math.max(1, Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
  if (minX < b.minX - eps || minY < b.minY - eps || maxX > b.maxX + eps || maxY > b.maxY + eps) { contains = false; worst ||= JSON.stringify(e); }
  // folga máxima tolerada: o erro da própria amostragem
  const slack = 2e-3 * size;
  if (b.minX < minX - slack || b.minY < minY - slack || b.maxX > maxX + slack || b.maxY > maxY + slack) { tight = false; worst ||= 'folga ' + JSON.stringify(e); }
}
check('caixa de arco/elipse/curva contém a figura inteira', contains, worst);
check('caixa justa (não maior que a figura)', tight, worst);

// transformEntity: mesmo resultado da versão com cópia profunda e original intacto
const deep = (e, m) => {
  // referência: cópia profunda + mesma transformação
  const o = structuredClone(e);
  return JSON.stringify(transformEntity(o, m));
};
const kinds = [
  { id: 'l', type: 'line', layer: 'A', color: '#ff0000', a: { x: 1, y: 2 }, b: { x: 3, y: 4 } },
  { id: 't', type: 'text', layer: 'A', p: { x: 1, y: 2 }, h: 3, text: 'Olá', rot: 0.3 },
  { id: 'd', type: 'dim', layer: 'A', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, off: { x: 5, y: 3 }, h: 2 },
  { id: 'h', type: 'hatch', layer: 'A', solid: false, loops: [[{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]], pattern: [{ angle: 0.7, base: { x: 0, y: 0 }, offset: { x: 1, y: 1 } }] },
  { id: 'pt', type: 'point', layer: 'A', p: { x: 7, y: 8 } },
  ...[0, 1, 2, 3].map(randomEnt),
];
const mats = [translate(5, -3), rotateAbout({ x: 2, y: 1 }, 0.8), scaleAbout({ x: 0, y: 0 }, 2.5), mirrorAbout({ x: 0, y: 0 }, { x: 1, y: 2 }), compose(rotateAbout({ x: 0, y: 0 }, 1), mirrorAbout({ x: 1, y: 0 }, { x: 1, y: 1 }))];
let same = true, intact = true;
for (const e of kinds) for (const m of mats) {
  const before = JSON.stringify(e);
  const out = transformEntity(e, m);
  if (JSON.stringify(out) !== deep(e, m)) same = false;
  if (JSON.stringify(e) !== before) intact = false;
  // nenhuma lista/ponto compartilhado com a original
  for (const k of Object.keys(out)) if (typeof out[k] === 'object' && out[k] !== null && out[k] === e[k]) intact = false;
}
check('transformEntity sem cópia profunda: mesmo resultado', same);
check('transformEntity não altera nem compartilha dados com a original', intact);

// largura de texto: caracteres largos (japonês/chinês, emoji) ocupam mais que os da fonte monoespaçada
check('texto com caracteres largos tem caixa mais larga', textWidth({ text: '設計図面', h: 1 }) > textWidth({ text: 'abcd', h: 1 }) * 1.5 && textWidth({ text: 'ab\nabcd', h: 1 }) === textWidth({ text: 'abcd', h: 1 }));

console.log(R.join('\n'));
process.exit(R.some((l) => l.startsWith('FALHA')) ? 1 : 0);
