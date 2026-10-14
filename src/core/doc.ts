import type { Drawing, Entity, Layer, NewEntity } from './types';
import { uid } from './types';

/**
 * O que mudou desde o último aviso. O editor usa isto para atualizar só o necessário
 * (índice espacial, região da tela) em vez de refazer tudo a cada edição.
 */
export interface DocChange {
  /** entidades que passaram a existir (novas, ou a versão nova de uma alterada) */
  added: Entity[];
  /** entidades que deixaram de existir (apagadas, ou a versão antiga de uma alterada) */
  removed: Entity[];
  /** camadas, camada atual ou nome do desenho podem ter mudado */
  meta: boolean;
  /** o vetor de entidades foi trocado por inteiro: refazer índice e imagem do zero */
  reset: boolean;
}
type Listener = (c: DocChange) => void;

export const PALETTE = ['#e9f0ff', '#d4ff3a', '#ff5a36', '#8be9ff', '#ffb347', '#c792ff', '#5dffb0', '#ff7ac6'];

export function newDrawing(name = 'Sem título'): Drawing {
  return {
    name,
    layers: [
      { name: '0', color: '#e9f0ff', visible: true, locked: false },
      { name: 'Cotas', color: '#ffb347', visible: true, locked: false },
    ],
    entities: [],
    current: '0',
  };
}

/**
 * Operações registradas para desfazer/refazer. As entidades nunca são alteradas no lugar
 * (toda alteração cria um objeto novo), então guardar referências basta — sem copiar o
 * desenho inteiro a cada edição, o que travava e enchia a memória em arquivos grandes.
 */
type Op =
  | { k: 'add'; e: Entity }
  /** posições no vetor ANTES de apagar, em ordem crescente */
  | { k: 'del'; items: [number, Entity][] }
  | { k: 'rep'; i: number; before: Entity; after: Entity }
  /** o vetor foi trocado por fora das funções abaixo */
  | { k: 'all'; before: Entity[]; after: Entity[] };
/** uma alteração: operações + nome/camadas antes (meta0) e depois (meta1) */
interface Step { ops: Op[]; meta0: string; meta1: string }

const MAX_STEPS = 200;

/** Documento com histórico (desfazer/refazer por operações). */
export class Doc {
  d: Drawing;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  /** alteração aberta por checkpoint() e ainda não fechada */
  private tx: Step | null = null;
  /** vetor de entidades que as operações registradas conhecem */
  private txArr: Entity[] | null = null;
  private listeners: Listener[] = [];
  private added: Entity[] = [];
  private removed: Entity[] = [];
  private metaChanged = false;
  private resetPending = false;
  dirty = false;
  /** sobe a cada aviso de mudança */
  version = 0;

  constructor(d: Drawing = newDrawing()) { this.d = d; this.prepare(); }

  /**
   * Desenho recém-carregado: ids únicos (arquivo .plv ou rascunho com ids repetidos faria
   * uma edição atingir o objeto errado) e um número de ordem para cada entidade (orderOf).
   */
  private prepare() {
    const seen = new Set<string>();
    for (const e of this.d.entities) {
      if (!e.id || seen.has(e.id)) e.id = uid();
      seen.add(e.id);
    }
    this.numberAll();
  }
  private numberAll() { for (const x of this.d.entities) this.order.set(x, this.orderNext++); }

  on(fn: Listener) { this.listeners.push(fn); }

  /** avisa os ouvintes do que mudou desde o último aviso */
  emit() {
    this.layerMap = null;
    this.version++;
    const c = this.takeChange();
    if (this.historyApplied) {
      // desfazer/refazer: mapa id → entidade atualizado só no que mudou (mudança líquida)
      this.historyApplied = false;
      if (this.idMap && !c.reset) {
        for (const e of c.removed) if (this.idMap.get(e.id) === e) this.idMap.delete(e.id);
        for (const e of c.added) this.idMap.set(e.id, e);
      } else this.idMap = null;
    }
    for (const l of this.listeners) l(c);
  }
  private historyApplied = false;

  /** mudança líquida: o que foi criado e apagado na mesma leva não aparece */
  private takeChange(): DocChange {
    const added = this.added, removed = this.removed;
    this.added = []; this.removed = [];
    const c: DocChange = { added, removed, meta: this.metaChanged, reset: this.resetPending };
    this.metaChanged = false; this.resetPending = false;
    if (added.length && removed.length) {
      const n = new Map<Entity, number>();
      for (const e of added) n.set(e, (n.get(e) ?? 0) + 1);
      for (const e of removed) n.set(e, (n.get(e) ?? 0) - 1);
      c.added = []; c.removed = [];
      for (const [e, k] of n) { if (k > 0) c.added.push(e); else if (k < 0) c.removed.push(e); }
    }
    return c;
  }

  private metaJSON() { return JSON.stringify({ name: this.d.name, current: this.d.current, layers: this.d.layers }); }
  private setMeta(json: string) {
    if (json === this.metaJSON()) return;
    const m = JSON.parse(json) as Pick<Drawing, 'name' | 'current' | 'layers'>;
    this.d.name = m.name; this.d.current = m.current; this.d.layers = m.layers;
    this.layerMap = null;
    this.metaChanged = true;
  }

  /** abre uma alteração (ponto de desfazer) antes de mudar o desenho */
  checkpoint() {
    this.commit();
    this.tx = { ops: [], meta0: this.metaJSON(), meta1: '' };
    this.txArr = this.d.entities;
    this.redoStack = [];
    this.dirty = true;
  }

  /** fecha a alteração aberta por checkpoint() */
  commit() {
    const tx = this.tx;
    if (!tx) return;
    this.syncArr();
    tx.meta1 = this.metaJSON();
    if (tx.meta1 !== tx.meta0) this.metaChanged = true;
    this.tx = null; this.txArr = null;
    this.undoStack.push(tx);
    if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
  }

  /** o vetor de entidades foi trocado por fora (ex.: doc.d.entities = …): registra a troca */
  private syncArr() {
    if (!this.tx || this.d.entities === this.txArr) return;
    this.tx.ops.push({ k: 'all', before: this.txArr!, after: this.d.entities });
    this.txArr = this.d.entities;
    this.resetPending = true;
    this.renumber = true;
    this.idMap = null; this.indexOf = null;
  }

  undo() {
    this.commit();
    const st = this.undoStack.pop();
    if (!st) return false;
    st.meta1 = this.metaJSON(); // o refazer volta exatamente ao estado de agora
    let arr = this.d.entities;
    for (let k = st.ops.length - 1; k >= 0; k--) arr = this.unapply(arr, st.ops[k]);
    this.d.entities = arr;
    this.setMeta(st.meta0);
    this.redoStack.push(st);
    this.afterHistory();
    return true;
  }

  redo() {
    this.commit();
    const st = this.redoStack.pop();
    if (!st) return false;
    st.meta0 = this.metaJSON();
    let arr = this.d.entities;
    for (const op of st.ops) arr = this.reapply(arr, op);
    this.d.entities = arr;
    this.setMeta(st.meta1);
    this.undoStack.push(st);
    this.afterHistory();
    return true;
  }

  private afterHistory() {
    this.indexOf = null;
    if (this.renumber) { this.renumber = false; this.numberAll(); }
    this.historyApplied = true;
    this.emit();
  }

  private unapply(arr: Entity[], op: Op): Entity[] {
    switch (op.k) {
      case 'add': {
        if (arr[arr.length - 1] === op.e) arr.pop();
        else { const i = arr.indexOf(op.e); if (i >= 0) arr.splice(i, 1); }
        this.removed.push(op.e);
        return arr;
      }
      case 'del': {
        // devolve cada entidade à posição em que estava
        const out: Entity[] = new Array(arr.length + op.items.length);
        let a = 0, j = 0;
        for (let i = 0; i < out.length; i++) {
          if (j < op.items.length && op.items[j][0] === i) out[i] = op.items[j++][1];
          else out[i] = arr[a++];
        }
        for (const [, e] of op.items) this.added.push(e);
        return out;
      }
      case 'rep': {
        const i = arr[op.i] === op.after ? op.i : arr.indexOf(op.after);
        if (i >= 0) arr[i] = op.before;
        this.removed.push(op.after); this.added.push(op.before);
        return arr;
      }
      case 'all':
        this.resetPending = true;
        this.renumber = true;
        return op.before;
    }
  }

  private reapply(arr: Entity[], op: Op): Entity[] {
    switch (op.k) {
      case 'add':
        arr.push(op.e);
        this.added.push(op.e);
        return arr;
      case 'del': {
        const gone = new Set(op.items.map((x) => x[1]));
        for (const [, e] of op.items) this.removed.push(e);
        return arr.filter((e) => !gone.has(e));
      }
      case 'rep': {
        const i = arr[op.i] === op.before ? op.i : arr.indexOf(op.before);
        if (i >= 0) arr[i] = op.after;
        this.removed.push(op.before); this.added.push(op.after);
        return arr;
      }
      case 'all':
        this.resetPending = true;
        this.renumber = true;
        return op.after;
    }
  }

  load(d: Drawing) {
    this.d = d; this.undoStack = []; this.redoStack = []; this.tx = null; this.txArr = null; this.dirty = false;
    this.prepare();
    if (!d.layers.find((l) => l.name === d.current)) d.current = d.layers[0]?.name ?? '0';
    if (!d.layers.length) d.layers.push({ name: '0', color: '#e9f0ff', visible: true, locked: false });
    this.idMap = null; this.indexOf = null;
    this.added = []; this.removed = [];
    this.resetPending = true; this.metaChanged = true;
    this.emit();
  }

  /** cache nome → camada (desenhos grandes consultam isto milhares de vezes por quadro) */
  private layerMap: Map<string, Layer | null> | null = null;
  layer(name: string): Layer | undefined {
    if (!this.layerMap) this.layerMap = new Map(this.d.layers.map((l) => [l.name, l]));
    let l = this.layerMap.get(name);
    // camada inexistente também fica guardada (objetos órfãos não refazem a busca a cada quadro)
    if (l === undefined) { l = this.d.layers.find((x) => x.name === name) ?? null; this.layerMap.set(name, l); }
    return l ?? undefined;
  }
  ensureLayer(name: string, color = PALETTE[this.d.layers.length % PALETTE.length]) {
    let l = this.layer(name);
    if (!l) { l = { name, color, visible: true, locked: false }; this.d.layers.push(l); this.layerMap = null; }
    return l;
  }
  colorOf(e: Entity) { return e.color ?? this.layer(e.layer)?.color ?? '#e9f0ff'; }
  isEditable(e: Entity) { const l = this.layer(e.layer); return !l || (l.visible && !l.locked); }
  isVisible(e: Entity) { return this.layer(e.layer)?.visible !== false; }

  add(e: NewEntity): Entity {
    const ent = { ...e, id: uid() } as Entity;
    this.syncArr();
    const arr = this.d.entities;
    this.indexOf?.set(ent.id, arr.length);
    arr.push(ent);
    this.order.set(ent, this.orderNext++);
    this.idMap?.set(ent.id, ent);
    this.tx?.ops.push({ k: 'add', e: ent });
    this.added.push(ent);
    return ent;
  }

  /**
   * Posição relativa no desenho, sem precisar de um mapa id → posição refeito a cada
   * remoção: cada entidade guarda um número crescente (a versão nova de uma alterada herda o
   * da antiga). Comparar dois números dá a mesma ordem do vetor.
   */
  private order = new WeakMap<Entity, number>();
  private orderNext = 0;
  /** o vetor foi trocado por inteiro: numerar de novo, na ordem dele */
  private renumber = false;
  orderOf(e: Entity): number {
    if (this.renumber) { this.renumber = false; this.numberAll(); }
    let k = this.order.get(e);
    if (k === undefined) {
      // entidade sem número (posta no vetor por fora): numera tudo na ordem atual
      this.numberAll();
      k = this.order.get(e) ?? this.orderNext++;
    }
    return k;
  }

  private idMap: Map<string, Entity> | null = null;
  byId(id: string) {
    if (!this.idMap) this.idMap = new Map(this.d.entities.map((e) => [e.id, e]));
    return this.idMap.get(id);
  }

  /** id → posição no vetor (refeito sob demanda) */
  private indexOf: Map<string, number> | null = null;
  indexOfId(id: string): number {
    const arr = this.d.entities;
    let i = this.indexOf?.get(id);
    if (i !== undefined && arr[i]?.id === id) return i;
    this.indexOf = new Map();
    for (let k = 0; k < arr.length; k++) this.indexOf.set(arr[k].id, k);
    i = this.indexOf.get(id);
    return i === undefined ? -1 : i;
  }

  remove(ids: Set<string>) {
    this.syncArr();
    const arr = this.d.entities;
    const keep: Entity[] = [], items: [number, Entity][] = [];
    for (let i = 0; i < arr.length; i++) { const e = arr[i]; if (ids.has(e.id)) items.push([i, e]); else keep.push(e); }
    if (!items.length) return;
    this.d.entities = keep;
    if (this.tx) { this.txArr = keep; this.tx.ops.push({ k: 'del', items }); }
    for (const [, e] of items) { if (this.idMap?.get(e.id) === e) this.idMap.delete(e.id); this.removed.push(e); }
    this.indexOf = null;
  }

  replace(e: Entity) {
    this.syncArr();
    const i = this.indexOfId(e.id);
    if (i < 0) return;
    const arr = this.d.entities;
    const before = arr[i];
    if (before === e) return;
    arr[i] = e;
    const k = this.order.get(before);
    if (k !== undefined) this.order.set(e, k);
    this.idMap?.set(e.id, e);
    this.tx?.ops.push({ k: 'rep', i, before, after: e });
    this.removed.push(before); this.added.push(e);
  }
}
