// Índice espacial em níveis: toda consulta devolve (pelo menos) tudo o que toca a janela,
// mesmo com objetos muito distantes e objetos inseridos depois; e não degenera.
import { GridIndex } from './.build/spatial.mjs';

const R = [];
const check = (n, ok, extra = '') => R.push(`${ok ? 'OK  ' : 'FALHA'} | ${n}${extra ? ' -> ' + extra : ''}`);
let seed = 5;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const mk = (n) => {
  const ents = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * 1000, y = rnd() * 800, big = rnd() < 0.05, w = big ? rnd() * 600 : rnd() * 12, h = big ? rnd() * 500 : rnd() * 12;
    ents.push({ id: 'e' + i, box: { minX: x, minY: y, maxX: x + w, maxY: y + h } });
  }
  // lixo muito distante e um objeto que atravessa tudo
  ents.push({ id: 'longe', box: { minX: 5e7, minY: 5e7, maxX: 5e7 + 1, maxY: 5e7 + 1 } });
  ents.push({ id: 'longe2', box: { minX: -3e8, minY: 10, maxX: -3e8 + 2, maxY: 12 } });
  ents.push({ id: 'atravessa', box: { minX: -1e6, minY: 400, maxX: 1e6, maxY: 401 } });
  return ents;
};
const hits = (e, q) => !(e.box.maxX < q.minX || e.box.minX > q.maxX || e.box.maxY < q.minY || e.box.minY > q.maxY);

const ents = mk(20000);
const ix = new GridIndex(ents, (e) => e.box);
let complete = true, total = 0, cand = 0;
const queries = [];
for (let k = 0; k < 400; k++) {
  const x = rnd() * 1100 - 50, y = rnd() * 900 - 50, s = k % 10 === 0 ? rnd() * 900 : rnd() * 30;
  queries.push({ minX: x, minY: y, maxX: x + s, maxY: y + s });
}
queries.push({ minX: 5e7 - 1, minY: 5e7 - 1, maxX: 5e7 + 2, maxY: 5e7 + 2 }, { minX: -3e8 - 1, minY: 0, maxX: -3e8 + 5, maxY: 20 }, { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 });
for (const q of queries) {
  const got = new Set(ix.query(q));
  const want = ents.filter((e) => hits(e, q));
  if (want.some((e) => !got.has(e))) complete = false;
  total += want.length; cand += got.size;
}
check('consulta devolve tudo o que toca a janela (inclusive objetos muito distantes)', complete);
// sem degenerar: candidatos devolvidos ficam perto do necessário (antes, um objeto distante fazia toda consulta devolver tudo)
const small = queries.slice(0, 400).filter((_, k) => k % 10 !== 0);
let sc = 0, sw = 0;
for (const q of small) { sc += ix.query(q).length; sw += ents.filter((e) => hits(e, q)).length; }
check('consultas pequenas não varrem o desenho (objetos distantes não esticam a grade)', sc / small.length < 600, `${(sc / small.length).toFixed(0)} candidatos por consulta, ${(sw / small.length).toFixed(1)} necessários`);

// inserções depois de montar
const extra = [];
for (let i = 0; i < 3000; i++) { const x = rnd() * 2000 - 500, y = rnd() * 2000 - 500; const e = { id: 'n' + i, box: { minX: x, minY: y, maxX: x + rnd() * 50, maxY: y + rnd() * 50 } }; extra.push(e); ix.insert(e); }
let complete2 = true;
for (let k = 0; k < 300; k++) {
  const x = rnd() * 2200 - 600, y = rnd() * 2200 - 600, s = rnd() * 80;
  const q = { minX: x, minY: y, maxX: x + s, maxY: y + s };
  const got = new Set(ix.query(q));
  if ([...ents, ...extra].filter((e) => hits(e, q)).some((e) => !got.has(e))) complete2 = false;
}
check('objetos inseridos depois (também fora da extensão original) são achados', complete2);
check('índice pede remontagem depois de muitas inserções', new GridIndex(ents.slice(0, 100), (e) => e.box).worn === false && (() => { const g = new GridIndex(ents.slice(0, 100), (e) => e.box); for (let i = 0; i < 600; i++) g.insert(extra[i]); return g.worn; })());

// desenho vazio no começo e depois cheio de inserções
{
  const g = new GridIndex([], (e) => e.box);
  for (const e of extra.slice(0, 400)) g.insert(e);
  const q = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
  const got = new Set(g.query(q));
  check('índice montado vazio continua achando o que foi inserido', extra.slice(0, 400).filter((e) => hits(e, q)).every((e) => got.has(e)));
}

// cópia grande para fora da área da grade: o índice pede remontagem (senão cada consulta perto
// das cópias varreria todas, encostadas na mesma célula da borda)
{
  const base = ents.slice(0, 5000);
  const g = new GridIndex(base, (e) => e.box);
  let k = 0;
  while (!g.worn && k < base.length) { const e = base[k++]; g.insert({ id: 'c' + k, box: { minX: e.box.minX - 3000, minY: e.box.minY - 3000, maxX: e.box.maxX - 3000, maxY: e.box.maxY - 3000 } }); }
  check('cópia grande para fora da área do índice pede remontagem cedo', g.worn && k <= 600, `${k} inserções`);
}

console.log(R.join('\n'));
process.exit(R.some((l) => l.startsWith('FALHA')) ? 1 : 0);
