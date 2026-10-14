// Desfazer/refazer por operações: comparado, passo a passo, com o modelo antigo (cópia JSON
// do desenho inteiro a cada alteração) numa sequência aleatória longa de edições.
import { Doc } from './.build/doc.mjs';

const R = [];
const check = (n, ok, extra = '') => R.push(`${ok ? 'OK  ' : 'FALHA'} | ${n}${extra ? ' -> ' + extra : ''}`);

/** modelo de referência: o comportamento antigo */
class RefDoc {
  constructor(d) { this.d = d; this.u = []; this.r = []; this.n = 0; }
  checkpoint() { this.u.push(JSON.stringify(this.d)); if (this.u.length > 200) this.u.shift(); this.r = []; }
  undo() { const s = this.u.pop(); if (!s) return false; this.r.push(JSON.stringify(this.d)); this.d = JSON.parse(s); return true; }
  redo() { const s = this.r.pop(); if (!s) return false; this.u.push(JSON.stringify(this.d)); this.d = JSON.parse(s); return true; }
  layer(name) { return this.d.layers.find((l) => l.name === name); }
  add(e) { const x = { ...e, id: 'r' + this.n++ }; this.d.entities.push(x); return x; }
  remove(ids) { this.d.entities = this.d.entities.filter((e) => !ids.has(e.id)); }
  replace(e) { const i = this.d.entities.findIndex((x) => x.id === e.id); if (i >= 0) this.d.entities[i] = e; }
}

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const base = () => ({
  name: 'teste', current: '0',
  layers: [{ name: '0', color: '#ffffff', visible: true, locked: false }, { name: 'A', color: '#ff0000', visible: true, locked: false }],
  entities: Array.from({ length: 30 }, (_, i) => ({ id: 'b' + i, type: 'line', layer: i % 2 ? 'A' : '0', a: { x: i, y: 0 }, b: { x: i, y: 10 } })),
});

const doc = new Doc(structuredClone(base()));
const ref = new RefDoc(structuredClone(base()));
// espelho montado só pelos avisos de mudança (o que o índice e a tela usam)
let mirror = new Set(doc.d.entities);
let changeOk = true;
doc.on((c) => {
  if (c.reset) { mirror = new Set(doc.d.entities); return; }
  for (const e of c.removed) { if (!mirror.delete(e)) changeOk = false; }
  for (const e of c.added) { if (mirror.has(e)) changeOk = false; mirror.add(e); }
});

const strip = (d) => JSON.stringify({ ...d, entities: d.entities.map(({ id: _i, ...r }) => r) });
let mismatches = 0, firstBad = '';
let mapOk = true, idxOk = true;
const compare = (step) => {
  if (strip(doc.d) !== strip(ref.d)) { mismatches++; if (!firstBad) firstBad = `passo ${step}`; }
  const set = new Set(doc.d.entities);
  if (set.size !== mirror.size || [...set].some((e) => !mirror.has(e))) changeOk = false;
  for (let k = 0; k < 5 && doc.d.entities.length; k++) {
    const i = ri(0, doc.d.entities.length - 1), e = doc.d.entities[i];
    if (doc.byId(e.id) !== e) mapOk = false;
    if (doc.indexOfId(e.id) !== i) idxOk = false;
  }
};

const N = 4000;
let undos = 0, redos = 0, bulk = 0;
for (let step = 0; step < N; step++) {
  const r = rnd();
  if (r < 0.18) { const a = doc.undo(), b = ref.undo(); if (a !== b) mismatches++; undos++; }
  else if (r < 0.28) { const a = doc.redo(), b = ref.redo(); if (a !== b) mismatches++; redos++; }
  else if (r < 0.32) { const name = rnd() < 0.5 ? '0' : 'A'; doc.d.current = name; ref.d.current = name; } // fora do desfazer
  else {
    doc.checkpoint(); ref.checkpoint();
    const nops = ri(1, 4);
    for (let k = 0; k < nops; k++) {
      const q = rnd(), len = doc.d.entities.length;
      if (q < 0.35 || !len) {
        const e = { type: 'line', layer: rnd() < 0.5 ? '0' : 'A', a: { x: ri(0, 99), y: ri(0, 99) }, b: { x: ri(0, 99), y: ri(0, 99) } };
        doc.add(structuredClone(e)); ref.add(structuredClone(e));
      } else if (q < 0.55) {
        const ix = new Set(Array.from({ length: ri(1, 3) }, () => ri(0, len - 1)));
        doc.remove(new Set([...ix].map((i) => doc.d.entities[i].id)));
        ref.remove(new Set([...ix].map((i) => ref.d.entities[i].id)));
      } else if (q < 0.8) {
        const i = ri(0, len - 1), dx = ri(-5, 5);
        const mv = (e) => ({ ...e, a: { x: e.a.x + dx, y: e.a.y }, b: { x: e.b.x + dx, y: e.b.y } });
        doc.replace(mv(doc.d.entities[i])); ref.replace(mv(ref.d.entities[i]));
      } else if (q < 0.88) {
        // camada alterada no lugar (cor/visível) e camada nova
        const L = rnd() < 0.5 ? '0' : 'A';
        const f = (l) => { l.visible = !l.visible; l.color = '#' + ri(0, 0xffffff).toString(16).padStart(6, '0'); };
        const c = ri(0, 0xffffff);
        doc.layer(L) && (doc.layer(L).visible = !doc.layer(L).visible, doc.layer(L).color = '#' + c.toString(16).padStart(6, '0'));
        ref.layer(L) && (ref.layer(L).visible = !ref.layer(L).visible, ref.layer(L).color = '#' + c.toString(16).padStart(6, '0'));
        void f;
      } else if (q < 0.94) {
        // troca do vetor por fora (como renomear camada fazia)
        bulk++;
        const to = rnd() < 0.5 ? '0' : 'A';
        doc.d.entities = doc.d.entities.map((e, i) => (i % 3 === 0 ? { ...e, layer: to } : e));
        ref.d.entities = ref.d.entities.map((e, i) => (i % 3 === 0 ? { ...e, layer: to } : e));
      } else {
        // apagar por filtro (como apagar camada fazia)
        bulk++;
        doc.d.entities = doc.d.entities.filter((e, i) => i % 7 !== 3);
        ref.d.entities = ref.d.entities.filter((e, i) => i % 7 !== 3);
      }
    }
    doc.commit(); doc.emit();
  }
  compare(step);
}
check(`${N} passos aleatórios (${undos} desfazer, ${redos} refazer, ${bulk} trocas do vetor): mesmo resultado do modelo antigo`, mismatches === 0, firstBad);
check('avisos de mudança descrevem exatamente o que entrou e saiu', changeOk);
check('byId sempre aponta para a entidade atual', mapOk);
check('indexOfId sempre devolve a posição atual', idxOk);

// orderOf: comparar os números dá a mesma ordem do vetor (usada no redesenho por região)
{
  const d = new Doc(structuredClone(base()));
  let ok = true;
  for (let step = 0; step < 3000; step++) {
    const r = rnd();
    if (r < 0.2) d.undo();
    else if (r < 0.3) d.redo();
    else {
      d.checkpoint();
      const len = d.d.entities.length, q = rnd();
      if (q < 0.4 || !len) d.add({ type: 'point', layer: '0', p: { x: step, y: 0 } });
      else if (q < 0.7) d.remove(new Set([d.d.entities[ri(0, len - 1)].id]));
      else { const e = d.d.entities[ri(0, len - 1)]; d.replace({ ...e, layer: e.layer === '0' ? 'A' : '0' }); }
      d.commit(); d.emit();
    }
    if (step % 7 === 0) {
      const arr = d.d.entities;
      for (let i = 1; i < arr.length; i++) if (d.orderOf(arr[i - 1]) >= d.orderOf(arr[i])) { ok = false; break; }
    }
  }
  check('orderOf segue a ordem do desenho depois de criar, apagar, alterar, desfazer e refazer', ok);
}

// cenário da revisão: desenhar, desfazer, consultar a ordem, refazer — a ordem continua certa
{
  const d = new Doc();
  d.load(structuredClone(base()));
  d.checkpoint(); const x = d.add({ type: 'line', layer: '0', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }); d.commit(); d.emit();
  d.undo();
  for (const e of d.d.entities) d.orderOf(e);
  d.redo();
  const arr = d.d.entities;
  check('ordem certa depois de desenhar, desfazer e refazer', arr[arr.length - 1] === x && d.orderOf(arr[0]) < d.orderOf(x));
}

// ids repetidos num arquivo carregado viram únicos (uma edição não atinge o objeto errado)
{
  const d = new Doc();
  const dr = structuredClone(base());
  dr.entities[3].id = dr.entities[2].id; dr.entities[5].id = '';
  d.load(dr);
  const ids = d.d.entities.map((e) => e.id);
  check('ids repetidos ou vazios ao carregar viram únicos', new Set(ids).size === ids.length && ids.every(Boolean));
}

// desfazer em sequência longa até o começo e refazer tudo
{
  const d = new Doc(structuredClone(base()));
  const start = JSON.stringify(d.d);
  const states = [start];
  for (let k = 0; k < 150; k++) {
    d.checkpoint();
    if (k % 3 === 0) d.add({ type: 'point', layer: '0', p: { x: k, y: k } });
    else if (k % 3 === 1) d.remove(new Set([d.d.entities[k % d.d.entities.length].id]));
    else d.replace({ ...d.d.entities[0], a: { x: k, y: k } });
    d.commit(); d.emit();
    states.push(JSON.stringify(d.d));
  }
  let ok = true;
  for (let k = 150; k > 0; k--) { d.undo(); if (JSON.stringify(d.d) !== states[k - 1]) ok = false; }
  check('desfazer 150 vezes volta por todos os estados até o original', ok && JSON.stringify(d.d) === start);
  ok = true;
  for (let k = 1; k <= 150; k++) { d.redo(); if (JSON.stringify(d.d) !== states[k]) ok = false; }
  check('refazer 150 vezes passa de novo por todos os estados', ok);
}

// memória: o histórico guarda só o que mudou
{
  const big = base();
  big.entities = Array.from({ length: 50000 }, (_, i) => ({ id: 'x' + i, type: 'line', layer: '0', a: { x: i, y: 0 }, b: { x: i, y: 1 } }));
  const d = new Doc(big);
  const t0 = performance.now();
  for (let k = 0; k < 100; k++) { d.checkpoint(); d.add({ type: 'point', layer: '0', p: { x: k, y: 0 } }); d.commit(); d.emit(); }
  const ms = performance.now() - t0;
  check('100 edições num desenho de 50 mil objetos: rápido (sem copiar o desenho)', ms < 300, `${ms.toFixed(0)} ms`);
  const t1 = performance.now();
  for (let k = 0; k < 50; k++) d.undo();
  check('50 desfazer num desenho de 50 mil objetos: rápido', performance.now() - t1 < 300, `${(performance.now() - t1).toFixed(0)} ms`);
}

console.log(R.join('\n'));
process.exit(R.some((l) => l.startsWith('FALHA')) ? 1 : 0);
